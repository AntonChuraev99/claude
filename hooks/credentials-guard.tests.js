#!/usr/bin/env node
// Детерминированные тесты credentials-guard.ps1 на фикстурном реестре.
//
// Интеграционный набор (credentials-guard-prefilter.integration.tests.js) идёт по
// ЖИВОМУ реестру и пропускается без него. Здесь профиль подменён: USERPROFILE
// указывает на временный каталог с собственным реестром, поэтому прогон не зависит
// от машины и не трогает реальные креды. Сетевых проб нет: каждый кейс, где guard
// сверяет gcloud, называет проект явно, firebase берёт проект из .firebaserc или
// флага, adb — из аргумента.
//
// Кейсы — обезличенные формы реальных ложных deny из replay 2026-10-08
// (improvements/2026-09-07-account-align.md § Replay) плюс анти-регрессия: что
// блокировалось по делу, блокируется и теперь.
//
// Usage: node hooks/credentials-guard.tests.js
// GUARD_UNDER_TEST=<путь> — прогнать тот же набор по другой копии guard'а (red-прогон).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = process.env.GUARD_UNDER_TEST || path.join(__dirname, 'credentials-guard.ps1');
const PREFILTER = path.join(__dirname, 'credentials-guard-prefilter.js');

const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fx-'));
const home = path.join(fx, 'home');
const repo = path.join(home, 'repo');
const sibling = path.join(home, 'repo-web');               // НЕ в реестре
const worktree = path.join(repo, '.claude', 'worktrees', 't');
const enc = (p) => p.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
const uuid = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const scratch = path.join(fx, 'Temp', 'claude', enc(repo), uuid, 'scratchpad');
const scratchWt = path.join(fx, 'Temp', 'claude', enc(worktree), uuid, 'scratchpad');
const scratchSibling = path.join(fx, 'Temp', 'claude', enc(sibling), uuid, 'scratchpad');
for (const d of [path.join(home, '.claude', 'config'), worktree, sibling, scratch, scratchWt, scratchSibling]) {
    fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(path.join(repo, '.firebaserc'), JSON.stringify({ projects: { default: 'fb-1', staging: 'fb-1', prod: 'other-fb' } }));
fs.writeFileSync(path.join(home, '.claude', 'config', 'project-credentials.local.md'), [
    '| repo_path | account | gcp_project | cf_account_id | firebase_project | play_package | git_remote |',
    '|---|---|---|---|---|---|---|',
    `| ${repo} | user@example.com | proj-1 |  | fb-1 | com.example.app | https://github.com/org/app.git |`,
    '',
].join('\n'));

// /c/Users/... — форма пути Git Bash.
const posix = (p) => p.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');

const ENV = Object.assign({}, process.env, {
    USERPROFILE: home, HOME: home, CLAUDE_HOME: path.dirname(__dirname),
});
delete ENV.CLAUDE_ALLOW_DEPLOY;
delete ENV.CG_TEST_UNSET;

let passed = 0;
let failed = 0;

function decisionOf(stdout) {
    const text = (stdout || '').toString().trim();
    if (!text) return 'allow';
    try {
        const out = JSON.parse(text).hookSpecificOutput || {};
        return out.permissionDecision || 'allow';
    } catch (e) {
        return `unparseable(${text.slice(0, 60)})`;
    }
}

function run(file, args, payload) {
    return spawnSync(file, args, { input: Buffer.from(JSON.stringify(payload), 'utf8'), env: ENV });
}

// via: 'guard' — прямой вызов (как раньше, без маски); 'prefilter' — весь путь хука.
function check(name, command, want, opts) {
    const o = opts || {};
    const payload = { tool_name: o.tool || 'Bash', cwd: o.cwd || repo, tool_input: { command } };
    const res = o.via === 'prefilter'
        ? run('node', [PREFILTER], payload)
        : run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD], payload);
    const got = decisionOf(res.stdout);
    let reason = '';
    try { reason = JSON.parse(res.stdout.toString()).hookSpecificOutput.permissionDecisionReason || ''; } catch (e) { /* allow */ }
    if (got === want) {
        console.log(`  PASS ${name}  -> ${got}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}`);
        console.log(`    expected: ${want}`);
        console.log(`    got:      ${got} ${reason.split('\n')[0].slice(0, 160)}`);
        failed++;
    }
}

const NL = '\n';

console.log('=== анти-регрессия: по делу блокируется, как раньше ===');
check('firebase deploy из каталога проекта', 'firebase deploy', 'allow');
check('чужой GCP-проект', 'gcloud run deploy --project other-1', 'deny');
check('свой GCP-проект', 'gcloud run deploy --project proj-1', 'allow');
check('чужой проект внутри bash -c', 'bash -c "gcloud run deploy --project other-1"', 'deny');
check('продолжение строки не рвёт сегмент', 'gcloud run \\' + NL + '  deploy --project other-1', 'deny');
check('чужой firebase-проект флагом', 'firebase deploy --project other-fb', 'deny');
// Ревью 2026-10-08: при двух РАЗНЫХ --project в цепочке сверялся только .firebaserc.
check('два --project: свой, затем чужой', 'firebase deploy --project fb-1 && firebase deploy --project other-fb', 'deny');
check('два --project: чужой, затем свой', 'firebase deploy --project other-fb && firebase deploy --only hosting --project fb-1', 'deny');
check('явный свой + вызов без флага (.firebaserc = свой)', 'firebase deploy --project fb-1 && firebase deploy', 'allow');
check('-P чужой', 'firebase deploy -P other-fb', 'deny');
// Алиас из .firebaserc резолвится в project id, а не сверяется литералом.
check('алиас staging -> свой проект', 'firebase deploy --project staging', 'allow');
check('алиас prod -> чужой проект', 'firebase deploy --project prod', 'deny');
check('cd в несуществующий каталог перед firebase', 'cd /c/definitely-missing-dir-xyz && firebase deploy', 'deny');
check('нераскрываемая переменная перед firebase (каталог решает проект)',
    'cd "$CG_TEST_UNSET/x" && firebase deploy', 'deny');
