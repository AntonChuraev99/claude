#!/usr/bin/env node
// docs-facts-guard.js — PostToolUse(Write|Edit|MultiEdit) hook + CLI для /task-gate.
//
// Проверяет ФАКТЫ документа, а не его объём (объём — сосед docs-length-guard.js):
// каждый идентификатор, путь, ссылка и число-замер в документе обязаны иметь источник
// в репозитории. Правило «копируй из файла, не по памяти» стояло в теле агента-писателя
// с 2026-07-16 и не удержалось: с 2026-08-19 по 2026-09-15 в журнале задач 19 документов
// с выдуманными сигнатурами, путями, механизмами и замерами — их переписывал главный.
// Документ никто не компилирует, поэтому выдуманное имя в нём ловится только так —
// детерминированной сверкой с кодом, не ещё одним текстовым правилом.
//
// Классы претензий:
//   IDENT  — идентификатор (camelCase, snake_case, PascalCase в бэктиках, `foo()`), которого
//            нет ни в файлах репозитория, ни в диффе (удалённое в этой задаче — тоже факт);
//   PATH   — путь к файлу или каталогу, которого нет ни в репозитории, ни на диске;
//   LINK   — относительная markdown-ссылка, которая не резолвится от документа;
//   NUMBER — число с единицей измерения (мс, %, слов, turns…) без пометки источника.
// IDENT и NUMBER — предупреждение (внешние CLI-флаги и внешние репозитории дают ложные
// срабатывания, их закрывает маркер), PATH и LINK — точные классы, в /task-gate блокер.
//
// Маркеры, снимающие проверку строки для IDENT / PATH / NUMBER: `TODO: сверить`,
// `(не проверено — <почему>)`, `(приблизительно)`, `источник: <…>` в той же строке.
// LINK маркер НЕ закрывает: относительная ссылка внутри docs/ либо резолвится, либо
// правится. Строка с маркером не проверяется целиком — пропуск виден и чинится, выдумка — нет.
//
// Хук НЕ блокирует и НЕ откатывает запись (PostToolUse отрабатывает после неё) — он
// возвращает список через hookSpecificOutput.additionalContext. Область хука —
// docs/{solutions,decisions,archive}/**.md без INDEX*: docs/active/ исключён намеренно,
// там технический план называет классы, которых ещё нет. Архив проверяется и в CLI
// (mv из active/ хук не видит). ЛЕГАСИ НЕ ТРОГАЕМ: при Write сравниваем с версией из
// HEAD и репортим только новые претензии; при Edit — только претензии из new_string.
//
// CLI:  node docs-facts-guard.js <doc.md> [...] [--base <sha>] [--all] [--json]
//       exit 0 — претензий нет; exit 1 — есть (список в stdout). --base добавляет
//       к источникам `git diff <sha>` (удалённые за задачу имена остаются фактом) и
//       делает легаси версию документа на <sha> невидимой — задача отвечает только за
//       претензии, которых в той версии не было; --all снимает фильтр для полного аудита.
//
// Источники сверки: `git grep -F -w` по tracked + untracked файлам вне docs/ и *.md
// (документы друг друга не подтверждают — фабрикацию копируют), `git ls-files` для
// путей плюс существование на диске (gitignored-файлы тоже факт), `git diff`.
//
// ПОЧЕМУ NODE: matcher безусловный (Write|Edit — каждая правка), холодный старт
// платится всегда; замер 2026-08-06 у соседа: pwsh ~644 мс против node ~44–70 мс.
// Fail-open: любая ошибка до вердикта или непригодный git => тихий выход без вывода.
//
// ВАЖНО: файл публикуется в открытый репозиторий — никаких абсолютных путей,
// имён проектов и логинов в коде.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STDIN_TIMEOUT_MS = 2000;
const GIT_TIMEOUT_MS = 8000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Маркер допускает причину в скобках: «(не проверено — Gemini API)», «(приблизительно, по логу)».
// Граница слова здесь не `\b`: в JS он ASCII-only и после кириллицы не срабатывает.
const SKIP_LINE = /TODO:\s*сверить|\(не проверено(?![\p{L}\p{N}])[^)]*\)|\(приблизительно(?![\p{L}\p{N}])[^)]*\)|\(approx/iu;
// Маркер docs-length-guard — не замер, а заявление объёма; число в нём проверяет сосед.
const VOLUME_MARKER = /^\s*>\s*Объ[её]м\s*:/;
// Строка с названным источником («82.2% (источник: Amplitude, chart X)», «поле `maxTurns`
// (источник: docs/en/sub-agents)») — факт со ссылкой, а не догадка; сверять его с
// репозиторием нечем. Снимает IDENT / PATH / NUMBER, но не LINK: битая ссылка остаётся битой.
const SOURCED_LINE = /источник\s*:|source\s*:/i;

// Слова языков и разметки, которые проходят тест на идентификатор, но фактом не являются.
// Список короткий намеренно: каждый пункт — известный ложный срабатыватель.
const STOP = new Set([
    'true', 'false', 'null', 'undefined', 'this', 'super', 'return', 'import', 'export', 'package',
    'private', 'public', 'internal', 'protected', 'override', 'suspend', 'sealed', 'enum', 'const',
    'lateinit', 'companion', 'object', 'class', 'interface', 'data', 'when', 'else', 'while',
    'function', 'async', 'await', 'default', 'require', 'module', 'string', 'number', 'boolean',
    'readme', 'index', 'todo', 'fixme', 'main', 'master', 'develop', 'origin', 'head', 'none',
    'done', 'deferred', 'planned', 'progress', 'partially', 'https', 'http', 'localhost',
    'utf8', 'utf-8', 'json', 'yaml', 'markdown', 'kotlin', 'java', 'python', 'node', 'bash',
    'gradle', 'android', 'wasm', 'wasmjs', 'commonmain', 'androidmain', 'wasmjsmain',
    'e2e', 'unit', 'test', 'tests', 'debug', 'release', 'build', 'src', 'docs', 'lib',
    // Протокольные строки харнесса — статусы агентов, не имена из кода.
    'status', 'needs_input', 'needs_delegation', 'rejected', 'blocked', 'docs_written', 'index_row', 'stats_row',
]);

const EXT = 'kt|kts|java|ts|tsx|js|jsx|mjs|cjs|py|md|json|jsonl|yaml|yml|xml|toml|css|scss|html|ps1|sh|bat|sql|proto|gradle|properties|txt|csv|svg|png|jpg|webp|pro|rules|vbs';
// Разделитель — `/` или `\` (Windows-пути в документах встречаются), сегмент может
// начинаться с точки (`.github/workflows/…`, `.claude/`).
const PATH_RE = new RegExp(`^(?:~[\\/\\\\]|\\.{1,2}[\\/\\\\])?\\.?[\\w][\\w.\\-]*(?:[\\/\\\\]\\.?[\\w.\\-]+)*(?:\\.(?:${EXT})|[\\/\\\\])$`, 'i');
// Границы — по \p{L}: с ASCII-`\w` «4 секции» читалось как «4 сек», «5 словарей» — как «5 слова».
const UNIT_RE = /(?<![\p{L}\p{N}.])[-−~≈+]?(?:\d+m\d+s|\d+h\d+m|\d+(?:[.,]\d+)?\s?(?:ms|мс|s|сек|c|%|п\.п\.|MB|GB|KB|МБ|ГБ|КБ|turns?|токен(?:ов|а)?|tokens?|слов[а]?|строк|файл(?:ов|а)?|запрос(?:ов|а)?|вызов(?:ов|а)?|итераци[йи]|×))(?![\p{L}\p{N}])/gu;

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const claimKey = (c) => `${c.cls} ${c.token}`;
// `app\src\Foo.kt`, `./docs/x.md`, `docs/active/` → `app/src/Foo.kt`, `docs/x.md`, `docs/active`.
const normRel = (token) => token.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');

function toNativePath(p) {
    if (!p || typeof p !== 'string') return '';
    let s = p.trim();
    if (process.platform !== 'win32') return s;
    const mnt = s.match(/^\/+mnt\/([a-zA-Z])\/(.*)$/);
    const drv = s.match(/^\/+([a-zA-Z])\/(.*)$/);
    if (mnt) s = `${mnt[1]}:/${mnt[2]}`;
    else if (drv) s = `${drv[1]}:/${drv[2]}`;
    return s.replace(/\//g, '\\').replace(/\\+$/, '');
}

function stripFrontmatter(raw) {
    const s = raw.replace(/^﻿/, '');
    const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (m && /^[ \t]*[\w-]+[ \t]*:/m.test(m[1])) {
        // Строки frontmatter маскируются, а не вырезаются: номера строк в вердикте
        // обязаны совпадать с файлом. keywords/modules там — поисковые термы, не факты.
        return m[0].replace(/[^\n]/g, '') + s.slice(m[0].length);
    }
    return s;
}

function normalizeToken(t) {
    return t.replace(/^[@#$!?*&]+/, '').replace(/\(\)$/, '').replace(/[?!:;,.)\]]+$/, '').replace(/^[(\[]+/, '');
}

// В прозе претензия — только форма, которую человек не пишет случайно: горб camelCase,
// snake_case из двух частей, вызов `foo()`. PascalCase в прозе — бренды и термины
// (GitHub, RevenueCat), они претензией не считаются; в бэктиках — считаются.
function looksLikeIdent(t, inCode) {
    if (t.length < 4 || t.length > 80) return false;
    if (STOP.has(t.toLowerCase())) return false;
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) return false;
    if (/\.\d|^\d/.test(t)) return false;
    const hump = /[a-z][A-Z]/.test(t);
    const snake = /[A-Za-z0-9]_[A-Za-z]/.test(t);
    const upperSnake = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t);
    const dotted = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(t) && !/\.(com|org|io|dev|net|ru|md|js|kt|ts)$/i.test(t);
    // Однословный PascalCase (`Loading`, `Solution`) — обычное английское слово в бэктиках
    // шаблона чаще, чем имя из кода; претензией считается только PascalCase с двумя горбами.
    const pascal = /^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+$/.test(t);
    if (inCode) return hump || snake || upperSnake || dotted || pascal;
    // Горб в прозе считается только у camelCase с маленькой буквы: `RevenueCat` и
    // `GitHub` — тоже горб, но это бренды, а не имена из кода.
    return (hump && /^[a-z]/.test(t)) || snake || upperSnake;
}

function looksLikePath(t) {
    if (t.length < 4 || t.length > 200) return false;
    if (/^(https?|mailto|file):/i.test(t)) return false;
    if (!/[\/\\]/.test(t) && !/\.(?:kt|kts|java|ts|tsx|js|py|json|yaml|yml|xml|toml|ps1|sh|gradle|properties)$/i.test(t)) return false;
    return PATH_RE.test(t);
}

// Возвращает [{cls, token, line}] без дедупликации по строкам: одна претензия — одна
// строка вердикта, повтор токена в другом месте документа не репортится второй раз.
function extractClaims(raw) {
    const text = stripFrontmatter(raw);
    const lines = text.split(/\r?\n/);
    const claims = [];
    const seen = new Set();
    const add = (cls, token, line) => {
        const key = claimKey({ cls, token });
        if (seen.has(key)) return;
        seen.add(key);
        claims.push({ cls, token, line });
    };
    let fence = null;
    lines.forEach((line, i) => {
        const n = i + 1;
        const open = line.match(/^\s*(?:>\s*)?(`{3,}|~{3,})/);
        if (!fence && open) {
            fence = open[1];
            return;
        }
        if (fence) {
            const close = line.match(/^\s*(?:>\s*)?(`{3,}|~{3,})\s*$/);
            if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
                fence = null;
                return;
            }
        }
        const inCode = Boolean(fence);

        // Ссылки — только в прозе и вне бэктиков: `handlers[type](evt)` в код-блоке или
        // в `…` — индексация, не markdown-ссылка. Цель с `<…>` — плейсхолдер шаблона.
        // LINK извлекается ДО маркеров: битую ссылку маркер не закрывает — только правка.
        if (!inCode) {
            const noSpans = line.replace(/`[^`]*`/g, ' ');
            for (const m of noSpans.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
                const target = m[1].replace(/#.*$/, '');
                if (!target || /^(https?|mailto|file):/i.test(target) || /^[A-Za-z]:[\\/]/.test(target) || /[<>]/.test(target)) continue;
                add('LINK', target, n);
            }
        }

        if (SKIP_LINE.test(line) || SOURCED_LINE.test(line)) return;

        // Плейсхолдеры `<slug>`, `<BASE_SHA>`, `<путь>` — не претензии: убираются до разбора.
        const noPlaceholders = line.replace(/<[^<>\n]{1,60}>/g, ' ');
        const spans = [];
        let prose = noPlaceholders;
        if (!inCode) {
            prose = noPlaceholders.replace(/`([^`]+)`/g, (_, s) => {
                spans.push(s);
                return ' ';
            });
            // URL и markdown-ссылки из прозы не разбираем на токены.
            prose = prose.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ');
        } else {
            spans.push(noPlaceholders);
        }

        for (const span of spans) {
            for (const rawTok of span.split(/[\s,;()<>{}[\]"'=|+*!«»]+/)) {
                const t = normalizeToken(rawTok);
                if (!t) continue;
                if (looksLikePath(t)) add('PATH', t, n);
                else if (looksLikeIdent(t, true)) add('IDENT', t, n);
            }
        }
        for (const rawTok of prose.split(/[\s,;()<>{}[\]"'«»=|+*!]+/)) {
            const t = normalizeToken(rawTok);
            if (!t) continue;
            if (looksLikePath(t)) add('PATH', t, n);
            else if (looksLikeIdent(t, false)) add('IDENT', t, n);
        }
        if (!inCode && !VOLUME_MARKER.test(line)) {
            for (const m of prose.matchAll(UNIT_RE)) {
                // Даты и версии — не замеры; диапазон («3-5 слов», «3–8 термов») — норма, не факт.
                if (/\d{4}-\d{2}-\d{2}/.test(m[0]) || /^\d+\.\d+\.\d+/.test(m[0])) continue;
                const before = prose.slice(Math.max(0, m.index - 6), m.index);
                if (/\d\s?[-–—]\s?$/.test(before)) continue;
                add('NUMBER', m[0].trim(), n);
            }
        }
    });
    return claims;
}

function git(args, cwd, input) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        input,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        windowsHide: true,
    });
}

function repoRoot(dir) {
    try {
        git(['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], dir);
        return git(['-C', dir, 'rev-parse', '--show-toplevel'], dir).trim();
    } catch {
        return null;
    }
}

// Одна выборка на прогон: список файлов репозитория (tracked + untracked, без
// ignored) и корпус диффа. git grep по паттернам — второй вызов. Больше git не нужен.
function buildSources(root, base) {
    const files = new Set();
    const basenames = new Set();
    const dirs = new Set();
    const ls = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
    for (const f of ls.split('\0')) {
        if (!f) continue;
        const p = f.replace(/\\/g, '/');
        files.add(p);
        basenames.add(path.posix.basename(p));
        const segs = p.split('/');
        for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    }
    let diff = '';
    try {
        diff = git(['diff', '--no-color', '--no-ext-diff', base || 'HEAD', '--', '.', ':(exclude)docs/**', ':(exclude)*.md'], root);
    } catch {
        diff = '';
    }
    return { root, files, basenames, dirs, diff };
}

// Путь в документе часто относителен модулю, а не корню (`src/Foo.kt` внутри `app/`):
// принимается точное совпадение, хвостовое (`…/src/Foo.kt`), каталог как любой сегмент
// пути, существование на диске (gitignored — тоже факт) и упоминание в диффе. Голое имя
// файла (`Foo.kt`) подтверждается по basename где угодно; путь с каталогом — нет:
// выдуманный каталог у настоящего файла — ровно та фабрикация, ради которой хук написан.
function pathKnown(src, docDir, token) {
    const rel = normRel(token);
    if (!rel) return true;
    const isDir = /[\/\\]$/.test(token);
    const pool = isDir ? src.dirs : src.files;
    if (pool.has(rel)) return true;
    const tail = '/' + rel;
    for (const p of pool) if (p.endsWith(tail)) return true;
    if (!isDir && !rel.includes('/') && src.basenames.has(rel)) return true;
    if (!isDir && rel.includes('/')) {
        // Сокращённая запись «модуль/Файл.kt» (`core/ui/DeckFlipScheduler.kt` при реальном
        // `core/ui/src/commonMain/…/DeckFlipScheduler.kt`): каталог существует и файл
        // лежит где-то под ним. Каталога нет — путь выдуман.
        const dir = path.posix.dirname(rel);
        const base = path.posix.basename(rel);
        for (const p of src.files) {
            if (p.endsWith('/' + base) && (p.startsWith(dir + '/') || p.includes('/' + dir + '/'))) return true;
        }
    }
    if (pathExists(src.root, docDir, token)) return true;
    return wordIn(src.diff, path.posix.basename(rel));
}

// Одна альтернация `-E -w -o`, а не `-F -f patterns`: замер 2026-09-15 на репозитории
// в ~19k файлов — `-F -w -o -f` с 66 паттернами не укладывался в 60 с (с четырьмя —
// 0.6 с), `-E -w -o -e '(a|b|…)'` с теми же 66 — 0.2 с. Пачками по CHUNK токенов, чтобы
// не упереться в длину командной строки Windows.
const CHUNK = 120;
function grepIdents(root, tokens) {
    const found = new Set();
    for (let i = 0; i < tokens.length; i += CHUNK) {
        const alt = '(' + tokens.slice(i, i + CHUNK).map(escapeRe).join('|') + ')';
        let out = '';
        try {
            out = git(
                ['grep', '-E', '-w', '-h', '-o', '-I', '--untracked', '-e', alt, '--', '.', ':(exclude)docs/**', ':(exclude)*.md', ':(exclude)*.jsonl', ':(exclude)*.lock'],
                root
            );
        } catch (e) {
            // git grep без совпадений возвращает 1 — это штатный «ничего не нашёл».
            out = (e && e.stdout) || '';
        }
        for (const s of out.split(/\r?\n/)) {
            const t = s.trim();
            if (t) found.add(t);
        }
    }
    return found;
}

function wordIn(haystack, token) {
    if (!haystack) return false;
    return new RegExp(`(^|[^\\w])${escapeRe(token)}(?![\\w])`).test(haystack);
}

// `~/…` — от домашнего каталога; остальное — от корня репозитория и от каталога документа.
function pathExists(root, docDir, token) {
    const t = token.replace(/\\/g, '/');
    if (t.startsWith('~/')) return fs.existsSync(path.join(os.homedir(), t.slice(2)));
    const rel = normRel(t);
    if (!rel) return true;
    return fs.existsSync(path.join(root, rel)) || fs.existsSync(path.join(docDir, t));
}

// `Class.method` в документе — две сущности, в коде они рядом не стоят: dotted-токен
// подтверждён, когда подтверждён каждый его сегмент (короткие сегменты вроде `value`
// или `size` не считаются — их наличие ничего не доказывает).
function identParts(token) {
    if (!token.includes('.')) return [token];
    return token.split('.').filter((s) => s.length >= 4 && !STOP.has(s.toLowerCase()));
}

function verify(claims, src, docDir) {
    const identTokens = new Set();
    for (const c of claims) if (c.cls === 'IDENT') for (const p of identParts(c.token)) identTokens.add(p);
    const found = identTokens.size ? grepIdents(src.root, [...identTokens]) : new Set();
    const known = (t) => found.has(t) || wordIn(src.diff, t);
    const out = [];
    for (const c of claims) {
        if (c.cls === 'IDENT') {
            if (identParts(c.token).every(known)) continue;
            out.push(c);
        } else if (c.cls === 'PATH') {
            if (pathKnown(src, docDir, c.token)) continue;
            out.push(c);
        } else if (c.cls === 'LINK') {
            let t = c.token.replace(/\\/g, '/');
            try {
                t = decodeURIComponent(t);
            } catch {
                /* цель с битым %-кодированием проверяется как есть */
            }
            const target = t.startsWith('~/') ? path.join(os.homedir(), t.slice(2)) : path.resolve(docDir, t);
            if (fs.existsSync(target)) continue;
            out.push(c);
        } else {
            out.push(c);
        }
    }
    return out;
}

// Претензии версии документа в `<ref>` — чтобы отчитывать только то, что внесла ЭТА
// правка или задача. `HEAD:./<имя>` резолвится самим git относительно каталога `-C`
// (арифметика путей через show-toplevel ломалась на junction — см. docs-length-guard.js).
function priorClaims(target, ref) {
    try {
        const old = git(['show', `${ref}:./${path.basename(target)}`], path.dirname(target));
        return new Set(extractClaims(old).map(claimKey));
    } catch {
        return null;
    }
}

function checkDoc(target, opts) {
    const content = fs.readFileSync(target, 'utf8');
    if (!content.trim()) return null;
    const docDir = path.dirname(target);
    const root = repoRoot(docDir);
    if (!root) return null;
    let claims = extractClaims(content);
    const o = opts || {};
    if (typeof o.newString === 'string') {
        // Edit: только то, что пришло в new_string.
        const fresh = new Set(extractClaims(o.newString).map(claimKey));
        claims = claims.filter((c) => fresh.has(claimKey(c)));
    } else if (!o.all) {
        // Write поверх существующего (хук) — претензии из HEAD легаси; CLI с `--base` —
        // легаси всё, что было в версии на базе задачи: правка одного абзаца в старом
        // документе не делает задачу ответственной за его прошлогодние ссылки. `--all`
        // снимает фильтр для полного аудита документа.
        const prior = priorClaims(target, o.base || 'HEAD');
        if (prior) claims = claims.filter((c) => !prior.has(claimKey(c)));
    }
    if (!claims.length) return { target, findings: [] };
    const src = buildSources(root, o.base);
    return { target, findings: verify(claims, src, docDir) };
}

const LABEL = {
    IDENT: 'IDENT  — не найдено ни в коде репозитория, ни в диффе',
    PATH: 'PATH   — такого файла или каталога нет',
    LINK: 'LINK   — ссылка не резолвится от документа',
    NUMBER: 'NUMBER — число-замер без пометки источника',
};

function formatFindings(name, findings) {
    const byCls = new Map();
    for (const f of findings) {
        if (!byCls.has(f.cls)) byCls.set(f.cls, []);
        byCls.get(f.cls).push(f);
    }
    const parts = [];
    for (const cls of ['LINK', 'PATH', 'IDENT', 'NUMBER']) {
        const list = byCls.get(cls);
        if (!list) continue;
        const items = list.map((f) => `\`${f.token}\` (стр. ${f.line})`).join(', ');
        parts.push(`  ${LABEL[cls]}:\n    ${items}`);
    }
    return `Проверка фактов документа — ${name}: ${findings.length} претензий без подтверждения в репозитории

${parts.join('\n')}

Закрой каждую сейчас, не откладывая:
  - идентификатор — открой файл и вставь имя дословно; источник недоступен → замени на
    \`TODO: сверить с <файл>\`; имя из внешней доки, SDK или чужого репозитория → назови
    источник в той же строке («источник: <дока, репозиторий>») либо \`(не проверено — <почему>)\`;
  - путь и ссылку — исправь на существующие;
  - число — назови источник в той же строке («источник: <команда, чарт, лог>»), если оно
    из вывода инструмента в этой сессии; иначе допиши \`(приблизительно)\`.
Правдоподобное имя без источника — выдумка, а не пропуск: документ читают следующие сессии
как факт, и по нему копируют код. Пропуск с TODO виден и чинится за минуту.`;
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        const finish = (v) => {
            if (!done) {
                done = true;
                resolve(v);
            }
        };
        const timer = setTimeout(() => finish(data), STDIN_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => {
            data += c;
        });
        process.stdin.on('end', () => {
            clearTimeout(timer);
            finish(data);
        });
        process.stdin.on('error', () => {
            clearTimeout(timer);
            finish('');
        });
    });
}

function resolveTarget(payload) {
    const input = payload.tool_input || {};
    let target = toNativePath(String(input.file_path || ''));
    if (!target) return null;
    if (!path.isAbsolute(target)) {
        const cwd = toNativePath(String(payload.cwd || ''));
        if (!cwd) return null;
        target = path.join(cwd, target);
    }
    if (!/[\\/]docs[\\/](solutions|decisions|archive)[\\/](?:[^\\/]+[\\/])*[^\\/]+\.md$/i.test(target)) return null;
    if (/^INDEX([-.]|$)/i.test(path.basename(target))) return null;
    return target;
}

async function hookMain() {
    const raw = await readStdin();
    if (!raw.trim()) return null;
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!/^(write|.*edit)$/i.test(String(payload.tool_name || ''))) return null;
    const target = resolveTarget(payload);
    if (!target || !fs.existsSync(target)) return null;
    const { new_string: newS } = payload.tool_input || {};
    const res = checkDoc(target, { newString: typeof newS === 'string' ? newS : undefined });
    if (!res || !res.findings.length) return null;
    return formatFindings(path.basename(target), res.findings);
}

function cliMain(argv) {
    const docs = [];
    let base;
    let json = false;
    let all = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--base') base = argv[++i];
        else if (argv[i] === '--json') json = true;
        else if (argv[i] === '--all') all = true;
        else docs.push(toNativePath(argv[i]));
    }
    if (!docs.length) {
        process.stdout.write('usage: docs-facts-guard.js <doc.md> [...] [--base <sha>] [--all] [--json]\n');
        return 2;
    }
    const results = [];
    for (const d of docs) {
        const abs = path.resolve(d);
        if (!fs.existsSync(abs)) {
            results.push({ target: abs, findings: [{ cls: 'PATH', token: d, line: 0 }] });
            continue;
        }
        const r = checkDoc(abs, { base, all });
        results.push(r || { target: abs, findings: [] });
    }
    const total = results.reduce((n, r) => n + r.findings.length, 0);
    if (json) {
        process.stdout.write(JSON.stringify({ total, results }, null, 2) + '\n');
    } else {
        for (const r of results) {
            if (!r.findings.length) process.stdout.write(`OK  ${r.target}: претензий нет\n`);
            else process.stdout.write(formatFindings(r.target, r.findings) + '\n\n');
        }
        process.stdout.write(`TOTAL: ${total}\n`);
    }
    return total ? 1 : 0;
}

if (require.main === module) {
    if (process.argv.length > 2) {
        try {
            process.exitCode = cliMain(process.argv.slice(2));
        } catch (e) {
            process.stdout.write(`docs-facts-guard: ${(e && e.message) || e}\n`);
            process.exitCode = 2;
        }
    } else {
        hookMain()
            .then((verdict) => {
                if (verdict) {
                    process.stdout.write(
                        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: verdict } })
                    );
                }
                process.exitCode = 0;
            })
            .catch(() => {
                process.exitCode = 0;
            });
    }
}

module.exports = { extractClaims, looksLikeIdent, looksLikePath, resolveTarget, checkDoc, verify, formatFindings, toNativePath };
