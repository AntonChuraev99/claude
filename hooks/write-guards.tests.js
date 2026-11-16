#!/usr/bin/env node
// Tests for write-guards.js: the combined PreToolUse process must print exactly
// what each guard prints on its own.
//   1. the full protected-branch-guard suite, run against write-guards.js;
//   2. byte-for-byte comparison with guard-claude-work-writes.js on its cases.
// Usage: node hooks/write-guards.tests.js

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'write-guards.js');
const CW = path.join(__dirname, 'guard-claude-work-writes.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? `\n    ${detail}` : ''}`); }
}

console.log('=== protected-branch-guard suite via write-guards.js ===');
const suite = spawnSync(process.execPath, [path.join(__dirname, 'protected-branch-guard.tests.js'), '--hook', HOOK], { encoding: 'utf8' });
const tail = (suite.stdout || '').trim().split(/\r?\n/).pop();
console.log(`  ${tail}`);
check('branch-guard suite green through write-guards.js', suite.status === 0 && /fail=0/.test(tail), suite.stdout);

console.log('=== .claude-work cases: byte-identical to guard-claude-work-writes.js ===');
const run = (file, input) => spawnSync(process.execPath, [file], { input, encoding: 'utf8' }).stdout;
const cases = [
    ['Write', 'C:\\Users\\YOUR_USERNAME\\.claude-work\\agents\\foo.md'],
    ['Edit', 'C:/Users/YOUR_USERNAME/.claude-work/skills/x/SKILL.md'],
    ['NotebookEdit', 'C:\\Users\\YOUR_USERNAME\\.claude-work\\nb.ipynb'],
    ['MultiEdit', 'C:\\Users\\YOUR_USERNAME\\.CLAUDE-WORK\\Agents\\Foo.md'],
    ['Write', 'C:\\Users\\YOUR_USERNAME\\.claude-work\\projects\\p\\memory\\m.md'],
    ['Write', 'C:\\Users\\YOUR_USERNAME\\repo\\my.claude-work\\agents\\foo.md'],
];
for (const [tool, p] of cases) {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const input = JSON.stringify({ tool_name: tool, tool_input: { [key]: p }, cwd: 'C:\\', transcript_path: 'C:\\t\\wg.jsonl' });
    const a = run(CW, input);
    const b = run(HOOK, input);
    check(`${tool} ${p}`, a === b, `single: ${JSON.stringify(a)}\n    combined: ${JSON.stringify(b)}`);
}
check('deny case is not empty', run(HOOK, JSON.stringify({ tool_name: 'Write', tool_input: { file_path: cases[0][1] } })).includes('"permissionDecision":"deny"'));
check('garbage stdin -> silent', run(HOOK, 'garbage') === '');
check('empty stdin -> silent', run(HOOK, '') === '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
