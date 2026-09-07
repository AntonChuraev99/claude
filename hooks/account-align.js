#!/usr/bin/env node
// Выравнивание аккаунта внешних CLI по реестру проектов.
//
// Задача: `gcloud` и `firebase` держат активный аккаунт в ГЛОБАЛЬНОМ конфиге
// инструмента, а не в репозитории. Поэтому команда, запущенная из проекта A,
// уходит под аккаунтом, который остался от проекта B. Раньше это ловил
// credentials-guard и останавливал работу вопросом к пользователю — то есть
// человек переключал аккаунт руками на каждой второй сессии.
//
// Здесь состояние не переключается вовсе. Вместо этого в саму команду
// подставляется явный аккаунт из реестра — обоим CLI глобальными флагами:
//   gcloud   -> --account=... --project=...
//   firebase -> --account=...
// Флаги перебивают глобальный конфиг, ничего в нём не меняя (проверено на
// Cloud SDK 560.0.0 и firebase-tools 15.12.0).
//
// Флаги, а не переменные окружения (`CLOUDSDK_CORE_ACCOUNT=... gcloud ...`),
// хотя те тоже работают: префикс переменных пришлось бы писать по-разному для
// bash и PowerShell, а в PowerShell присваивание отделяется `;`, что РАЗРЫВАЕТ
// цепочку — `cd X && $env:A='v'; gcloud deploy` выполнил бы деплой даже после
// провала `cd`, из чужого каталога и без аккаунта. Флаг одинаков в обоих
// шеллах и живёт внутри своей команды, ничего вокруг не ломая.
//
// Почему не иначе:
//  * `gcloud config configurations activate` и `firebase login:use` мутируют
//    общий для всех сессий конфиг — параллельная сессия в другом проекте
//    получила бы чужой аккаунт;
//  * `firebase login:use` привязывает аккаунт к АБСОЛЮТНОМУ пути каталога, а
//    git worktree меняет путь на каждую задачу — привязка теряется, и CLI
//    молча откатывается на глобальный дефолт. Это и была основная причина
//    ручных переключений;
//  * прямая запись `activeAccounts` в configstore firebase-tools — внутреннее
//    состояние CLI, не публичный контракт.
//
// Модуль ничего не решает про права: он только делает намерение явным. Проверку
// «тот ли это аккаунт» по-прежнему выполняет credentials-guard, и именно явное
// значение из команды он теперь и сверяет.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY = path.join(os.homedir(), '.claude', 'config', 'project-credentials.local.md');

// Секции реестра ниже основной таблицы описывают не репозитории, а аккаунты и
// чужие проекты. Их строки имеют другой смысл колонок, и подставлять из них
// аккаунт нельзя.
const STOP_SECTION = /^##\s/;

// --- разбор реестра -------------------------------------------------------

