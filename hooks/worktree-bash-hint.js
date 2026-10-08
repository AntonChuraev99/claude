#!/usr/bin/env node
// Context hook: SessionStart, SubagentStart, PostToolUse(EnterWorktree).
//
// Problem: a session isolated in a worktree has every Bash command checked by
// Claude Code itself, and a command it cannot verify statically is refused
// with "this command is too complex to verify that it stays inside the
// worktree". Transcripts 2026-10-05..08: 218 such refusals, about 15 per
// worktree session, each one a wasted model round trip. The refused commands
// were shell variables (`S=...; cmd "$S/x"`), `cd ... &&`, `$(...)`, `$?`,
// subshells, `{ ...; } > file`, loops and heredocs -- habits that are fine in
// an ordinary checkout. A text rule is not in view at the moment the command
// is written, so the hint arrives exactly when the session becomes isolated:
// at start inside a worktree, on EnterWorktree, and for every subagent started
// in a worktree (subagents do not see the parent's context).
//
// Output: additionalContext only, never a decision. Fail-open: any error -> exit 0.

const fs = require('fs');

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

function main() {
    let raw = '';
    try {
        raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
        return;
    }
    if (!raw || !raw.trim()) return;

    const payload = JSON.parse(raw);
    const text = evaluate(payload);
    if (!text) return;

    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: payload.hook_event_name,
            additionalContext: text,
        },
    }));
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

module.exports = { evaluate, HINT };
