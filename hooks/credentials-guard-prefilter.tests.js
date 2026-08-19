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
check('gsutil rm -r', ask('gsutil rm -r gs://bucket/path'), true);
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
check('empty command', ask(''), false);

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
