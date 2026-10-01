#!/usr/bin/env node
// Tests for artemis-default-guard.js.
//
// Pin: первый mcp__mobile__* агента — deny с маршрутом на ARTEMIS, повтор
// проходит, у другого агента (свой transcript_path) счёт свой, чужие тулы
// не трогаются, ключ различает транскрипты с общим длинным префиксом.
//
// Usage: node hooks/artemis-default-guard.tests.js

const fs = require('fs');
const { evaluate, stateFile } = require('./artemis-default-guard.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    if (actual === expected) {
        console.log(`  PASS ${name}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}`);
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
        failed++;
    }
}

const run = `test-${process.pid}-${Date.now()}`;
const prefix = 'C:\\Users\\Someone\\.claude-work\\projects\\C--Users-Someone-AndroidStudioProjects-long-project-name\\';
const agentA = `${prefix}${run}-aaaaaaaa-1111.jsonl`;
const agentB = `${prefix}${run}-bbbbbbbb-2222.jsonl`;
const used = [agentA, agentB, `sess-${run}`, `${prefix}${run}-g.jsonl`];

function denied(tool, transcript, session) {
    return evaluate({ tool_name: tool, transcript_path: transcript, session_id: session }) !== null;
}

try {
    console.log('=== once per agent ===');
    check('first mobile call denied', denied('mcp__mobile__ui', agentA), true);
    check('retry passes', denied('mcp__mobile__ui', agentA), false);
    check('other mobile tool after nudge passes', denied('mcp__mobile__screen', agentA), false);
    check('another agent gets its own nudge', denied('mcp__mobile__input', agentB), true);

    console.log('=== reason routes to ARTEMIS ===');
    const reason = evaluate({ tool_name: 'mcp__mobile__device', session_id: `sess-${run}` });
    check('falls back to session_id', reason !== null, true);
    check('names artemis tool', /mcp__artemis__mobile_run_task/.test(reason || ''), true);
    check('says retry passes', /повтори этот же вызов/.test(reason || ''), true);

    console.log('=== untouched tools ===');
    check('artemis not blocked', denied('mcp__artemis__mobile_run_task', `${prefix}${run}-c.jsonl`), false);
    check('Bash not blocked', denied('Bash', `${prefix}${run}-d.jsonl`), false);
    check('mobile browser module not blocked', denied('mcp__mobile__browser_open', `${prefix}${run}-e.jsonl`), false);
    check('mobile repl not blocked', denied('mcp__mobile__repl_spawn', `${prefix}${run}-f.jsonl`), false);
    check('legacy split name blocked', denied('mcp__mobile__input_tap', `${prefix}${run}-g.jsonl`), true);
    check('empty payload', evaluate(null), null);

    console.log('=== key ===');
    check('long common prefix -> distinct state files', stateFile(agentA) !== stateFile(agentB), true);
    check('no traversal out of state dir', /\.\./.test(stateFile('..\\..\\x')), false);
} finally {
    for (const k of used) {
        try { fs.unlinkSync(stateFile(k)); } catch (e) { /* не создан */ }
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
