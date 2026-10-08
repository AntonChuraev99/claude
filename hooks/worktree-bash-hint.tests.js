#!/usr/bin/env node
// Tests for worktree-bash-hint.js.
//
// Pin: подсказка приходит на EnterWorktree и на старт сессии или субагента
// внутри .claude/worktrees/<name> (оба разделителя пути); обычный checkout,
// сам каталог worktrees без имени и чужие тулы — тишина.
//
// Usage: node hooks/worktree-bash-hint.tests.js

const { evaluate, HINT } = require('./worktree-bash-hint.js');

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

const hinted = (payload) => evaluate(payload) === HINT;

console.log('=== EnterWorktree ===');
check('PostToolUse EnterWorktree hints', hinted({ hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree' }), true);
check('PostToolUse Bash silent', hinted({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), false);

console.log('=== start inside a worktree ===');
const winWt = 'C:\\Users\\Someone\\proj\\.claude\\worktrees\\fix-x';
const posixWt = '/c/Users/Someone/proj/.claude/worktrees/fix-x/web';
check('SessionStart windows path hints', hinted({ hook_event_name: 'SessionStart', cwd: winWt }), true);
check('SubagentStart posix subdir hints', hinted({ hook_event_name: 'SubagentStart', cwd: posixWt }), true);

console.log('=== silence elsewhere ===');
check('SessionStart main checkout silent', hinted({ hook_event_name: 'SessionStart', cwd: 'C:\\Users\\Someone\\proj' }), false);
check('SubagentStart bare worktrees dir silent', hinted({ hook_event_name: 'SubagentStart', cwd: 'C:\\proj\\.claude\\worktrees' }), false);
check('SessionStart without cwd silent', hinted({ hook_event_name: 'SessionStart' }), false);
check('unknown event silent', hinted({ hook_event_name: 'Stop', cwd: winWt }), false);
check('null payload silent', hinted(null), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