check('нераскрываемая переменная + чужой gcloud', 'cd "$CG_TEST_UNSET/x" && gcloud run deploy --project other-1', 'deny');
check('adb uninstall чужого пакета', 'adb uninstall com.other.app', 'deny');
check('cd в scratchpad самой командой — по-прежнему вне реестра',
    `cd "${scratch}" && gcloud run deploy --project proj-1`, 'deny');
check('scratchpad НЕзарегистрированного соседа repo-web — не путается с repo',
    'gcloud run deploy --project proj-1', 'deny', { cwd: scratchSibling });

console.log('');
console.log('=== cd: пути Git Bash, ~, переменные, PowerShell-кавычки ===');
check('cd /c/... (POSIX-путь)', `cd ${posix(repo)} && firebase deploy`, 'allow');
check('cd ~/repo', 'cd ~/repo && firebase deploy', 'allow');
check('переменная из присваивания в той же команде',
    `R="${posix(repo)}"; cd "$R" && firebase deploy`, 'allow');
check('${VAR} из присваивания', `R=${posix(repo)}; cd \${R} && firebase deploy`, 'allow');
check('PowerShell: Set-Location \'...\'', `Set-Location '${repo}'; firebase deploy`, 'allow', { tool: 'PowerShell' });
check('PowerShell: $S = \'...\'; Set-Location $S', `$S = '${repo}'; Set-Location $S; firebase deploy`, 'allow', { tool: 'PowerShell' });
check('нераскрываемая переменная, gcloud со своим проектом (каталог не влияет)',
    'cd "$CG_TEST_UNSET/x" && gcloud run deploy --project proj-1', 'allow');
check('cd в многострочной команде на второй строке', `echo start${NL}cd ${posix(repo)} && firebase deploy`, 'allow',
    { cwd: sibling });

console.log('');
console.log('=== cwd: worktree и scratchpad проекта из реестра ===');
check('worktree проекта', 'gcloud run deploy --project proj-1', 'allow', { cwd: worktree });
check('scratchpad проекта', 'gcloud run deploy --project proj-1', 'allow', { cwd: scratch });
check('scratchpad worktree проекта', 'gcloud run deploy --project proj-1', 'allow', { cwd: scratchWt });
check('scratchpad проекта, чужой проект — deny', 'gcloud run deploy --project other-1', 'deny', { cwd: scratch });

console.log('');
console.log('=== глагол только в сегменте своего инструмента ===');
check('токен из gcloud + curl на …/publishers/…',
    'TOK=$(gcloud auth print-access-token --account user@example.com); curl -s -H "Authorization: Bearer $TOK" '
    + 'https://example.googleapis.com/v1/projects/p/publishers/google/models/m:generateContent', 'allow');
check('PowerShell: токен из gcloud + node deploy_rules.mjs',
    '$t = (gcloud auth print-access-token --account user@example.com); node ".\\deploy_rules.mjs" $t storage.rules',
    'allow', { tool: 'PowerShell' });
check('adb shell + rm -rf локального каталога', 'adb -s emulator-5554 shell input tap 1 1 && rm -rf rec', 'allow');
check('gh run list после cd /c/...', `cd ${posix(repo)}${NL}gh run list --branch develop -L 8; gh release view --json tagName`, 'allow');
// Имя файла с глаголом в сегменте gh по-прежнему сверяется: `gh workflow run
// deploy.yml` — настоящий деплой через CI, отличать его от `gh run list --workflow
// deploy.yml` по тексту guard не берётся.
check('gh workflow run deploy.yml — сверяется (remote в каталоге не совпал)',
    `cd ${posix(repo)} && gh workflow run deploy.yml`, 'deny');
check('adb: pm enable чужого + uninstall своего', 'adb -s emulator-5554 shell pm enable com.google.android.gms '
    + '&& adb -s emulator-5554 uninstall com.example.app', 'allow');
check('adb: uninstall своего И чужого — сверяется каждый', 'adb uninstall com.example.app && adb uninstall com.other.app', 'deny');

console.log('');
console.log('=== текст команды — не вызов (весь путь через префильтр) ===');
check('commit message с gcloud deploy в heredoc',
    'git commit -m "$(cat <<\'EOF\'' + NL + 'fix: notes' + NL + NL + 'gcloud run deploy --project other-1 got flags' + NL + 'EOF' + NL + ')"',
    'allow', { via: 'prefilter' });
check('gh issue body с firebase deploy',
    'gh issue create -R org/app --title "Check" --body "$(cat <<\'EOF\'' + NL + 'firebase deploy --project other-fb later' + NL + 'EOF' + NL + ')"',
    'allow', { via: 'prefilter' });
check('настоящий деплой после коммита — сверяется',
    'git commit -m "notes" && gcloud run deploy --project other-1', 'deny', { via: 'prefilter' });
check('bash -c с чужим проектом — сверяется', 'bash -c "gcloud run deploy --project other-1"', 'deny', { via: 'prefilter' });

fs.rmSync(fx, { recursive: true, force: true });
console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
