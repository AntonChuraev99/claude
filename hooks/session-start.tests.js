#!/usr/bin/env node
// Tests for session-start.js: the merged start process carries every part the
// separate hooks used to print, and one failing module does not silence the rest.
// Hermetic: overlay dir, model cache, plugin cache and profile root are temp fixtures.
// Usage: node hooks/session-start.tests.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'session-start.js');
const { HINT } = require('./worktree-bash-hint.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? `\n    ${String(detail).slice(0, 500)}` : ''}`); }
}

const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const overlays = path.join(fx, 'overlays');
fs.mkdirSync(overlays);
fs.writeFileSync(path.join(overlays, 'opus-5-5.md'), 'OPUS55');
fs.writeFileSync(path.join(overlays, 'opus.md'), 'OPUS');
fs.writeFileSync(path.join(overlays, 'subagent.md'), 'SUBAGENT');
const plugins = path.join(fx, 'plugins-home');
fs.mkdirSync(plugins);
const profile = path.join(fx, 'profile');
fs.mkdirSync(path.join(profile, 'hooks'), { recursive: true });
fs.writeFileSync(path.join(profile, 'hooks', 'bash-tool-discipline.js'), '// stub');
const goodSettings = { hooks: { PreToolUse: [{ matcher: 'Bash|Grep', hooks: [{ command: 'node credentials-guard-prefilter.js' }] }] } };
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(goodSettings));

const env = Object.assign({}, process.env, {
    CLAUDE_MODEL_OVERLAY_DIR: overlays,
    CLAUDE_MODEL_OVERLAY_STATE: path.join(fx, 'state', 'last.txt'),
    CLAUDE_PLUGIN_PATCHES_HOME: plugins,
    CLAUDE_HOME: profile,
});
function invoke(payload) {
    const r = spawnSync(process.execPath, [HOOK], { input: payload === '' ? '' : JSON.stringify(payload), encoding: 'utf8', env });
    const s = (r.stdout || '').trim();
    return { status: r.status, raw: s, json: s ? JSON.parse(s) : null };
}
const wt = 'C:\\proj\\.claude\\worktrees\\fix-x';

console.log('=== SessionStart ===');
let r = invoke({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5', cwd: wt });
check('exit 0', r.status === 0);
check('event SessionStart', r.json && r.json.hookSpecificOutput.hookEventName === 'SessionStart');
check('context = overlay, blank line, worktree hint', r.json && r.json.hookSpecificOutput.additionalContext === `OPUS55\n\n${HINT}`, r.raw);
check('nothing for the screen when all is well', r.json && !r.json.systemMessage, r.raw);
r = invoke({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-4-8', cwd: 'C:\\proj' });
check('main checkout: overlay only', r.json && r.json.hookSpecificOutput.additionalContext === 'OPUS', r.raw);
r = invoke('');
check('empty stdin: model from the profile cache (last start was opus-4-8)', r.json && r.json.hookSpecificOutput.additionalContext === 'OPUS', r.raw);

console.log('=== screen parts: plugin patch and bash-discipline ===');
const warp = path.join(plugins, 'plugins', 'cache', 'claude-code-warp', 'warp', '9.9.9', 'scripts');
fs.mkdirSync(warp, { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
r = invoke({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5', cwd: 'C:\\proj' });
check('unknown plugin version reaches the screen', r.json && /warp 9\.9\.9/.test(r.json.systemMessage || ''), r.raw);
check('bash-discipline breakage reaches the screen', r.json && /bash-discipline/.test(r.json.systemMessage || ''), r.raw);
check('bash-discipline context follows the overlay', r.json && /^OPUS55\n\nbash-discipline assertion failed/.test(r.json.hookSpecificOutput.additionalContext), r.raw);
check('suppressOutput with a screen part', r.json && r.json.suppressOutput === true);

console.log('=== SubagentStart ===');
r = invoke({ hook_event_name: 'SubagentStart', agent_type: 'x', cwd: wt });
check('subagent: subagent.md + hint', r.json && r.json.hookSpecificOutput.additionalContext === `SUBAGENT\n\n${HINT}`, r.raw);
check('subagent: event SubagentStart', r.json && r.json.hookSpecificOutput.hookEventName === 'SubagentStart');
check('subagent: start-only checks do not run (no screen)', r.json && !r.json.systemMessage, r.raw);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(goodSettings));
fs.rmSync(path.join(plugins, 'plugins'), { recursive: true, force: true });

console.log('=== one module throwing does not silence the rest ===');
{
    const pp = require('./ensure-plugin-patches.js');
    const mo = require('./model-overlay.js');
    const origRun = pp.run;
    const origEval = mo.safeEvaluate;
    pp.run = () => { throw new Error('boom'); };
    mo.safeEvaluate = () => { throw new Error('boom'); };
    process.env.CLAUDE_HOME = profile;
    const { collect, render } = require('./session-start.js');
    const out = JSON.parse(render(collect({ hook_event_name: 'SessionStart', cwd: wt })));
    check('hint survives two throwing modules', out.hookSpecificOutput.additionalContext === HINT, JSON.stringify(out));
    pp.run = origRun;
    mo.safeEvaluate = origEval;
}

fs.rmSync(fx, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
