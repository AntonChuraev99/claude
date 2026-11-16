#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit) guard: не дать писать код прямо на
// защищённой ветке (main / master / develop и т.п.) НЕЗАМЕЧЕННЫМ. Правило: работа идёт
// в отдельной ветке и вливается в транк через MR/PR.
//
// Порт protected-branch-guard.ps1 (2026-11-16): хук стоит на каждом Write/Edit, а
// холостой старт pwsh — 0,41–0,46 с против ~0,1 с у node; 22 из 157 таймаутов хуков
// за 30 дней. Поведение и текст вывода — те же; тесты: protected-branch-guard.tests.js.
// В живой регистрации вызывается из hooks/write-guards.js (один процесс на правку
// вместе с guard-claude-work-writes); как самостоятельный хук тоже работает.
//
// Реестр веток по проектам — ~/.claude/config/protected-branches.local.json
// (шаблон — protected-branches.example.json). Реестра нет / репозитория в нём нет
// => применяются defaults.
//
// Решение — «deny один раз, повтор проходит» (с 2026-09-18; до того — безусловный deny).
// Первая правка на защищённой ветке блокируется с текстом правила и worktree-процедуры;
// повтор того же вызова (та же ветка, тот же репозиторий, тот же агент) проходит, и
// хук лишь добавляет короткое напоминание в контекст (`additionalContext`) плюс
// `systemMessage` пользователю.
//
// «Тот же агент» — ключ состояния по transcript_path (у каждого субагента свой), с
// откатом на session_id. Состояние — файл %TEMP%\claude-branch-guard\<sha1(ключ)>.json,
// TTL сутки, override каталога — env CLAUDE_BRANCH_GUARD_STATE_DIR (тесты).
//
// Почему `deny`, а не `ask`: проверено вживую 2026-08-04 — при
// `defaultMode: bypassPermissions` CLI молча проглатывает `ask`; `deny` блокирует.
// Пропуск повтора — НЕ `allow` (он снял бы штатный permission-flow), а отсутствие
// permissionDecision вовсе.
//
// No-op (тихий выход), если: инструмент не пишет файл · путь вне git-репозитория ·
// репозиторий самого профиля Claude (~/.claude, ~/.claude-work) · ветка не защищена ·
// выставлен escape-hatch. Любая внутренняя ошибка => выход 0 плюс строка в
// stats/hook-degraded.log — иначе «сломан» неотличим от «не понадобился».
//
// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: покрывает только файловые инструменты. Запись через Bash
// хук НЕ видит — она закрывается процедурно (process-gate.yaml → no-code-on-protected-branch).
//
// Escape-hatch (глушит проверку целиком, ставит пользователь): env
// CLAUDE_ALLOW_PROTECTED_BRANCH=1 либо файл-флаг <repo>\.claude\.allow-protected-branch-edits
//
// ВАЖНО: файл публикуется в открытый репозиторий — никаких абсолютных путей,
// имён проектов и логинов в коде.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const STATE_TTL_SEC = 24 * 60 * 60;
const GIT_TIMEOUT_MS = 5000;
// Текст правила собран из here-string pwsh-версии: CRLF-файл давал CRLF внутри
// строки. Сохранено ради побайтового совпадения вывода с прежним хуком.
const NL = '\r\n';

function toWindowsPath(p) {
    if (p === null || p === undefined) return '';
    let s = String(p);
    if (!s.trim()) return s;
    s = s.trim();
    let m = s.match(/^\/+mnt\/([a-zA-Z])\/(.*)$/);
    if (m) s = `${m[1]}:/${m[2]}`;
    else if ((m = s.match(/^\/+([a-zA-Z])\/(.*)$/))) s = `${m[1]}:/${m[2]}`;
    return s.replace(/\//g, '\\').replace(/\\+$/, '');
}

function pathKey(p) {
    if (!p || !String(p).trim()) return '';
    return toWindowsPath(p).toLowerCase();
}

// Совпадение путей по ГРАНИЦЕ СЕГМЕНТА: ключ реестра — либо сам путь репозитория,
// либо его предок, либо его хвост.
function repoKeyMatch(repoKey, key) {
    if (!repoKey || !key) return false;
    const r = repoKey.replace(/\\+$/, '') + '\\';
    const k = key.replace(/\\+$/, '') + '\\';
    return r === k || r.startsWith(k) || r.includes('\\' + k);
}

// PowerShell `-like`: `*`, `?`, `[...]`, без учёта регистра.
function wildcardMatch(text, pattern) {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') re += '.*';
        else if (c === '?') re += '.';
        else if (c === '[') {
            const j = pattern.indexOf(']', i + 1);
            if (j > i + 1) {
                re += '[' + pattern.slice(i + 1, j).replace(/\\/g, '\\\\') + ']';
                i = j;
            } else re += '\\[';
        } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
    }
    return new RegExp(`^${re}$`, 'i').test(text);
}

