#!/usr/bin/env node
// Suite for protected-branch-guard.js (PreToolUse hook). Ported case-for-case from
// protected-branch-guard.tests.ps1 (2026-11-16), plus registry and path cases.
// Hermetic: temp git repo, temp registry (env CLAUDE_BRANCH_GUARD_REGISTRY), temp state
// dir (env CLAUDE_BRANCH_GUARD_STATE_DIR) — never touches the real registry or %TEMP% state.
//
// Contract (2026-09-18): first Write/Edit on a protected branch -> deny with the rule text;
// the same agent (transcript_path) repeating on the same repo+branch -> passes through with
// additionalContext + systemMessage and NO permissionDecision; another agent / another
// protected branch -> deny again; escape hatches and unprotected branches -> silent.
//
// `--hook <file>` runs the same suite against another entry point (write-guards.js
// runs this guard in-process and must behave identically).
// Run: node hooks/protected-branch-guard.tests.js [--hook hooks/write-guards.js]

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const argHook = process.argv.indexOf('--hook');
const HOOK = argHook > 0 ? path.resolve(process.argv[argHook + 1]) : path.join(__dirname, 'protected-branch-guard.js');

let pass = 0;
let fail = 0;
function eq(expected, actual, name) {
    if (expected === actual) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n        expected: [${expected}]\n        actual:   [${actual}]`); }
}
function match(pattern, actual, name) {
    if (actual && new RegExp(pattern).test(actual)) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n        pattern: [${pattern}]\n        actual:  [${actual}]`); }
}

// --- fixtures -------------------------------------------------------------------------
const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'pbg-fx-'));
const repo = path.join(fx, 'repo');
const stateDir = path.join(fx, 'state');
const registry = path.join(fx, 'registry.json');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

// Registry: defaults only, repo unknown -> mrTarget must fall back to the matched branch.
const DEFAULT_REGISTRY = '{ "defaults": { "protected": ["main", "develop", "release/*"], "mrTarget": "develop" }, "repos": {}, "ignoreRepos": [] }';
fs.writeFileSync(registry, DEFAULT_REGISTRY);

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
const file = path.join(repo, 'a.txt');

function invoke(json, vars) {
    const env = Object.assign({}, process.env, {
        CLAUDE_BRANCH_GUARD_REGISTRY: registry,
        CLAUDE_BRANCH_GUARD_STATE_DIR: stateDir,
    }, vars || {});
    delete env.CLAUDE_ALLOW_PROTECTED_BRANCH;
    if (vars && vars.CLAUDE_ALLOW_PROTECTED_BRANCH) env.CLAUDE_ALLOW_PROTECTED_BRANCH = vars.CLAUDE_ALLOW_PROTECTED_BRANCH;
    const r = spawnSync(process.execPath, [HOOK], { input: json, encoding: 'utf8', env });
    return (r.stdout || '').trim();
}
function payload(tool = 'Write', p = file, agent = 'agent-A', extra) {
    return JSON.stringify(Object.assign({
        tool_name: tool,
        tool_input: { file_path: p },
        cwd: repo,
        session_id: 'sess-1',
        transcript_path: `C:\\transcripts\\${agent}.jsonl`,
    }, extra || {}));
}
function parse(out) {
    if (!out) return null;
    try { return JSON.parse(out); } catch (e) { return null; }
}
const hso = (r) => (r && r.hookSpecificOutput) || {};

console.log(`protected-branch-guard — suite (${path.basename(HOOK)})`);

// 1. first hit on main -> deny with the rule and the "repeat passes" hint
let r = parse(invoke(payload()));
eq('deny', hso(r).permissionDecision, 'first Write on main -> deny');
match("защищённой ветке 'main'", hso(r).permissionDecisionReason, 'deny names the branch');
match('повтори тот же вызов', hso(r).permissionDecisionReason, 'deny explains the repeat escape');
match('EnterWorktree', hso(r).permissionDecisionReason, 'deny points at EnterWorktree');
match("'main' только через MR/PR", hso(r).permissionDecisionReason, 'unknown repo: mrTarget falls back to matched branch');

