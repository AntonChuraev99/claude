#!/usr/bin/env node
// Индекс ast-index для worktree: вызовы ast-index внутри `.claude/worktrees/<slug>`
// получают `AST_INDEX_DB_PATH` — путь к индексу основного checkout'а. Модуль
// credentials-guard-prefilter.js: тот единственный висит на каждом вызове Bash и
// PowerShell и уже отдаёт `updatedInput`, отдельный хук стоил бы ещё один спавн.
//
// Задача: ast-index держит индекс вне репозитория, в `<cache>/<djb2 пути
// корня>/index.db`. У worktree другой путь — значит, свой пустой каталог кэша и
// «Index not found» на любой поиск. Сам индекс там не появляется: SessionStart-хук
// плагина при отсутствии индекса только печатает подсказку, его post-edit-хук
// проект без индекса пропускает, а CLAUDE.md запрещает агенту `rebuild`/`update`.
// Замер 2026-10-22 на Android-проекте: у основного checkout'а 2901 файл в
// индексе, у трёх его worktree — ни одного.
//
// `rebuild` в worktree не нужен: ветка стартует копией транка, и полный индекс
// повторил бы индекс основного checkout'а. Его и подставляем.
//
// Почему переменная, а не `--walk-up`. Флаг находит индекс родителя, но корнем
// проекта тогда становится основной checkout, а ast-index сужает выдачу `usages`,
// `class`, `refs` до подкаталога, из которого вызван, — то есть до
// `.claude/worktrees/<slug>`, где проиндексированных файлов нет. Замер 2026-10-22,
// ast-index 3.56.0: `usages` из worktree с `--walk-up` — 0 результатов, с
// `AST_INDEX_DB_PATH` — 12, как из основного checkout'а. С переменной корнем
// остаётся worktree, а пути в индексе относительные (`app\src\...`) и
// открываются в нём же. Чтение базу не меняет: после серии `usages`/`explore`/
// `refs` из worktree в ней те же 2901 файл и то же поколение индекса.
//
// Форма подстановки зависит от шелла:
//   * bash — префикс перед каждым вызовом: `AST_INDEX_DB_PATH='…' ast-index …`.
//     Переменная живёт только в этом звене и цепочку не рвёт;
//   * PowerShell — инлайн-префикса нет, поэтому одна строка в начале всей
//     команды: `$env:AST_INDEX_DB_PATH='…'; <команда>`. Переменная действует до
//     конца вызова, поэтому команда, где ГДЕ УГОДНО стоит слово записи в индекс,
//     не меняется вовсе: `update` с чужим путём переписал бы индекс основного
//     checkout'а файлами worktree. Слово ищется по всему тексту, а не по позиции
//     команды: `$x = ast-index update` позицией команды не распознаётся.
//
// Известный пробел — символы, которые ветка добавила или переименовала: их в
// индексе основного checkout'а нет, CLAUDE.md велит искать их тулом Grep. И если
// основной checkout стоит на другой ветке, индекс отражает её код.
//
// Команда не меняется, если:
//   * каталог исполнения — не worktree харнесса;
//   * у worktree есть свой непустой индекс (его кто-то построил, он свежее) или
//     у основного checkout'а индекса нет;
//   * команда уже говорит `AST_INDEX_DB_PATH`, `AST_INDEX_WALK_UP` или `--walk-up`;
//   * вызов управляет индексом или пишет в него: `rebuild`, `update`, `clear`,
//     `watch`, `restore`, `subtree`, `graph build`, `--refresh`, `--collect`;
//   * `ast-index` стоит в тексте — сообщении коммита, строке, heredoc: позицию
//     команды ищем по маске account-align, как и подстановку аккаунта. Вызов,
//     который маска не распознала (`FOO=1 ast-index`, `$x = ast-index` в bash),
//     остаётся без подстановки и отвечает как раньше.

const fs = require('fs');

const { maskText, effectiveDir, commandPositionRe } = require('./account-align.js');
const { astIndexDb } = require('./bash-tool-discipline.js');

// Основной checkout и корень worktree — по первому `.claude/worktrees/<slug>` в
// пути. Ленивый квантификатор нужен для самого ~/.claude: там путь
// `~/.claude/.claude/worktrees/x`.
const WORKTREE = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?=[\\/]|$)/;

const EXPLICIT = /AST_INDEX_DB_PATH|AST_INDEX_WALK_UP|(?:^|\s)--walk-up(?:\s|$)/;

// Подкоманды, которые индекс не читают: управляют им, пишут в него или служебные
// (SKILL.md плагина 3.56.0: `restore` подменяет базу, `subtree add|remove`
// меняет состав индекса). Остальные (search, usages, refs, explore, stats,
// changed…) читают индекс.
const NOT_READ = new Set([
    'rebuild', 'update', 'clear', 'watch', 'watch-status', 'restore', 'subtree',
    'add-root', 'remove-root', 'install-claude-plugin', 'install-codex-mcp', 'version', 'help',
]);

// Запись внутри читающей подкоманды: `--refresh` у запросов графа, `hotspots
// --collect`. С базой основного checkout'а она записала бы туда состояние worktree.
const WRITE_FLAG = /(?:^|\s)--(?:refresh|collect)(?=\s|$)/;

