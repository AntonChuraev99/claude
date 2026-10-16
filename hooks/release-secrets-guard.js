#!/usr/bin/env node
// Модуль PreToolUse(Bash|PowerShell): сверка gitignored-секретов перед релизной
// сборкой. Подключается из credentials-guard-prefilter.js — тот уже висит на
// каждом вызове шелла, а отдельный хук стоил бы ещё один спавн node на каждую
// команду (docs/solutions/hook-spawn-cost-windows-2026-08-19.md).
//
// Problem: релиз собирается из linked worktree (`.claude/worktrees/<slug>`).
// Ключи аналитики, `google-services.json`, keystore лежат в gitignore, и в
// worktree попадают только по `.worktreeinclude`. Не хватило паттерна — сборка
// либо падает поздно, либо (хуже) собирается с заглушкой или старым ключом и
// уезжает в стор. Правило текстом агент в этот момент не видит, поэтому сверку
// держит хук.
//
// Поведение: команда `gradlew … (bundle|assemble|publish)*Release` в linked
// worktree → gitignored-файлы главного checkout по паттернам `.worktreeinclude`
// (нет файла — DEFAULT_PATTERNS) сверяются с каталогом сборки: файл есть и хеш
// совпадает. Расхождение → deny со списком и командами копирования. Повтор той
// же сборки тем же агентом в том же worktree проходит: расхождение бывает
// намеренным (другие ключи у ветки), причина идёт в отчёт. Сборка из главного
// checkout — сравнивать не с чем, молчим.
//
// Fail-open: любая ошибка → null (allow). Сбой хука не должен блокировать работу.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const STATE_DIR = path.join(os.tmpdir(), 'claude-release-secrets');
const STATE_TTL_MS = 3 * 24 * 3600 * 1000;

// Gradle-задача релиза в позиции аргумента gradlew. testReleaseUnitTest, lint
// и прочие задачи с «Release» в имени не собирают артефакт — их не трогаем.
const RELEASE_CMD = /(?:^|[\s;&|(\\/])gradlew(?:\.bat)?\b[^\n;|&]*?(?:^|[\s:])(?:bundle|assemble|publish)\w*Release\w*\b/im;

// Журнал deny и намеренных повторов — для replay записи improvements.
const EVENTS = path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'stats', 'release-secrets-events.jsonl');

// Тот же набор, что в skills/git-worktree-env (стандартный .worktreeinclude).
const DEFAULT_PATTERNS = [
    'secrets.properties', 'local.properties', 'local.defaults.properties', 'gradle.properties',
    'keystore.properties', 'signing.properties', '*.jks', '*.keystore',
    'google-services.json', 'agconnect-services.json',
    'fabric.properties', 'crashlytics.properties', 'sentry.properties',
    '*.pem', '*.key', '*.p12', '*.mobileprovision',
    '.env', '.env.*',
];

// Копии и производные, а не исходники: сами worktree внутри главного checkout,
// выходы сборки, кеши Gradle и IDE.
const SKIP_PATH = /(^|\/)(\.claude\/worktrees|build|\.gradle|\.idea|\.kotlin|node_modules)\//;

function git(cwd, args) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return r.stdout;
}

const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2');
// Git Bash отдаёт `/c/Users/...`; path.resolve на Windows понял бы это как `C:\c\Users`.
const nativePath = (s) => (process.platform === 'win32' ? s.replace(/^\/([a-z])(?=\/|$)/i, (_, d) => `${d.toUpperCase()}:`) : s);
const ARG = '("[^"]+"|\'[^\']+\'|[^\\s;&|]+)';

