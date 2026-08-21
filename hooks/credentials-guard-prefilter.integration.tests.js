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

// Жёсткие запреты дисциплины вызовов сравнивать с pwsh-guard нельзя: у него на
// эти команды вердикта нет вовсе, весь смысл — что префильтр выносит свой,
// раньше guard и не спрашивая его. Поэтому ожидание задаётся явно, а прогон всё
// так же идёт через реальный процесс: юнит-тесты judge() не видят ни разбора
// stdin, ни порядка вердиктов, ни формы JSON, которую читает харнесс.
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const DISCIPLINE_CASES = [
    ['grep -rn "FooViewModel" --include=*.kt .', 'deny', /тул Grep \(pattern: "FooViewModel", glob: "\*\.kt"\)/],
    // Замена — ожидание по условию в фоне, а не Monitor: его контракт про поток
    // событий, для одиночного ожидания он сам отсылает к run_in_background.
    ['sleep 25; gh pr checks 104', 'deny', /until .*run_in_background|run_in_background/],
    ['sleep 600 && firebase deploy', 'deny', /run_in_background/],
    // `| wc -l` ничего не обрабатывает — считает то же, что вернул бы поиск, а
    // у тула Grep для этого есть count-режим. Щадить такой пайп значило бы
    // оставить обход запрета в один символ.
    ['grep -rn "Foo" --include=*.kt . | wc -l', 'deny', /count|тул Grep/],
    // А вот настоящая обработка остаётся за Bash: тул Grep в пайп не отдаёт.
    ['grep -rl "Foo" --include=*.kt . | xargs sed -i s/a/b/', 'context', null],
    ['node tests.js | grep -E "FAIL|passed"', 'allow', null],
    ['./gradlew :app:testDebugUnitTest', 'allow', null],
    ['until gh pr checks; do sleep 15; done', 'allow', null],
];

for (const [command, want, reasonRe] of DISCIPLINE_CASES) {
    const payload = JSON.stringify({
        tool_name: 'Bash', cwd: CWD, tool_input: { command },
        // Ключ уникален на прогон и на кейс: подсказки живут под кулдауном 10 мин,
        // и на фиксированном ключе второй запуск теста читал бы состояние первого
        // — «подсказки нет» вместо «подсказка выдана».
        session_id: 'integration', transcript_path: `integration-${RUN}-${command.length}`,
    });
    const res = spawnSync('node', [PREFILTER], { input: Buffer.from(payload, 'utf8') });
    const text = (res.stdout || '').toString().trim();
    let reason = '';
    let got = 'allow';
    try {
        const out = JSON.parse(text).hookSpecificOutput;
        reason = out.permissionDecisionReason || '';
        // Подсказка приходит без permissionDecision — это отдельный исход, а не
        // «нет вердикта»: подменять его на allow значило бы не отличать молчание
        // хука от выданной подсказки.
        got = out.permissionDecision || (out.additionalContext ? 'context' : 'allow');
    } catch (e) { /* пустой stdout — хук промолчал */ }

    const reasonOk = !reasonRe || reasonRe.test(reason);
    if (got === want && reasonOk) {
        console.log(`  PASS ${command}  -> ${got}`);
        passed++;
    } else {
        console.log(`  FAIL ${command}`);
        console.log(`    expected: ${want}${reasonRe ? ` matching ${reasonRe}` : ''}`);
        console.log(`    got:      ${got} ${reason.slice(0, 80)}`);
        failed++;
    }
}

console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
