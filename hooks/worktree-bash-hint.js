#!/usr/bin/env node
// Context hook: SessionStart, SubagentStart, PostToolUse(EnterWorktree).
// On SessionStart/SubagentStart it runs inside hooks/session-start.js; PostToolUse
// (EnterWorktree) registers this file directly.
//
// Job 1 — Bash hint. A session isolated in a worktree has every Bash command checked by
// Claude Code itself, and a command it cannot verify statically is refused with "this
// command is too complex to verify that it stays inside the worktree". Transcripts
// 2026-10-05..08: 218 such refusals, about 15 per worktree session, each one a wasted
// model round trip. The hint arrives exactly when the session becomes isolated: at start
// inside a worktree, on EnterWorktree, and for every subagent started in a worktree.
//
// Job 2 — main-repo write guard (was ensure-worktree-guard.ps1, merged 2026-11-16).
// `.claude/settings.local.json` is per-checkout and NOT tracked by git, so a fresh
// worktree may start with no PreToolUse guard at all; subagents resolve relative paths
// against the MAIN checkout, so without the guard their writes land on the wrong branch
// silently (precedents 2026-05-29, 06-03, 06-23, 07-20). Repo-agnostic: acts only when
// the worktree lives under <repo>\.claude\worktrees\<name> AND that repo ships
// <repo>\.claude\hooks\guard-main-repo-edit.ps1; registers it in the worktree's
// settings.local.json. The pwsh hook ran only on SessionStart, i.e. only when the session
// STARTED in a worktree; EnterWorktree mid-session got nothing. Now both.
//
// Fail-open: any error -> exit 0, never a decision.

'use strict';

const fs = require('fs');
const path = require('path');

const WORKTREE_DIR = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/;

const HINT =
    'Сессия изолирована в worktree: Claude Code сам проверяет каждую Bash-команду и отклоняет ту, '
    + 'которую не может проверить статически («too complex to verify that it stays inside the worktree»). '
    + 'Отказ стоит лишний цикл. Пиши Bash-команды простыми: пути литералом, без присваивания '
    + 'переменных (`S=...; cmd "$S/x"`), без `cd`, `$(...)`, `$?`, подоболочек `( ... )`, групп '
    + '`{ ...; } > file`, циклов и heredoc. Для git в другом каталоге — `git -C <путь>`. Текст или '
    + 'скрипт длиннее строки — сначала файл через Write, потом короткая команда, которая его запускает.';

// Returns the context text or null when the hook stays silent.
function evaluate(payload) {
    if (!payload) return null;
    const event = String(payload.hook_event_name || '');
    if (event === 'PostToolUse') {
        if (payload.tool_name !== 'EnterWorktree') return null;
        return HINT;
    }
    if (event === 'SessionStart' || event === 'SubagentStart') {
        return WORKTREE_DIR.test(String(payload.cwd || '')) ? HINT : null;
    }
    return null;
}

// Every string inside the tool response, depth-first: the EnterWorktree result names
// the new worktree path, and its exact shape is not part of any contract.
function strings(v, out) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
    return out;
}

// The worktree directory this event is about, or null.
function worktreeDirOf(payload) {
    const event = String(payload.hook_event_name || '');
    const candidates = [];
    if (event === 'PostToolUse') {
        for (const s of strings(payload.tool_response, [])) {
            const m = s.match(/[A-Za-z]:[\\/][^"“”\n\r]*?[\\/]\.claude[\\/]worktrees[\\/][^\\/"“”\s]+/);
            if (m) candidates.push(m[0]);
        }
    }
    candidates.push(String(payload.cwd || ''));
    return candidates.find((c) => WORKTREE_DIR.test(c)) || null;
}

const MARKER = '\\.claude\\worktrees\\';

// Registers <repo>\.claude\hooks\guard-main-repo-edit.ps1 in the worktree's
// settings.local.json when the repo ships it and the worktree lacks it.
// Returns {systemMessage, context} when it registered, else null.
function ensureWorktreeGuard(payload) {
    if (!payload) return null;
    const event = String(payload.hook_event_name || '');
    // SessionStart only, as ensure-worktree-guard.ps1 did: a guard registered mid-session
    // (EnterWorktree) takes effect only after a restart, so it would just print a restart
    // warning on every new worktree.
    if (event !== 'SessionStart') return null;
    const wt = worktreeDirOf(payload);
    if (!wt) return null;

    const norm = wt.replace(/\//g, '\\');
    const idx = norm.toLowerCase().indexOf(MARKER);
    if (idx < 0) return null;
    const repoRoot = norm.slice(0, idx);
    const worktreeName = norm.slice(idx + MARKER.length).split('\\')[0];
    if (!worktreeName || !worktreeName.trim()) return null;

    const worktreeRoot = path.win32.join(repoRoot, '.claude', 'worktrees', worktreeName);
    const guardScript = path.win32.join(repoRoot, '.claude', 'hooks', 'guard-main-repo-edit.ps1');
    if (!fs.existsSync(guardScript)) return null; // repo does not use this guard

    const settingsDir = path.win32.join(worktreeRoot, '.claude');
    const settingsPath = path.win32.join(settingsDir, 'settings.local.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    }
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    const existing = settings.hooks.PreToolUse === undefined ? []
        : (Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [settings.hooks.PreToolUse]);
    if (JSON.stringify(existing).includes('guard-main-repo-edit')) return null;

    settings.hooks.PreToolUse = existing.concat([{
        matcher: 'Edit|Write|MultiEdit',
        hooks: [{
            type: 'command',
            shell: 'powershell',
            command: `& '${guardScript}'`,
            timeout: 10,
            statusMessage: 'worktree guard: main-repo write check',
        }],
    }]);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return {
        systemMessage: [
            '⚠ worktree guard: PreToolUse-гард записи в главный checkout не был зарегистрирован',
            `  зарегистрирован для worktree '${worktreeName}'`,
            '  нужен рестарт сессии или /hooks reload, иначе записи в главный checkout не блокируются',
        ].join('\n'),
        context: `worktree-guard: registered PreToolUse main-repo write guard for worktree '${worktreeName}' `
            + '(was missing). Restart or /hooks reload if writes to the main checkout are still not blocked.',
    };
}

// Both jobs for one payload: {systemMessage?, context?} or null. Never throws.
function run(payload) {
    let guard = null;
    try {
        guard = ensureWorktreeGuard(payload);
    } catch (e) {
        guard = null; // a broken installer must never block a session
    }
    let hint = null;
    try {
        hint = evaluate(payload);
    } catch (e) {
        hint = null;
    }
    const context = [hint, guard && guard.context].filter(Boolean).join('\n\n');
    if (!context) return null;
    return { systemMessage: guard ? guard.systemMessage : null, context };
}

function main() {
    let raw = '';
    try {
        raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
        return;
    }
    if (!raw || !raw.trim()) return;

    const payload = JSON.parse(raw);
    const r = run(payload);
    if (!r) return;
    const out = {};
    if (r.systemMessage) {
        out.suppressOutput = true;
        out.systemMessage = r.systemMessage;
    }
    out.hookSpecificOutput = { hookEventName: payload.hook_event_name, additionalContext: r.context };
    process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        // Fail open.
    }
    // process.exitCode, not process.exit(): see hooks/docs-length-guard.js.
    process.exitCode = 0;
}

module.exports = { evaluate, ensureWorktreeGuard, run, HINT };
