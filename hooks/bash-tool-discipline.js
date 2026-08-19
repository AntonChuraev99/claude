// Дисциплина Bash-вызовов. НЕ отдельный хук: модуль подключается внутрь
// credentials-guard-prefilter.js, который и так висит на PreToolUse(Bash).
// Отдельный хук стоил бы ещё один спавн процесса на КАЖДЫЙ вызов — ровно та
// цена, которую снимал замер спавна на этой машине (docs/solutions/, 2026-08-19).
//
// ЗАЧЕМ. Замер транскриптов за 2026-08-18 (219 прогонов субагентов):
//   * 3 908 «дешёвых» Bash-вызовов (cat/grep/ls/git) = 10.1 ч, медиана 5.5 с;
//     те же операции нативными тулами — 1 472 вызова = 1.2 ч, медиана 1.3–2.8 с;
//   * ast-index вызван 1 раз против 2 230 текстовых grep — при живом индексе
//     (1 927 файлов, 23 304 символа) и правиле в CLAUDE.md и в 13 файлах agents/;
//   * `sleep` в Bash — 85 вызовов, 1.4 ч простоя.
// Правило текстом уже было написано и всё равно не исполнялось: в bypassPermissions
// системный промпт велит обратное («читай через cat, ищи через grep»), а
// плагинная напоминалка ast-index висит на matcher "Grep" и вызовы через Bash
// не видит вовсе. Документация Claude Code про это говорит прямо: инструкции в
// промпте и CLAUDE.md не меняют того, что агенту разрешено, — рычаг только хук.
//
// ПОВЕДЕНИЕ. Максимально мягкое: единственный deny — долгий `sleep` (он ничего
// не производит, только жжёт время), и у него есть выход через CLAUDE_ALLOW_SLEEP=1.
// Всё остальное — additionalContext БЕЗ permissionDecision, не чаще раза в
// COOLDOWN_MS на тему и сессию, чтобы напоминание не превратилось в шум.
//
// НЕ ПРОВЕРЕНО ЖИВЬЁМ: доходит ли `additionalContext` до модели на событии
// PreToolUse. У соседнего хука (docs-length-guard.js) этот канал проверен для
// PostToolUse и там же записан прецедент, когда официальное поле молча ничего
// не делало на этой версии CLI. Здесь такой проверки пока нет — первый пункт
// replay 2026-08-26. Если канал молчит, подсказку придётся отдавать как deny
// с готовой командой в тексте.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Долгий сон блокируется, короткий (ретрай, дребезг устройства) — нет.
const SLEEP_DENY_THRESHOLD_S = 30;
// Одна подсказка на тему в этот интервал; состояние — по сессии.
const COOLDOWN_MS = 10 * 60 * 1000;
// Файлы состояния живут в tmp и никем не читаются после сессии.
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

const STATE_DIR = path.join(os.tmpdir(), 'claude-bash-discipline');

// Команда, целиком состоящая из безопасной обвязки, — не повод для подсказки:
// префикс `cd <path> &&` стоит почти в каждом вызове субагента.
function stripPrefix(cmd) {
    return cmd
        .replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, '')
        .trim();
}

// `sleep 300`, `sleep 5m` — в любом сегменте команды, включая многострочные:
// `\n` в разделителях, иначе `sleep` со второй строки heredoc-скрипта не виден.
function longSleepSeconds(cmd) {
    const re = /(^|[;&|\n]|\bthen\b|\bdo\b)\s*sleep\s+(\d+)(?:\.\d+)?([smh]?)\b/gi;
    let m;
    let worst = 0;
    while ((m = re.exec(cmd)) !== null) {
        const n = parseInt(m[2], 10);
        const mult = m[3] === 'h' ? 3600 : m[3] === 'm' ? 60 : 1;
        worst = Math.max(worst, n * mult);
    }
    return worst;
}

const CODE_EXT = /\.(kt|kts|java|swift|ts|tsx|js|jsx|py|rs|go|rb|cs|c|cc|cpp|h|hpp|php|scala|dart)\b/i;
const DOC_EXT = /\.(md|json|ya?ml|toml|gradle|properties|xml)\b/i;
// Каталоги, поиск по которым — законная работа для grep: там нет символов,
// которые знает индекс. Логи и отчёты сборки открываются именно так.
const NON_CODE_PATH = /\b(logs?|build|dist|out|reports?|coverage|node_modules|\.gradle|tmp)\b/i;

// Текстовый поиск по ИСХОДНИКАМ: grep/rg/ack/find. Поиск по логам, отчётам и
// произвольному тексту не трогаем — подсказка, которая срабатывает не по делу,
// перестаёт читаться, и это дороже пропущенного случая.
function isCodeSearch(cmd) {
    const isSearch = /(^|[;&|]\s*|\s)(grep|rg|ack)\b/i.test(cmd)
        || /(^|[;&|]\s*|\s)find\b[^|]*-name\b/i.test(cmd);
    if (!isSearch) return false;
    if (NON_CODE_PATH.test(cmd)) return false;
    // Явный фильтр по кодовому расширению — самый надёжный признак.
    if (CODE_EXT.test(cmd)) return true;
    // Рекурсивный обход без фильтра: считаем поиском по коду, только если в
    // команде вообще нет пути к некодовым данным (проверено выше).
    return /\b(grep|rg)\b[^|]*\s-[a-z]*r/i.test(cmd);
}