// Строка основной таблицы: repo_path | account | gcp_project | cf | firebase | play | remote
function parseRegistry(text) {
    const rows = [];
    let stopped = false;

    for (const line of text.split(/\r?\n/)) {
        if (STOP_SECTION.test(line)) {
            // Первая же секция закрывает основную таблицу: она идёт первой в файле.
            stopped = true;
            continue;
        }
        if (stopped) continue;
        if (!line.trim().startsWith('|')) continue;

        const cells = line.split('|').map((c) => c.trim());
        // split по '|' даёт пустые крайние элементы — рабочие ячейки с 1-й.
        const repoPath = (cells[1] || '').replace(/`/g, '');
        if (!repoPath) continue;
        if (/^-+$/.test(repoPath)) continue;            // разделитель заголовка
        if (/^(repo_path|путь)$/i.test(repoPath)) continue; // сам заголовок

        const account = cells[2] || '';
        if (!account.includes('@')) continue; // без почты строка бесполезна

        rows.push({
            repoPath,
            // В реестре рядом с почтой может стоять уточнение вида
            // "mail@example.com (GitHub Nickname)" — в команду должна уйти
            // только сама почта, иначе CLI получит мусор в значении флага.
            account: (account.match(/[^\s(]+@[^\s)]+/) || [account])[0],
            gcpProject: cells[3] || '',
            firebaseProject: cells[5] || '',
        });
    }
    return rows;
}

function loadRegistry(file) {
    try {
        return parseRegistry(fs.readFileSync(file || REGISTRY, 'utf8'));
    } catch (e) {
        return []; // нет реестра — выравнивать не по чему, работаем как раньше
    }
}

// --- сопоставление каталога со строкой реестра ----------------------------

function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Совпадение только по ГРАНИЦЕ СЕГМЕНТА: иначе `.../AlphaApp` матчил бы
// `.../AlphaAppOld` и подставил бы туда чужой аккаунт. Из нескольких
// подходящих строк берётся самая длинная — вложенный репозиторий побеждает
// родительский каталог.
function matchRow(rows, dir) {
    const target = normalizePath(dir);
    if (!target) return null;

    let best = null;
    for (const row of rows) {
        const base = normalizePath(row.repoPath);
        if (!base) continue;
        if (target !== base && !target.startsWith(base + '/')) continue;
        if (!best || base.length > normalizePath(best.repoPath).length) best = row;
    }
    return best;
}

// --- каталог, в котором реально выполнится команда ------------------------

// `cd /other/project && firebase deploy` выполняется НЕ в cwd сессии. Берём
// последнюю cd в цепочке — тот же приём, что и в credentials-guard.ps1, иначе
// аккаунт подставился бы от каталога, к которому команда не относится.
function effectiveDir(command, cwd) {
    const re = /(?:^|[;&|]|&&|\|\|)\s*cd\s+(?:\/d\s+)?("([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
    let dir = cwd;
    let m;
    while ((m = re.exec(String(command || ''))) !== null) {
        const raw = m[2] || m[3] || m[4];
        if (!raw || raw === '-') continue;
        // `cd functions && firebase deploy` — обычная форма для монорепозитория.
        // Сырой относительный путь не совпал бы ни с одной строкой реестра, и
        // команда ушла бы под глобальным дефолтом, то есть под чужим аккаунтом
        // на личном проекте. Резолвим относительно каталога сессии — так же,
        // как это делает сам шелл.
        dir = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)
            ? raw
            : path.resolve(cwd || '.', raw);
    }
    return dir;
}

// --- распознавание вызовов CLI --------------------------------------------

// Инструмент считается вызванным, только если стоит В ПОЗИЦИИ КОМАНДЫ: начало
// строки, после разделителя, после подстановки или обёртки вроде `npx`. Иначе
// слово `firebase` внутри пути или grep-паттерна тоже получило бы флаг.
function commandPositionRe(tool) {
    return new RegExp(
        // 1: всё, что легально стоит перед именем команды
        '(^|[;&|(]|&&|\\|\\||\\$\\(|`|\\bnpx\\s+|\\bpnpm\\s+dlx\\s+|\\bbunx\\s+)'
        + '(\\s*)'
        + `(${tool})\\b`,
        'g',
    );
}

function mentionsTool(command, tool) {
    return commandPositionRe(tool).test(String(command || ''));
}

// Команды, которые сами управляют авторизацией. Подставлять в них аккаунт
// нельзя: `gcloud auth login` под навязанным CLOUDSDK_CORE_ACCOUNT и
// `firebase login --reauth` с чужим --account делают ровно не то, зачем их
// запустили — а запускает их пользователь, когда токен действительно умер.
const AUTH_COMMAND = /\b(?:gcloud\s+auth\s+(?:login|revoke|application-default)|firebase\s+(?:login|logout))\b/i;