// Каталог, откуда реально идёт сборка, а не каталог сессии: последний `cd <dir>`
// перед gradlew, затем `-p <dir>` либо путь к самому gradlew.
function buildDir(command, cwd) {
    const m = RELEASE_CMD.exec(command);
    if (!m) return cwd;
    const at = m.index + m[0].search(/gradlew/i);
    const before = command.slice(0, at);
    let base = cwd;
    const cdRe = new RegExp(`(?:^|[;&|(]|&&)\\s*cd\\s+(?:/d\\s+)?${ARG}`, 'gi');
    for (const c of before.matchAll(cdRe)) base = path.resolve(base, nativePath(unquote(c[1])));
    const call = command.slice(at, m.index + m[0].length);
    const p = new RegExp(`\\s(?:-p|--project-dir)(?:\\s+|=)${ARG}`).exec(call);
    if (p) return path.resolve(base, nativePath(unquote(p[1])));
    const g = /(?:^|[\s;&|(])["']?([^\s;&|"']+)[\\/]$/.exec(before);
    return g ? path.resolve(base, nativePath(g[1])) : base;
}

// { top, mainRoot } для linked worktree, иначе null.
function locate(cwd) {
    const out = git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    if (!out) return null;
    const [top, common] = out.split(/\r?\n/).map((s) => s.trim());
    if (!top || !common || path.basename(common) !== '.git') return null;
    const mainRoot = path.dirname(common);
    if (path.resolve(top).toLowerCase() === path.resolve(mainRoot).toLowerCase()) return null;
    return { top: path.resolve(top), mainRoot: path.resolve(mainRoot) };
}

// `!x` в .worktreeinclude — явное исключение из копирования: в сверку не берём.
function readPatterns(mainRoot) {
    try {
        const lines = fs.readFileSync(path.join(mainRoot, '.worktreeinclude'), 'utf8')
            .split(/\r?\n/).map((s) => s.trim())
            .filter((s) => s && !s.startsWith('#'));
        const patterns = lines.filter((s) => !s.startsWith('!'));
        const excludes = lines.filter((s) => s.startsWith('!')).map((s) => s.slice(1));
        if (patterns.length) return { patterns, excludes, source: '.worktreeinclude' };
    } catch (e) { /* файла нет */ }
    return { patterns: DEFAULT_PATTERNS, excludes: [], source: 'стандартный список' };
}

// Паттерн gitignore → glob-pathspec git: без слэша — на любой глубине.
function toPathspec(p, exclude) {
    const magic = exclude ? ':(exclude,glob)' : ':(glob)';
    const clean = p.replace(/^\//, '').replace(/\/$/, '/**');
    return p.replace(/\/$/, '').includes('/') || p.startsWith('/')
        ? `${magic}${clean}`
        : `${magic}**/${clean}`;
}

function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Список расхождений: [{ rel, kind: 'missing' | 'differs' }].
function compare(loc, patterns, excludes) {
    const specs = [...patterns.map((p) => toPathspec(p)), ...excludes.map((p) => toPathspec(p, true))];
    const out = git(loc.mainRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...specs]);
    if (out === null) return null;
    const problems = [];
    for (const rel of out.split('\0').filter(Boolean)) {
        if (SKIP_PATH.test(rel)) continue;
        const src = path.join(loc.mainRoot, rel);
        const dst = path.join(loc.top, rel);
        let srcStat;
        try { srcStat = fs.statSync(src); } catch (e) { continue; }
        if (!srcStat.isFile()) continue;
        if (!fs.existsSync(dst)) { problems.push({ rel, kind: 'missing' }); continue; }
        try {
            if (sha(src) !== sha(dst)) problems.push({ rel, kind: 'differs' });
        } catch (e) { /* не читается — не судим */ }
    }
    return problems;
}

// Запрет одноразовый на агента, worktree и ТЕКСТ команды: другая релизная
// задача после намеренного повтора сверяется заново.
function stateFile(key, top, command) {
    const cmd = String(command || '').trim().replace(/\s+/g, ' ');
    const h = crypto.createHash('sha1').update(`${key || 'nosession'}|${top}|${cmd}`).digest('hex').slice(0, 24);
    return path.join(STATE_DIR, `${h}.json`);
}

function sweepStale() {
    try {
        const now = Date.now();
        for (const name of fs.readdirSync(STATE_DIR)) {
            const p = path.join(STATE_DIR, name);
            try { if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.unlinkSync(p); } catch (e) { /* унесли */ }
        }
    } catch (e) { /* каталога нет */ }
}

function logEvent(event, loc, problems) {
    try {
        fs.mkdirSync(path.dirname(EVENTS), { recursive: true });
        fs.appendFileSync(EVENTS, JSON.stringify({
            ts: new Date().toISOString(),
            event,
            repo: path.basename(loc.mainRoot),
            missing: problems ? problems.filter((p) => p.kind === 'missing').length : null,
            differs: problems ? problems.filter((p) => p.kind === 'differs').length : null,
        }) + '\n');
    } catch (e) { /* лог не важнее вердикта */ }
}

function renderReason(loc, problems, source) {
    const q = (p) => `"${p.replace(/\\/g, '/')}"`;
    const lines = problems.map(({ rel, kind }) =>
        `- \`${rel}\` — ${kind === 'missing' ? 'нет в каталоге сборки' : 'отличается от главного checkout'}`);
    const copy = problems.map(({ rel }) => {
        const dst = path.join(loc.top, rel);
        return `mkdir -p ${q(path.dirname(dst))} && cp ${q(path.join(loc.mainRoot, rel))} ${q(dst)}`;
    });
    return [
        `Релизная сборка из worktree \`${loc.top}\`: gitignored-секреты не совпадают с главным checkout \`${loc.mainRoot}\` (паттерны — ${source}).`,
        ...lines,
        '',
        'Скопируй файлы и повтори сборку:',
        '```bash',
        ...copy,
        '```',
        'Файла нет в `.worktreeinclude` — допиши паттерн туда, иначе следующий worktree снова соберётся без него.',
        'Расхождение намеренное (у ветки свои ключи) — **повтори эту же команду**, она пройдёт один раз; причину укажи в отчёте.',
    ].join('\n');
}

// Возвращает текст deny либо null.
function releaseVerdict(command, cwd, key) {
    if (typeof command !== 'string' || !RELEASE_CMD.test(command) || !cwd) return null;
    const loc = locate(buildDir(command, cwd));
    if (!loc) return null;
    const file = stateFile(key, loc.top, command);
    if (fs.existsSync(file)) {
        // Намеренный повтор: пропускаем и снимаем отметку — следующий запуск сверяется заново.
        try { fs.unlinkSync(file); } catch (e) { /* унесли */ }
        logEvent('repeat', loc, null);
        return null;
    }
    const { patterns, excludes, source } = readPatterns(loc.mainRoot);
    const problems = compare(loc, patterns, excludes);
    if (!problems || !problems.length) return null;
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        sweepStale();
        fs.writeFileSync(file, JSON.stringify({ denied: Date.now(), problems }));
    } catch (e) {
        // Не смогли запомнить — не блокируем, иначе deny повторялся бы бесконечно.
        return null;
    }
    logEvent('deny', loc, problems);
    return renderReason(loc, problems, source);
}

module.exports = { releaseVerdict, buildDir, stateFile, toPathspec, RELEASE_CMD, DEFAULT_PATTERNS, STATE_DIR };