// Чтение конкретного файла: cat/head/tail/sed -n по пути. Якорь `^` здесь
// несёт смысл — он отделяет чтение файла от обрезки чужого вывода
// (`./gradlew test | head -50`), где head не читает файл и Read неприменим.
// Поэтому cd-префикс обязан быть срезан ДО этой проверки (см. stripPrefix).
function isFileRead(cmd) {
    if (!/^\s*(cat|head|tail|sed\s+-n)\b/i.test(cmd)) return false;
    // `cat > file` и `cat <<EOF` — это ЗАПИСЬ, а не чтение: Read тут не при чём,
    // а слот кулдауна был бы потрачен впустую.
    const beforePipe = cmd.split('|')[0];
    if (/[<>]/.test(beforePipe)) return false;
    return CODE_EXT.test(cmd) || DOC_EXT.test(cmd);
}

// Ключ состояния приходит из полезной нагрузки хука и попадает в имя файла:
// без нормализации `../..` увёл бы запись за пределы каталога состояния.
function stateFile(key) {
    const safe = String(key || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    return path.join(STATE_DIR, `${safe}.json`);
}

function readState(sessionId) {
    try {
        return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
    } catch (e) {
        return {};
    }
}

// Подметает чужие протухшие файлы состояния. Вызывается только при первой
// записи в сессии (state пуст), поэтому readdir не платится на каждом вызове.
function sweepStale() {
    try {
        const now = Date.now();
        for (const name of fs.readdirSync(STATE_DIR)) {
            const p = path.join(STATE_DIR, name);
            try {
                if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.unlinkSync(p);
            } catch (e) { /* файл уже унесли — не наша забота */ }
        }
    } catch (e) { /* каталога нет — подметать нечего */ }
}

function writeState(sessionId, state, firstWrite) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        if (firstWrite) sweepStale();
        fs.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    } catch (e) {
        // Подсказка — не то, ради чего стоит ронять хук.
    }
}

const HINTS = {
    search:
        'Поиск по коду — через ast-index, он для этого и стоит: '
        + '`ast-index usages <Symbol>` (кто использует), `ast-index refs <Symbol>` (определения+импорты+использования), '
        + '`ast-index symbol|class <Name>` (определение), `ast-index explore <Symbol>` (исходник+вызывающие+тесты одним вызовом). '
        + 'Индекс держит хук плагина, `rebuild`/`update` не запускай. '
        + 'Текстовый grep остаётся правильным для строковых литералов, логов и файлов вне индекса — но тогда через тул Grep, а не через Bash.',
    read:
        'Файл читай тулом Read, а не через cat/head/sed. На этой машине вызов Bash-тула стоит на порядок дороже '
        + 'нативного тула (замер 2026-08-19: 10.8 с против 1.3 с), и на сотнях вызовов это часы. '
        + 'Bash оставь тому, что без процесса не сделать: сборка, тесты, git, ast-index.',
};

// Чистая проверка на долгий sleep — без чтения и записи состояния. Отделена от
// judge намеренно: вызывающая сторона проверяет sleep раньше credentials-guard,
// и второй вызов judge впустую потратил бы слот кулдауна подсказок.
function sleepVerdict(command) {
    if (!command || typeof command !== 'string') return null;
    if (process.env.CLAUDE_ALLOW_SLEEP === '1') return null;
    const slept = longSleepSeconds(stripPrefix(command));
    if (slept <= SLEEP_DENY_THRESHOLD_S) return null;
    return {
        decision: 'deny',
        reason:
            `Команда простаивает ${slept} с в \`sleep\`. Так ждать нельзя: `
            + 'долгую команду запускай через `run_in_background` и получай уведомление о завершении, '
            + 'а на внешнее событие (CI, деплой, эмулятор) ставь Monitor с условием. '
            + 'Короткий sleep (≤30 с) разрешён; если ожидание действительно неизбежно — CLAUDE_ALLOW_SLEEP=1.',
    };
}

// Возвращает вердикт для харнесса либо null, если сказать нечего.
// `key` нужен только для дедупликации подсказок и должен различать АГЕНТОВ, а не
// сессии: субагенты фан-аута получают session_id родителя, и на ключе по сессии
// подсказку увидел бы первый агент из двенадцати, а остальные — никогда.
// Поэтому вызывающая сторона передаёт transcript_path (у каждого агента свой),
// с откатом на session_id.
function judge(command, key) {
    const denial = sleepVerdict(command);
    if (denial) return denial;

    if (!command || typeof command !== 'string') return null;
    const cmd = stripPrefix(command);
    if (!cmd) return null;

    let topic = null;
    if (isCodeSearch(cmd)) topic = 'search';
    else if (isFileRead(cmd)) topic = 'read';
    if (!topic) return null;

    const state = readState(key);
    const now = Date.now();
    if (state[topic] && now - state[topic] < COOLDOWN_MS) return null;
    const firstWrite = Object.keys(state).length === 0;
    state[topic] = now;
    writeState(key, state, firstWrite);

    return { decision: 'allow', context: HINTS[topic] };
}

module.exports = {
    judge,
    sleepVerdict,
    longSleepSeconds,
    isCodeSearch,
    isFileRead,
    stripPrefix,
    SLEEP_DENY_THRESHOLD_S,
};
