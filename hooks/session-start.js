#!/usr/bin/env node
// SessionStart + SubagentStart: every node-side start hook in ONE process.
//
// Until 2026-11-16 a session start spawned ten hook processes, six of them pwsh
// (idle start 0.32–0.79 s each) — and SessionStart timeouts came in series of
// 15–16 s under memory pressure. The node-side jobs now run here, each a module
// with its own tests and its own standalone entry point:
//
//   SessionStart  model-overlay · worktree-bash-hint (+ worktree write guard) ·
//                 ensure-plugin-patches · ensure-bash-discipline-registered
//   SubagentStart model-overlay (subagent.md) · worktree-bash-hint
//
// lib/hookout.py argued for separate processes: one crash would take every hook
// down. Here each job runs in its own try/catch, so a throwing module drops only
// its own part of the output.
//
// Output: one JSON object. additionalContext — the parts joined by a blank line,
// overlay first; systemMessage — the screen lines joined by a newline.

'use strict';

const fs = require('fs');

function attempt(fn) {
    try {
        return fn();
    } catch (e) {
        return null;
    }
}

function collect(payload) {
    const event = String(payload.hook_event_name || 'SessionStart');
    const contexts = [];
    const screens = [];
    const add = (r) => {
        if (!r) return;
        if (r.context) contexts.push(r.context);
        if (r.systemMessage) screens.push(r.systemMessage);
    };

    add(attempt(() => {
        const r = require('./model-overlay.js').safeEvaluate(Object.assign({}, payload, { hook_event_name: event }));
        return r ? { context: r.context } : null;
    }));
    add(attempt(() => require('./worktree-bash-hint.js').run(Object.assign({}, payload, { hook_event_name: event }))));

    if (event === 'SessionStart') {
        add(attempt(() => {
            const msgs = require('./ensure-plugin-patches.js').run();
            return msgs.length ? { systemMessage: msgs.join('\n') } : null;
        }));
        add(attempt(() => require('./ensure-bash-discipline-registered.js').run()));
    }
    return { event, contexts, screens };
}

function render({ event, contexts, screens }) {
    if (!contexts.length && !screens.length) return '';
    const out = {};
    if (screens.length) {
        out.suppressOutput = true;
        out.systemMessage = screens.join('\n');
    }
    if (contexts.length) {
        out.hookSpecificOutput = { hookEventName: event, additionalContext: contexts.join('\n\n') };
    }
    return JSON.stringify(out);
}

if (require.main === module) {
    try {
        let payload = {};
        try {
            const raw = fs.readFileSync(0, 'utf8');
            if (raw && raw.trim()) payload = JSON.parse(raw) || {};
        } catch (e) {
            payload = {};
        }
        const text = render(collect(payload));
        if (text) process.stdout.write(text);
    } catch (e) {
        // fail open: a start hook must never block a session
    }
    // process.exitCode, not process.exit(): see hooks/docs-length-guard.js.
    process.exitCode = 0;
}

module.exports = { collect, render };