// Пользователь уже указал что-то явно — его выбор приоритетнее реестра. Но
// аккаунт и проект глушатся РАЗДЕЛЬНО: `--project` говорит только о проекте, и
// глушить им ещё и аккаунт значит отправить `gcloud run deploy --project <свой>`
// под тем аккаунтом, что остался активным глобально, — то есть ровно тот деплой
// не в ту учётку, против которого всё это и сделано.
const EXPLICIT_ACCOUNT = /(^|\s)(--account[=\s]|--configuration[=\s]|CLOUDSDK_CORE_ACCOUNT=|CLOUDSDK_ACTIVE_CONFIG_NAME=)/i;
// `--configuration` задаёт и аккаунт, и проект разом — поэтому глушит оба.
const EXPLICIT_PROJECT = /(^|\s)(--project[=\s]|CLOUDSDK_CORE_PROJECT=|--configuration[=\s]|CLOUDSDK_ACTIVE_CONFIG_NAME=)/i;

// --- построение выровненной команды ---------------------------------------

function shellQuote(value) {
    const v = String(value);
    // Значения реестра — почта и id проекта; кавычки нужны только на случай
    // мусора в ячейке, и форма `'...'` одинаково читается bash и PowerShell.
    return /^[A-Za-z0-9@._:\/-]+$/.test(v) ? v : `'${v.replace(/'/g, '')}'`;
}

// Явный `--account` глушит подстановку для gcloud целиком: пользователь назвал
// учётку — значит целится в неё сознательно, и добавлять к чужой учётке свой
// проект незачем. Явный `--project` глушит только проект: учётка при этом не
// названа, и без подстановки команда ушла бы под глобально активной.
function gcloudFlags(row, hasAccount, hasProject) {
    if (hasAccount) return null;
    const parts = [];
    if (row.account) parts.push(`--account=${shellQuote(row.account)}`);
    if (row.gcpProject && !hasProject) parts.push(`--project=${shellQuote(row.gcpProject)}`);
    return parts.length ? ' ' + parts.join(' ') : null;
}

// Возвращает { command, applied: [...] } либо null, если менять нечего.
function alignCommand(command, cwd, options) {
    const opts = options || {};
    const cmd = String(command || '');
    if (!cmd.trim()) return null;
    if (AUTH_COMMAND.test(cmd)) return null;

    const rows = opts.rows || loadRegistry(opts.registry);
    if (!rows.length) return null;

    const row = matchRow(rows, effectiveDir(cmd, cwd));
    if (!row) return null;

    // Явные флаги ищутся в ИСХОДНОЙ команде, не в уже изменённой: подставив
    // `--account` в gcloud, мы иначе сами же и заглушили бы подстановку для
    // firebase в той же цепочке — она увидела бы свой собственный флаг как
    // «пользователь указал аккаунт вручную».
    const hasAccount = EXPLICIT_ACCOUNT.test(cmd);
    const hasProject = EXPLICIT_PROJECT.test(cmd);

    let out = cmd;
    const applied = [];

    if (mentionsTool(out, 'gcloud')) {
        const flags = gcloudFlags(row, hasAccount, hasProject);
        if (flags) {
            out = out.replace(commandPositionRe('gcloud'), (m, lead, gap, tool) => `${lead}${gap}${tool}${flags}`);
            applied.push('gcloud');
        }
    }

    if (mentionsTool(out, 'firebase') && !hasAccount && row.account) {
        const flag = `--account=${shellQuote(row.account)}`;
        out = out.replace(commandPositionRe('firebase'), (m, lead, gap, tool) => `${lead}${gap}${tool} ${flag}`);
        applied.push('firebase');
    }

    if (!applied.length || out === cmd) return null;
    return { command: out, applied, account: row.account, repoPath: row.repoPath };
}

module.exports = {
    alignCommand,
    // экспортируется для тестов и для guard-совместимой сверки
    parseRegistry,
    matchRow,
    effectiveDir,
    mentionsTool,
    loadRegistry,
};
