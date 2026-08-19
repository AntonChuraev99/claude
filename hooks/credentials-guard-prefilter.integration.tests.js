#!/usr/bin/env node
// Integration tests for credentials-guard-prefilter.js -> credentials-guard.ps1.
//
// The unit tests only cover the routing decision. These run the real pwsh guard
// through the prefilter and compare the verdict against invoking the guard
// directly, because the failure mode that matters lives in the plumbing, not in
// the decision: the first version passed {encoding:'buffer'} with a string
// input, spawnSync threw ERR_UNKNOWN_ENCODING, the catch swallowed it and the
// hook exited 0 -- turning a deny on `gcloud run deploy` into a silent allow.
//
// Slow by design (each case starts pwsh twice). Not part of the fast suite.
//
// Usage: node hooks/credentials-guard-prefilter.integration.tests.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
// Проверяемые файлы берутся рядом с тестом, а не из ~/.claude: в worktree это
// разные копии, и на пути через homedir прогон зеленел бы на неизменённом
// файле, ничего не говоря о правке (поймано ревью 2026-08-19).
const GUARD = path.join(__dirname, 'credentials-guard.ps1');
const PREFILTER = path.join(__dirname, 'credentials-guard-prefilter.js');

// The guard needs a repo that is in the credentials registry, otherwise every
// verdict is the same "not in the registry" deny and the comparison proves
// nothing. The path is read from the local registry rather than written here:
// ~/.claude is published, and real project paths do not belong in it.
function firstRegistryRepo() {
    const registry = path.join(CLAUDE_DIR, 'config', 'project-credentials.local.md');
    if (!fs.existsSync(registry)) return null;
    for (const line of fs.readFileSync(registry, 'utf8').split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const cell = line.split('|')[1];
        if (!cell) continue;
        const repoPath = cell.trim();
        if (!repoPath || repoPath === 'repo_path' || /^-+$/.test(repoPath)) continue;
        return repoPath.replace(/\\/g, '/');
    }
    return null;
}

const CWD = firstRegistryRepo();
if (!CWD) {
    console.log('SKIP: config/project-credentials.local.md has no repo rows — '
        + 'the guard would answer "not in the registry" for every case.');
    process.exitCode = 0;
    return;
}

const CASES = [
    'firebase deploy',
    'gcloud run deploy --region europe-west1',
    'adb uninstall com.example.app',
    'gh release create v1.0.0',
    'ls -la',
    'git status',
    'echo "firebase deploy"',
];

let passed = 0;
let failed = 0;

function decisionOf(stdout) {
    const text = (stdout || '').toString().trim();
    if (!text) return 'allow';
    try {
        return JSON.parse(text).hookSpecificOutput.permissionDecision;
    } catch (e) {
        return `unparseable(${text.slice(0, 60)})`;
    }
}

for (const command of CASES) {
    const payload = JSON.stringify({
        tool_name: 'Bash', cwd: CWD, tool_input: { command },
    });
    const input = Buffer.from(payload, 'utf8');

    const direct = spawnSync('pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD], { input });
    const viaPrefilter = spawnSync('node', [PREFILTER], { input });

    const want = decisionOf(direct.stdout);
    const got = decisionOf(viaPrefilter.stdout);

    if (want === got) {
        console.log(`  PASS ${command}  -> ${got}`);
        passed++;
    } else {
        console.log(`  FAIL ${command}`);
        console.log(`    guard directly: ${want}`);
        console.log(`    via prefilter:  ${got}`);
        failed++;
    }
}

console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