// Слова записи для PowerShell — по всему тексту (см. шапку). Строчными, без
// флага `i`: командлеты PowerShell пишутся с заглавной (`Update-Help`). Лишнее
// совпадение (`git update-index`) только снимает подстановку — это безопасная сторона.
const WRITE_WORD = /\b(?:rebuild|update|clear|watch|restore|subtree|add-root|remove-root)\b|\bgraph\s+build\b|--refresh\b|--collect\b/;

// Перевод строки, фигурные скобки и ключевые слова bash начинают новую команду,
// а шаблон позиции команды из account-align их не знает. Замена той же длины —
// позиции в маске совпадают с исходной строкой.
const KEYWORD = /(^|[;\s])(then|do|else|elif|if|while|until|time)(?=\s)/g;
function commandBoundaries(masked) {
    return masked
        .replace(/[\r\n{}]/g, ';')
        .replace(KEYWORD, (all, pre, kw) => pre + ';' + ' '.repeat(kw.length - 1));
}

// Глобальные опции со значением: значение — не подкоманда.
const OPTION_WITH_VALUE = new Set(['--format', '--subtree']);

// Обёртки из шаблона позиции команды: `npx VAR=… ast-index` — не то же самое.
const WRAPPER = /^(?:npx|pnpm|bunx)\b/;

// Git Bash пишет `/c/Users/...` — Node на Windows такой путь не находит.
function nativePath(p) {
    const s = String(p || '');
    return process.platform === 'win32' ? s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : s;
}

function realOrNull(p) {
    try {
        return fs.realpathSync.native(p);
    } catch (e) {
        return null;
    }
}

// Путь к индексу основного checkout'а для каталога внутри worktree либо null.
function mainIndexFor(dir) {
    const m = WORKTREE.exec(nativePath(dir));
    if (!m || !m[1]) return null;
    const wt = realOrNull(m[0]);
    if (wt && astIndexDb(wt)) return null; // у worktree свой индекс
    const main = realOrNull(m[1]);
    return main ? astIndexDb(main) : null;
}

// Только ли читает индекс вызов, чьи аргументы начинаются с `from`. Нет
// подкоманды (`ast-index --help`) — не читает.
function readsIndex(masked, from) {
    const segment = masked.slice(from).split(/[;&|)]/)[0];
    if (WRITE_FLAG.test(segment)) return false;
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (OPTION_WITH_VALUE.has(t)) { k++; continue; }
        if (t.startsWith('-')) continue;
        const sub = t.toLowerCase();
        if (NOT_READ.has(sub)) return false;
        const next = tokens.slice(k + 1).find((x) => !x.startsWith('-'));
        return !(sub === 'graph' && next === 'build');
    }
    return false;
}

// Вызовы ast-index в позиции команды: { at, reads }. `at` — индекс первого
// символа имени инструмента, `reads` — вызов только читает индекс.
function invocations(masked) {
    const re = commandPositionRe('ast-index(?:\\.exe)?');
    const found = [];
    let m;
    while ((m = re.exec(masked)) !== null) {
        const end = m.index + m[0].length;
        // `\b` в конце шаблона пропустил бы `ast-index-foo` и `ast-index/x`.
        if (end < masked.length && !/\s/.test(masked[end])) continue;
        if (WRAPPER.test(m[1].trim())) continue;
        found.push({ at: m.index + m[1].length + m[2].length, reads: readsIndex(masked, end) });
    }
    return found;
}

// Возвращает { command } с подставленным индексом либо null, если менять нечего.
function worktreeIndexCommand(command, cwd, options) {
    const cmd = String(command || '');
    if (!/ast-index/i.test(cmd) || EXPLICIT.test(cmd)) return null;

    const shell = String((options && options.shell) || '').toLowerCase() === 'powershell' ? 'powershell' : 'bash';
    const masked = commandBoundaries(maskText(cmd, shell));
    if (shell === 'powershell' && WRITE_WORD.test(masked)) return null;
    const calls = invocations(masked);
    if (!calls.some((c) => c.reads)) return null;

    const db = mainIndexFor(effectiveDir(cmd, cwd));
    // Кавычка в пути (профиль `O'Neil`) закрыла бы '…' раньше времени, и команда
    // упала бы синтаксисом. Без подстановки она ответит как раньше.
    if (!db || db.includes("'")) return null;
    // Прямые слэши: `\` в bash внутри '…' безопасен, но путь с ними хуже читается
    // в логе команды, а ast-index на Windows принимает оба разделителя.
    const value = `'${db.replace(/\\/g, '/')}'`;

    if (shell === 'powershell') {
        if (calls.some((c) => !c.reads)) return null;
        return { command: `$env:AST_INDEX_DB_PATH=${value}; ${cmd}` };
    }

    // bash: префикс получает только читающий вызов — пишущий или нераспознанный
    // остаётся без переменной, поэтому до чужой базы не дотягивается.

    let out = '';
    let last = 0;
    for (const c of calls) {
        if (!c.reads) continue;
        out += cmd.slice(last, c.at) + `AST_INDEX_DB_PATH=${value} `;
        last = c.at;
    }
    return { command: out + cmd.slice(last) };
}

module.exports = { worktreeIndexCommand };
