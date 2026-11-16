#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit): every write guard in ONE process.
//
// Before 2026-11-16 each Write/Edit started two processes before the tool ran —
// node guard-claude-work-writes.js and pwsh protected-branch-guard.ps1 (idle start
// 0.41–0.46 s; 22 + 7 of 157 hook timeouts in 30 days). Both guards are modules now;
// this entry reads stdin once and asks them in order:
//
//   1. guard-claude-work-writes — a write through the .claude-work projection;
//   2. protected-branch-guard   — a write on a protected branch (deny once).
//
// The first guard that answers wins: its JSON is printed exactly as the guard
// prints it on its own. Order matters only for paths both could judge, and there
// is none — protected-branch-guard skips the profile directories before git.
// Each module keeps its own tests and its own standalone entry point.
//
// Fail-open per guard: one guard throwing does not stop the other.

'use strict';

const fs = require('fs');

function loadGuards() {
    const guards = [];
    try {
        const { evaluate } = require('./guard-claude-work-writes.js');
        guards.push((payload) => {
            const reason = evaluate(payload);
            if (!reason) return null;
            return {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: reason,
                },
            };
        });
    } catch (e) { /* module missing — the other guard still runs */ }
    try {
        const { safeEvaluate } = require('./protected-branch-guard.js');
        guards.push(safeEvaluate);
    } catch (e) { /* module missing — the other guard still runs */ }
    return guards;
}

function decide(payload) {
    for (const guard of loadGuards()) {
        let out = null;
        try {
            out = guard(payload);
        } catch (e) {
            out = null;
        }
        if (out) return out;
    }
    return null;
}

if (require.main === module) {
    try {
        const raw = fs.readFileSync(0, 'utf8');
        if (raw && raw.trim()) {
            let payload = null;
            try { payload = JSON.parse(raw); } catch (e) { payload = null; }
            const out = payload ? decide(payload) : null;
            if (out) process.stdout.write(JSON.stringify(out));
        }
    } catch (e) {
        // fail open
    }
    // process.exitCode, not process.exit(): see hooks/docs-length-guard.js.
    process.exitCode = 0;
}

module.exports = { decide };
