#!/usr/bin/env node
// Tests for guard-claude-work-writes.js.
//
// The guard replaced a pwsh script that ran on every Write/Edit, so these pin
// the behaviour that was ported: which paths are blocked, which data dirs stay
// allowed, and that the suggested canonical path keeps its original casing.
//
// Usage: node hooks/guard-claude-work-writes.tests.js

const { evaluate } = require('./guard-claude-work-writes.js');

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

function blocked(filePath, tool) {
    const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const reason = evaluate({ tool_input: { [key]: filePath } });
    return reason !== null;
}

function suggestion(filePath) {
    const reason = evaluate({ tool_input: { file_path: filePath } });
    if (!reason) return null;
    const m = reason.match(/file_path = '([^']+)'/);
    return m ? m[1] : null;
}

console.log('=== blocked: infra under .claude-work ===');
check('agents file is blocked',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude-work\\agents\\foo.md'), true);
check('CLAUDE.md is blocked',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude-work\\CLAUDE.md'), true);
check('settings.json is blocked',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude-work\\settings.json'), true);
check('forward slashes are normalised before matching',
    blocked('C:/Users/YOUR_USERNAME/.claude-work/skills/x/SKILL.md'), true);
check('uppercase path is blocked',
    blocked('C:\\Users\\YOUR_USERNAME\\.CLAUDE-WORK\\Agents\\Foo.md'), true);
check('notebook_path is checked too',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude-work\\nb.ipynb', 'NotebookEdit'), true);

console.log('');
console.log('=== allowed: data dirs and everything outside ===');
check('projects/ stays allowed',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude-work\\projects\\p\\memory\\m.md'), false);
check('agent-memory/ stays allowed',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude-work\\agent-memory\\a.md'), false);
check('stats/ stays allowed',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude-work\\stats\\s.json'), false);
check('canonical .claude path is allowed',
    blocked('C:\\Users\\YOUR_USERNAME\\.claude\\agents\\foo.md'), false);
check('unrelated project path is allowed',
    blocked('C:\\Users\\YOUR_USERNAME\\projects\\App\\src\\Main.kt'), false);
check('a directory merely named claude-work elsewhere is untouched',
    blocked('C:\\Users\\YOUR_USERNAME\\repo\\claude-work\\file.md'), false);
// The marker carries a leading separator on purpose: a sibling whose name
// merely ends in .claude-work is a different directory, not the projection.
check('a sibling ending in .claude-work is untouched',
    blocked('C:\\Users\\YOUR_USERNAME\\repo\\my.claude-work\\agents\\foo.md'), false);

console.log('');
console.log('=== degenerate input is allowed, never crashes ===');
check('missing tool_input', evaluate({}) === null, true);
check('missing file_path', evaluate({ tool_input: {} }) === null, true);
check('empty file_path', evaluate({ tool_input: { file_path: '' } }) === null, true);
check('whitespace file_path', evaluate({ tool_input: { file_path: '   ' } }) === null, true);

console.log('');
console.log('=== suggested canonical path ===');
check('redirects to .claude with casing preserved',
    suggestion('C:\\Users\\YOUR_USERNAME\\.claude-work\\agents\\MyAgent.md'),
    'C:\\Users\\YOUR_USERNAME\\.claude\\agents\\MyAgent.md');
check('forward slashes are normalised in the suggestion',
    suggestion('C:/Users/YOUR_USERNAME/.claude-work/skills/Deploy/SKILL.md'),
    'C:\\Users\\YOUR_USERNAME\\.claude\\skills\\Deploy\\SKILL.md');

console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