const asArray = (v) => (Array.isArray(v) ? v : [v]);
const has = (obj, name) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, name);

function git(dir, args) {
    const r = spawnSync('git', ['-C', dir, ...args], {
        encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '').split(/\r?\n/).filter((l) => l.length);
}

// --- состояние «уже предупреждал» -----------------------------------------------

function stateDir() {
    return process.env.CLAUDE_BRANCH_GUARD_STATE_DIR || path.join(os.tmpdir(), 'claude-branch-guard');
}

// Имя файла — sha1 ключа: transcript_path'ы делят длинный общий префикс.
function stateFile(key) {
    const sha = crypto.createHash('sha1').update(key || 'nosession', 'utf8').digest('hex');
    return path.join(stateDir(), `${sha}.json`);
}

function readState(file) {
    try {
        if (!fs.existsSync(file)) return {};
        const obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) {
        return {};
    }
}

function removeStale(dir) {
    try {
        const cutoff = Date.now() - STATE_TTL_SEC * 1000;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json')) continue;
            const f = path.join(dir, name);
            try {
                const st = fs.statSync(f);
                if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(f);
            } catch (e) { /* чужой файл занят — не наше дело */ }
        }
    } catch (e) { /* подметание — не повод ронять хук */ }
}

function writeState(file, state, firstWrite) {
    try {
        const dir = path.dirname(file);
        fs.mkdirSync(dir, { recursive: true });
        if (firstWrite) removeStale(dir);
        fs.writeFileSync(file, JSON.stringify(state));
    } catch (e) {
        // без состояния хук деградирует до «deny каждый раз», что безопаснее пропуска
    }
}

function selfRoots() {
    const home = process.env.USERPROFILE || os.homedir();
    const roots = [path.dirname(__dirname), path.join(home, '.claude'), path.join(home, '.claude-work')]
        .map(pathKey).filter(Boolean);
    return [...new Set(roots)];
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}
function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function denyText(where, repoLabel, protectedList, mrTarget, repoRoot, trunk) {
    return [
        `Правка файла на ${where} (${repoLabel}).`,
        '',
        `Правило: на ${protectedList.join(' / ')} код не пишем. Работа идёт в отдельной ветке`,
        `и попадает в '${mrTarget}' только через MR/PR — прямых коммитов в транк нет.`,
        '',
        'Порядок вместо этой правки: тул EnterWorktree({name: "<slug>"}) — заведёт',
        '.claude/worktrees/<slug> на новой ветке от транка и переключит сессию туда;',
        'затем повторить правку уже по пути внутри worktree. Без тула:',
        `  git -C "${repoRoot}" worktree add .claude/worktrees/<slug> -b <type>/<slug> ${trunk}`,
        '  # скопировать gitignored-конфиги сборки (local.properties / secrets.properties / .env.local)',
        '  # убедиться, что сборка стартует из нового каталога — ДО первой правки',
        '',
        'Правка сознательно делается в транке (hotfix по согласованию, конфиг, который обязан',
        'примениться сразу, явная просьба пользователя работать в текущем checkout)? Это',
        'предупреждение, а не стена: повтори тот же вызов — второй и последующие пройдут',
        '(эта ветка, этот репозиторий, этот агент, в течение суток) — и назови причину в отчёте.',
        'Выключить проверку целиком может пользователь: файл-флаг',
        `"${repoRoot}\\.claude\\.allow-protected-branch-edits" (действует сразу) либо`,
        'CLAUDE_ALLOW_PROTECTED_BRANCH=1 в окружении, из которого запущен claude (хук наследует',
        // Без бэктиков: в here-string pwsh-версии бэктик был escape-символом и
        // в выводе не появлялся.
        'env CLI — нужен перезапуск сессии; setx текущую сессию не меняет).',
    ].join(NL);
}