// 2. same agent, same repo+branch -> pass-through with context, no permissionDecision
r = parse(invoke(payload()));
eq(undefined, hso(r).permissionDecision, 'repeat -> no permissionDecision');
match('пропущена как сознательное исключение', hso(r).additionalContext, 'repeat -> additionalContext reminder');
match('повтор, пропущено', r && r.systemMessage, 'repeat -> systemMessage for the user');

// 3. other file, same agent+branch -> still passes (state is per repo+branch, not per file)
r = parse(invoke(payload('Write', path.join(repo, 'sub', 'b.txt'))));
eq(undefined, hso(r).permissionDecision, 'repeat on another file -> passes');
match('пропущена', hso(r).additionalContext, 'repeat on another file -> reminder');

// 4. another agent (own transcript_path) -> deny again
r = parse(invoke(payload('Write', file, 'agent-B')));
eq('deny', hso(r).permissionDecision, 'other agent -> deny again');

// 5. another protected branch -> deny again for agent-A; back on main -> passes
git('checkout', '-q', '-b', 'develop');
r = parse(invoke(payload()));
eq('deny', hso(r).permissionDecision, 'develop after main -> deny (state keyed by branch)');
git('checkout', '-q', 'main');
r = parse(invoke(payload()));
eq(undefined, hso(r).permissionDecision, 'back on main -> still passes');
match('пропущена', hso(r).additionalContext, 'back on main -> reminder present (not a silent exit)');

// 6. unprotected branch -> silent; wildcard pattern release/* -> deny
git('checkout', '-q', '-b', 'feat/x');
eq('', invoke(payload('Write', file, 'agent-C')), 'feature branch -> silent');
git('checkout', '-q', '-b', 'release/1.0');
r = parse(invoke(payload('Edit', file, 'agent-R')));
eq('deny', hso(r).permissionDecision, 'release/* wildcard -> deny');
git('checkout', '-q', 'main');

// 7. escape hatches -> silent even on the first hit
eq('', invoke(payload('Write', file, 'agent-D'), { CLAUDE_ALLOW_PROTECTED_BRANCH: '1' }), 'env escape hatch -> silent');
const flagDir = path.join(repo, '.claude');
fs.mkdirSync(flagDir, { recursive: true });
fs.writeFileSync(path.join(flagDir, '.allow-protected-branch-edits'), '');
eq('', invoke(payload('Write', file, 'agent-E')), 'file-flag escape hatch -> silent');
fs.rmSync(flagDir, { recursive: true, force: true });

// 8. non-writing tool -> silent; every *Edit tool and notebook_path are covered
eq('', invoke(payload('Read', file, 'agent-F')), 'Read -> silent');
r = parse(invoke(payload('MultiEdit', file, 'agent-M')));
eq('deny', hso(r).permissionDecision, 'MultiEdit -> deny');
r = parse(invoke(JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(repo, 'n.ipynb') }, cwd: repo, transcript_path: 'C:\\t\\nb.jsonl' })));
eq('deny', hso(r).permissionDecision, 'NotebookEdit notebook_path -> deny');
r = parse(invoke(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'rel/x.txt' }, cwd: repo, transcript_path: 'C:\\t\\rel.jsonl' })));
eq('deny', hso(r).permissionDecision, 'relative path resolved from cwd -> deny');

// 9. state file is a sha1 name, not the raw key (collision-proof across agents);
//    only denied agents own a file — silent paths write nothing
const stateFiles = fs.readdirSync(stateDir).filter((n) => n.endsWith('.json'));
eq(6, stateFiles.length, 'one state file per denied agent (A, B, R, M, nb, rel), none for silent paths');
match('^[0-9a-f]{40}\\.json$', stateFiles[0], 'state file named by sha1');
const sha = crypto.createHash('sha1').update('C:\\transcripts\\agent-A.jsonl', 'utf8').digest('hex');
eq(true, stateFiles.includes(`${sha}.json`), 'state file = sha1(transcript_path)');

