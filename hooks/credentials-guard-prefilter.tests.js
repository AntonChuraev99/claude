#!/usr/bin/env node
// Tests for credentials-guard-prefilter.js.
//
// The prefilter's only job is deciding whether credentials-guard.ps1 has to
// run. The asymmetry is the whole point: letting a dangerous command through
// without the guard is a security bug, while running the guard on a harmless
// command merely costs a pwsh start. So every case that could conceivably
// deploy must answer true, and false is only ever asserted for commands the
// guard itself would wave through.
//
// Usage: node hooks/credentials-guard-prefilter.tests.js

const { needsGuard } = require('./credentials-guard-prefilter.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    if (actual === expected) {
        console.log(`  PASS ${name}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}  expected ${expected}, got ${actual}`);
        failed++;
    }
}

function ask(command, extra) {
    return needsGuard(JSON.stringify(Object.assign(
        { tool_name: 'Bash', tool_input: { command } }, extra || {},
    )));
}

console.log('=== must reach the guard ===');
check('firebase deploy', ask('firebase deploy'), true);
check('gcloud run deploy', ask('gcloud run deploy --region europe-west1'), true);
check('wrangler pages deploy', ask('wrangler pages deploy ./dist'), true);
check('npx wrangler deploy (wrapper)', ask('npx wrangler deploy'), true);
check('gh release create', ask('gh release create v1.0.0'), true);
check('adb uninstall', ask('adb uninstall com.example.app'), true);
check('gsutil rm -r (legacy binary)', ask('gsutil rm -r gs://bucket/path'), true);
check('gcloud storage rm -r', ask('gcloud storage rm -r gs://bucket/path'), true);
check('chained after cd', ask('cd /c/proj && firebase deploy'), true);
check('env-prefixed', ask('FOO=1 gcloud functions deploy fn'), true);
check('inside bash -c', ask('bash -c "wrangler deploy"'), true);
check('secret set', ask('wrangler secret put API_KEY'), true);

console.log('');
console.log('=== case must not open a hole (PowerShell -match ignores case) ===');
check('Firebase Deploy', ask('Firebase Deploy'), true);
check('GCLOUD deploy', ask('GCLOUD deploy --project x'), true);
check('wrangler PAGES DEPLOY', ask('wrangler PAGES DEPLOY'), true);
check('AdB UnInstall', ask('AdB UnInstall com.example.app'), true);

console.log('');
console.log('=== may skip the guard ===');
check('plain ls', ask('ls -la'), false);
check('git status', ask('git status'), false);
check('gradle build', ask('./gradlew assembleDebug'), false);
check('gh pr view (tool, no state-changing verb)', ask('gh pr view 12'), false);
check('adb devices (tool, no verb)', ask('adb devices'), false);
check('verb without tool', ask('npm run deploy'), false);
check('non-Bash tool', needsGuard(JSON.stringify({
    tool_name: 'Read', tool_input: { file_path: 'x' },
})), false);
// Тул PowerShell исполняет те же деплои, что и Bash, и на Windows он основной.
// Пока он сюда не входил, `firebase deploy` через него шёл мимо guard целиком.
check('PowerShell tool reaches the guard', needsGuard(JSON.stringify({
    tool_name: 'PowerShell', tool_input: { command: 'firebase deploy' },
})), true);
check('PowerShell tool, harmless command', needsGuard(JSON.stringify({
    tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' },
})), false);
check('empty command', ask(''), false);

// Replay 2026-10-08: деплой-слова в ТЕКСТЕ команды, которая сама ничего не
// деплоит, — сообщение коммита, тело issue, строка-значение. Кейсы — обезличенные
// формы реальных deny за месяц.
console.log('');
console.log('=== text is not a command: data-only mentions skip the guard ===');
const NL = '\n';
check('commit message via $(cat <<\'EOF\') with deploy lines', ask(
    'git commit -m "$(cat <<\'EOF\'' + NL + 'fix(hooks): mask text' + NL + NL
    + 'gcloud run deploy got --account in the scope; firebase deploy too' + NL
    + 'EOF' + NL + ')"'), false);
check('gh issue body via heredoc mentions gcloud deploy', ask(
    'gh issue create -R org/repo --title "Check costs" --body "$(cat <<\'EOF\'' + NL
    + '## Context' + NL + 'gcloud compute instances deploy-container moved; firebase deploy later' + NL
    + 'EOF' + NL + ')"'), false);
check('PowerShell: single-quoted row with | gsutil … publish', needsGuard(JSON.stringify({
    tool_name: 'PowerShell', tool_input: { command:
        '$f = "$env:USERPROFILE\\x.md"; $row = \'| 2026-09-18 | ~/.claude | gsutil -> gcloud storage, publish notes |\'; Add-Content -LiteralPath $f -Value $row' },
})), false);
check('PowerShell here-string commit message', needsGuard(JSON.stringify({
    tool_name: 'PowerShell', tool_input: { command:
        "git add -- docs/a.md && git commit -m @'" + NL + 'docs: gcp deployment record' + NL
        + 'firebase deploy and gcloud run deploy are described here' + NL + "'@" },
})), false);

console.log('');
console.log('=== ...but text that EXECUTES still reaches the guard ===');
check('bash -c "…"', ask('bash -c "firebase deploy"'), true);
check('sh -c \'…\' after a commit', ask('git commit -m "x" && sh -c \'firebase deploy\''), true);
check('"$(firebase deploy)" inside double quotes', ask('echo "result: $(firebase deploy)"'), true);
check('backticks inside double quotes', ask('echo "result: `firebase deploy`"'), true);
check('quoted verb argument: firebase "deploy"', ask('firebase "deploy"'), true);
check('heredoc piped into bash', ask('cat <<\'EOF\' | bash' + NL + 'firebase deploy' + NL + 'EOF'), true);
check('heredoc into a script that runs', ask('cat <<\'EOF\' > d.sh' + NL + 'firebase deploy' + NL + 'EOF' + NL + './d.sh'), true);
check('unquoted heredoc delimiter keeps body as code', ask('cat <<EOF' + NL + '$(firebase deploy)' + NL + 'EOF'), true);
check('eval "…"', ask('eval "firebase deploy"'), true);
check('git rebase --exec', ask('git rebase --exec "firebase deploy" HEAD~2'), true);
check('PowerShell iex', needsGuard(JSON.stringify({
    tool_name: 'PowerShell', tool_input: { command: "iex 'firebase deploy'" },
})), true);
check('PowerShell "$(…)" subexpression', needsGuard(JSON.stringify({
    tool_name: 'PowerShell', tool_input: { command: 'Write-Output "x $(firebase deploy)"' },
})), true);
check('commit then real deploy', ask('git commit -m "release notes" && firebase deploy'), true);
check('unterminated quote -> no masking', ask('echo "oops && firebase deploy'), true);

console.log('');
console.log('=== fail-safe: anything unclear reaches the guard ===');
check('unparseable stdin', needsGuard('{not json'), true);
check('missing tool_input', needsGuard(JSON.stringify({ tool_name: 'Bash' })), false);

console.log('');
console.log('=== CLAUDE_ALLOW_DEPLOY short-circuits, as the guard does ===');
process.env.CLAUDE_ALLOW_DEPLOY = '1';
check('deploy is skipped when the user allowed it', ask('firebase deploy'), false);
delete process.env.CLAUDE_ALLOW_DEPLOY;
check('and is checked again once unset', ask('firebase deploy'), true);

console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