// Returns the hook output object, or null when the hook stays silent.
// Throws on internal errors; callers log and fail open.
function evaluate(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const toolName = String(payload.tool_name || '');
    if (!/^(write|.*edit)$/i.test(toolName)) return null;
    if (process.env.CLAUDE_ALLOW_PROTECTED_BRANCH === '1') return null;

    // 1. Целевой путь. NotebookEdit исторически носил его в notebook_path.
    const input = payload.tool_input || {};
    let target = String(input.file_path || '') || String(input.notebook_path || '');
    if (!target) return null;
    target = toWindowsPath(target);
    // Относительный путь резолвится от cwd сессии, а не от каталога запуска хука.
    // «Корневой» — как Path.IsPathRooted: `C:…` или ведущий `\`.
    if (!/^[a-zA-Z]:/.test(target) && !target.startsWith('\\')) {
        const cwd = toWindowsPath(String(payload.cwd || ''));
        if (!cwd) return null;
        target = path.win32.join(cwd, target);
    }

    // 2. Репозитории самого профиля Claude — до git, самый частый случай без процессов.
    const roots = selfRoots();
    const targetKey = target.toLowerCase();
    if (roots.some((sr) => targetKey === sr || targetKey.startsWith(sr + '\\'))) return null;

    // 3. Ближайший СУЩЕСТВУЮЩИЙ каталог: файл (и его папка) может ещё не быть создан.
    let dir = target;
    if (isFile(dir)) dir = path.win32.dirname(dir);
    while (dir && !isDir(dir)) {
        const parent = path.win32.dirname(dir);
        if (!parent || parent === dir) { dir = null; break; }
        dir = parent;
    }
    if (!dir) return null;

    // 4. Репозиторий и ветка — одним процессом git.
    const out = git(dir, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']);
    if (!out || out.length < 2) return null;
    const repoRoot = toWindowsPath(out[0]);
    const branch = out[1].trim();
    if (!repoRoot || !branch) return null;
    const repoKey = repoRoot.toLowerCase();

    if (roots.includes(repoKey)) return null;
    if (fs.existsSync(path.win32.join(repoRoot, '.claude\\.allow-protected-branch-edits'))) return null;

    // Detached HEAD на вершине защищённой ветки — тоже запись в транк.
    let detachedAt = [];
    if (branch === 'HEAD') {
        detachedAt = (git(dir, ['branch', '--points-at', 'HEAD', '--format=%(refname:short)']) || [])
            .map((s) => s.trim()).filter(Boolean);
        if (!detachedAt.length) return null;
    }

    // 5. Реестр.
    const candidates = [];
    if (process.env.CLAUDE_BRANCH_GUARD_REGISTRY) candidates.push(process.env.CLAUDE_BRANCH_GUARD_REGISTRY);
    candidates.push(path.join(path.dirname(__dirname), 'config', 'protected-branches.local.json'));
    if (process.env.USERPROFILE) {
        candidates.push(path.join(process.env.USERPROFILE, '.claude', 'config', 'protected-branches.local.json'));
    }
    const registry = candidates.find((c) => fs.existsSync(c));

    let protectedList = ['main', 'master', 'develop'];
    let trunk = null;
    let mrTarget = null;
    let repoLabel = null;
    let knownRepo = false;

    if (registry) {
        const cfg = JSON.parse(fs.readFileSync(registry, 'utf8').replace(/^﻿/, '')) || {};
        const defaults = cfg.defaults;
        // НАЛИЧИЕ ключа, а не truthiness: "protected": [] — «здесь ничего не защищаем».
        if (has(defaults, 'protected')) protectedList = asArray(defaults.protected);
        if (defaults && defaults.mrTarget) mrTarget = String(defaults.mrTarget);

        for (const ign of asArray(cfg.ignoreRepos)) {
            if (repoKeyMatch(repoKey, pathKey(ign))) return null;
        }
        if (cfg.repos && typeof cfg.repos === 'object') {
            for (const [name, entry] of Object.entries(cfg.repos)) {
                if (!repoKeyMatch(repoKey, pathKey(name))) continue;
                if (entry && entry.enabled === false) return null;
                knownRepo = true;
                if (has(entry, 'protected')) protectedList = asArray(entry.protected);
                if (entry && entry.trunk) trunk = String(entry.trunk);
                if (entry && entry.mrTarget) mrTarget = String(entry.mrTarget);
                if (entry && entry.label) repoLabel = String(entry.label);
                break;
            }
        }
    }

    // 6. Совпадение ветки — с шаблонами вида release/*.
    const branchesToTest = detachedAt.length ? detachedAt : [branch];
    let matched = null;
    for (const b of branchesToTest) {
        for (const p of protectedList) {
            const pat = p === null || p === undefined ? '' : String(p);
            if (pat && wildcardMatch(b, pat)) { matched = b; break; }
        }
        if (matched) break;
    }
    if (!matched) return null;

    if (!trunk) trunk = matched;
    // Глобальный mrTarget осмыслен только для репозитория из реестра.
    if (!knownRepo || !mrTarget) mrTarget = trunk;
    if (!repoLabel) repoLabel = repoRoot;

    const where = detachedAt.length
        ? `detached HEAD на вершине защищённой ветки '${matched}'`
        : `защищённой ветке '${matched}'`;

    // 7. Уже предупреждали этого агента про эту ветку этого репозитория?
    const agentKey = String(payload.transcript_path || '') || String(payload.session_id || '');
    const file = stateFile(agentKey);
    const state = readState(file);
    const seenKey = `${repoKey}|${matched}`;
    const now = Math.floor(Date.now() / 1000);
    const seenAt = has(state, seenKey) ? Math.trunc(Number(state[seenKey]) || 0) : 0;
    if (seenAt > 0 && now - seenAt < STATE_TTL_SEC) {
        const note = `protected-branch-guard: правка на ${where} (${repoLabel}) пропущена как сознательное исключение — `
            + `назвать причину в отчёте; результат уходит в '${mrTarget}' только через MR/PR.`;
        return {
            systemMessage: `⚠ branch guard: правка на ${where} (${repoLabel}) — повтор, пропущено.`,
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note },
        };
    }

    const firstWrite = Object.keys(state).length === 0;
    state[seenKey] = now;
    writeState(file, state, firstWrite);

    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: denyText(where, repoLabel, protectedList.map((p) => (p === null || p === undefined ? '' : String(p))), mrTarget, repoRoot, trunk),
        },
    };
}

