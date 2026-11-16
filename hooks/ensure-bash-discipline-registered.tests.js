#!/usr/bin/env node
// Suite for ensure-bash-discipline-registered.js. Ported case-for-case from
// ensure-bash-discipline-registered.tests.ps1 (2026-11-16).
// The profile root is a temp fixture via CLAUDE_HOME, so the suite never reads the real
// ~/.claude/settings.json.
//
// Contract: silent when the invariant holds; one JSON object naming every broken part when
// it does not; never blocks, never edits, always exit 0.
// Run: node hooks/ensure-bash-discipline-registered.tests.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'ensure-bash-discipline-registered.js');
let pass = 0;
let fail = 0;
const roots = [];

function newHome(settings, withModule = true, logLines = []) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ebdr-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    if (settings !== null) {
        fs.writeFileSync(path.join(root, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
    }
    if (withModule) fs.writeFileSync(path.join(root, 'hooks', 'bash-tool-discipline.js'), '// stub');
    if (logLines.length) {
        fs.mkdirSync(path.join(root, 'error-logs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'error-logs', 'hook-failures.jsonl'), logLines.join('\n') + '\n');
    }
    return root;
}

function invoke(home) {
    const env = Object.assign({}, process.env, { CLAUDE_HOME: home });
    const r = spawnSync(process.execPath, [HOOK], { input: '{"cwd":"C:\\\\x","source":"startup"}', encoding: 'utf8', env });
    return (r.stdout || '').trim();
}
const ctx = (out) => { try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch (e) { return null; } };

function silent(out, name) {
    if (!out) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n        expected silence, got: [${out}]`); }
}
function fires(out, needle, name) {
    const c = ctx(out);
    if (c && c.includes(needle)) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n        wanted [${needle}] in: [${c}]`); }
}

function prefilter(matcher = 'Bash|Grep') {
    const h = { type: 'command', command: "& 'credentials-guard-prefilter.js'" };
    return matcher === null ? { hooks: [h] } : { matcher, hooks: [h] };
}
const settings = (entries) => ({ hooks: { PreToolUse: entries } });

console.log('ensure-bash-discipline-registered — suite');

// --- invariant holds ---
silent(invoke(newHome(settings([prefilter()]))), 'registered + Bash|Grep + module -> silent');

// --- the three breakages the hook exists to catch ---
const noEntry = settings([{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'other.js' }] }]);
fires(invoke(newHome(noEntry)), 'отсутствует в settings.json', 'prefilter entry removed -> fires');
fires(invoke(newHome(settings([prefilter('Bash')]))), 'не покрывает тул Grep', 'matcher lost Grep -> fires');
fires(invoke(newHome(settings([prefilter('Grep')]))), 'не покрывает тул Bash', 'matcher lost Bash -> fires');
fires(invoke(newHome(settings([prefilter()]), false)), 'bash-tool-discipline.js не найден', 'module gone -> fires');

// --- regression: coverage is the UNION, and a matcher-less entry is WIDER, not narrower ---
silent(invoke(newHome(settings([prefilter('Bash'), prefilter('Grep')]))), 'Bash and Grep split across two entries -> silent');
silent(invoke(newHome(settings([prefilter(null)]))), 'entry without matcher (matches all tools) -> silent');
silent(invoke(newHome(settings([prefilter('Bash|Grep|Write')]))), 'wider matcher -> silent');

// --- degradation log: the window is judged per line ts, not by the file mtime ---
const fresh = JSON.stringify({ ts: new Date().toISOString(), hook: 'credentials-guard-prefilter', event: 'discipline-module-unavailable', error: 'boom' });
const stale = '{"ts":"2026-01-01T00:00:00.0000000Z","hook":"credentials-guard-prefilter","event":"discipline-module-unavailable","error":"old"}';
fires(invoke(newHome(settings([prefilter()]), true, [fresh])), 'discipline-module-unavailable', 'fresh failure line -> fires');
// The file is written now, so its mtime is fresh while every record in it is months old.
silent(invoke(newHome(settings([prefilter()]), true, [stale, stale])), 'stale lines in a freshly written log -> silent');
fires(invoke(newHome(settings([prefilter()]), true, [stale, fresh])), 'за 7 дней 1 записей', 'mixed log counts only the fresh line');

// --- fail-open: nothing here may ever break session start ---
silent(invoke(newHome(null)), 'no settings.json -> silent');
silent(invoke(newHome('not json at all')), 'malformed settings.json -> silent');

// --- output shape ---
let evt = null;
try { evt = JSON.parse(invoke(newHome(noEntry))).hookSpecificOutput.hookEventName; } catch (e) { /* below */ }
if (evt === 'SessionStart') { pass++; console.log('  PASS  output hookEventName = SessionStart'); }
else { fail++; console.log(`  FAIL  output hookEventName = SessionStart (got [${evt}])`); }

for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { /* best effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