// 10. missing state (fresh dir) -> deny again: no state == "never warned"
fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });
r = parse(invoke(payload()));
eq('deny', hso(r).permissionDecision, 'state wiped -> deny again (fail-closed to deny)');

// 11. record older than the TTL (24h) is ignored on read -> deny again, then a fresh record passes.
//     Covers `claude --resume` next day: same transcript_path, but the warning must be shown anew.
const sf = path.join(stateDir, fs.readdirSync(stateDir).find((n) => n.endsWith('.json')));
const aged = JSON.parse(fs.readFileSync(sf, 'utf8'));
for (const k of Object.keys(aged)) aged[k] = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
fs.writeFileSync(sf, JSON.stringify(aged));
r = parse(invoke(payload()));
eq('deny', hso(r).permissionDecision, 'record older than TTL -> deny again');
r = parse(invoke(payload()));
match('пропущена', hso(r).additionalContext, 'fresh record after expiry -> passes with reminder');

// 12. detached HEAD on the tip of a protected branch -> deny
git('checkout', '-q', '--detach', 'main');
r = parse(invoke(payload('Write', file, 'agent-H')));
eq('deny', hso(r).permissionDecision, 'detached HEAD at main tip -> deny');
match('detached HEAD на вершине', hso(r).permissionDecisionReason, 'detached deny says so');
git('checkout', '-q', 'main');

// 13. registry: known repo, label/mrTarget, case-insensitive pattern; empty list; enabled:false; ignoreRepos
fs.writeFileSync(registry, JSON.stringify({ defaults: { protected: ['main'], mrTarget: 'develop' },
    repos: { [repo]: { label: 'LBL', trunk: 'main', mrTarget: 'develop', protected: ['Main'] } } }));
r = parse(invoke(payload('Write', file, 'agent-K')));
eq('deny', hso(r).permissionDecision, 'known repo, pattern Main matches main (case-insensitive)');
match("\\(LBL\\)", hso(r).permissionDecisionReason, 'known repo -> label used');
match("'develop' только через MR/PR", hso(r).permissionDecisionReason, 'known repo -> its mrTarget used');
fs.writeFileSync(registry, JSON.stringify({ defaults: { protected: [] } }));
eq('', invoke(payload('Write', file, 'agent-L')), 'protected: [] -> nothing protected');
fs.writeFileSync(registry, JSON.stringify({ defaults: {}, repos: { [path.basename(repo)]: { enabled: false } } }));
eq('', invoke(payload('Write', file, 'agent-N')), 'repo disabled by tail key -> silent');
fs.writeFileSync(registry, JSON.stringify({ defaults: {}, repos: { [path.basename(repo).slice(0, 3)]: { enabled: false } } }));
r = parse(invoke(payload('Write', file, 'agent-O')));
eq('deny', hso(r).permissionDecision, 'prefix of the repo name is not a segment match -> still guarded');
fs.writeFileSync(registry, JSON.stringify({ defaults: {}, ignoreRepos: [fx] }));
eq('', invoke(payload('Write', file, 'agent-P')), 'ignoreRepos ancestor -> silent');
fs.writeFileSync(registry, '{ broken');
eq('', invoke(payload('Write', file, 'agent-Q')), 'broken registry -> fail open, silent');
fs.writeFileSync(registry, DEFAULT_REGISTRY);

// 14. degenerate input
eq('', invoke(''), 'empty stdin -> silent');
eq('', invoke('not json'), 'garbage stdin -> silent');
eq('', invoke(payload('Write', path.join(fx, 'nogit', 'x.txt'), 'agent-S', { cwd: fx })), 'outside git -> silent');

fs.rmSync(fx, { recursive: true, force: true });
console.log(`\npass=${pass} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