// Fail-open, но не молча: без строки в журнале replay не отличит «ни разу не
// понадобился» от «сломан и не звал». stats/ — вне git.
function logDegraded(err) {
    try {
        const log = path.join(path.dirname(__dirname), 'stats', 'hook-degraded.log');
        fs.mkdirSync(path.dirname(log), { recursive: true });
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const msg = String((err && err.message) || err).replace(/\s+/g, ' ');
        fs.appendFileSync(log, `${ts}\tprotected-branch-guard\t${msg}\n`);
    } catch (e) { /* журнал — не повод ронять хук */ }
}

// Safe wrapper for in-process callers (write-guards.js): never throws.
function safeEvaluate(payload) {
    try {
        return evaluate(payload);
    } catch (e) {
        logDegraded(e);
        return null;
    }
}

if (require.main === module) {
    try {
        const raw = fs.readFileSync(0, 'utf8');
        if (raw && raw.trim()) {
            let payload;
            try {
                payload = JSON.parse(raw);
            } catch (e) {
                logDegraded(e);
                payload = null;
            }
            const out = payload ? safeEvaluate(payload) : null;
            if (out) process.stdout.write(JSON.stringify(out));
        }
    } catch (e) {
        logDegraded(e);
    }
    // process.exitCode, not process.exit(): see hooks/docs-length-guard.js.
    process.exitCode = 0;
}

module.exports = { evaluate, safeEvaluate, wildcardMatch, repoKeyMatch, toWindowsPath };
