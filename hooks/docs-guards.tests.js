#!/usr/bin/env node
// Tests for docs-guards.js: the combined PostToolUse process prints exactly what
// each docs guard prints alone, and joins the two texts when both speak.
// Hermetic: temp git repo with docs/solutions/*.md.
// Usage: node hooks/docs-guards.tests.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.join(__dirname, 'docs-guards.js');
const LEN = path.join(__dirname, 'docs-length-guard.js');
const FACTS = path.join(__dirname, 'docs-facts-guard.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? `\n    ${String(detail).slice(0, 600)}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
git('init', '-q', '-b', 'main');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'Real.kt'), 'class RealThing\n');
fs.mkdirSync(path.join(root, 'docs', 'solutions'), { recursive: true });
git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

const doc = (name, body) => {
    const p = path.join(root, 'docs', 'solutions', name);
    fs.writeFileSync(p, body);
    return p;
};
const long = '# Долгий\n\n## Решение\n\n' + Array.from({ length: 450 }, () => 'слово').join(' ') + '\n';
const fake = '# Факты\n\n## Решение\n\nСм. `src/NoSuchFile.kt` и `src/Real.kt`.\n';

const run = (file, input) => spawnSync(process.execPath, [file], { input, encoding: 'utf8', cwd: root }).stdout;
const write = (p) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: p }, cwd: root });
const ctx = (out) => {
    try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch (e) { return null; }
};

console.log('=== only the length guard speaks ===');
{
    const p = doc('long.md', long);
    const single = run(LEN, write(p));
    const facts = run(FACTS, write(p));
    const combined = run(HOOK, write(p));
    check('length guard fires on its own', single.includes('Бюджет длины'), single);
    check('facts guard silent on its own', facts === '', facts);
    check('combined === length guard, byte for byte', combined === single, `${combined}\n---\n${single}`);
}

console.log('=== only the facts guard speaks ===');
{
    const p = doc('fake.md', fake);
    const single = run(FACTS, write(p));
    const len = run(LEN, write(p));
    const combined = run(HOOK, write(p));
    check('facts guard fires on its own', single.includes('NoSuchFile.kt'), single);
    check('length guard silent on its own', len === '', len);
    check('combined === facts guard, byte for byte', combined === single, `${combined}\n---\n${single}`);
}

console.log('=== both speak: one additionalContext, length first ===');
{
    const p = doc('both.md', long + '\nСм. `src/NoSuchFile.kt`.\n');
    const a = ctx(run(LEN, write(p)));
    const b = ctx(run(FACTS, write(p)));
    const out = run(HOOK, write(p));
    check('both guards fire alone', a && b, `${a}\n${b}`);
    check('combined context = length + blank line + facts', ctx(out) === `${a}\n\n${b}`, ctx(out));
    check('combined event = PostToolUse', JSON.parse(out).hookSpecificOutput.hookEventName === 'PostToolUse');
}

console.log('=== silence elsewhere ===');
{
    const code = path.join(root, 'src', 'Other.kt');
    fs.writeFileSync(code, 'x');
    check('code file -> silent', run(HOOK, write(code)) === '');
    check('Read tool -> silent', run(HOOK, JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'docs', 'solutions', 'long.md') }, cwd: root })) === '');
    check('Edit that shrinks text -> length silent, facts on new_string only',
        run(HOOK, JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'docs', 'solutions', 'long.md'), old_string: 'слово слово', new_string: 'слово' }, cwd: root })) === '');
    check('garbage stdin -> silent', run(HOOK, 'garbage') === '');
    check('empty stdin -> silent', run(HOOK, '') === '');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
