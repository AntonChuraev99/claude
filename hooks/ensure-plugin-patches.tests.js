#!/usr/bin/env node
// Tests for ensure-plugin-patches.js. Hermetic: synthetic plugin caches in a
// temp profile root (CLAUDE_PLUGIN_PATCHES_HOME); the live plugins/cache is only
// ever COPIED into a temp dir for the optional real-layout case.
//
// Usage: node hooks/ensure-plugin-patches.tests.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'ensure-plugin-patches.js');
const PAYLOAD = path.join(__dirname, 'plugin-patches', 'warp-perf', 'scripts');
const { run, astIndexHooksJson } = require('./ensure-plugin-patches.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  PASS ${name}`);
    } else {
        failed++;
        console.log(`  FAIL ${name}${detail ? `\n    ${detail}` : ''}`);
    }
}

const tmpRoots = [];
function tmp(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpRoots.push(d);
    return d;
}

const UNPATCHED_SCRIPTS = ['on-stop.sh', 'on-post-tool-use.sh', 'on-prompt-submit.sh', 'on-notification.sh',
    'on-permission-request.sh', 'on-session-start.sh', 'on-stop-failure.sh', 'emit-terminal-sequence.sh',
    'build-payload.sh', 'warp-notify.sh', 'should-use-structured.sh'];

function writeWarp(home, version, opts) {
    const dir = path.join(home, 'plugins', 'cache', 'claude-code-warp', 'warp', version);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    for (const s of UNPATCHED_SCRIPTS) fs.writeFileSync(path.join(dir, 'scripts', s), `#!/bin/bash\n# upstream ${s}\n`);
    if (opts && opts.upstreamMerged) fs.writeFileSync(path.join(dir, 'scripts', 'notify.jq'), '# upstream jq\n');
    const hooks = { hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.sh' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/on-post-tool-use.sh' }] }],
    } };
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(hooks, null, 2));
    return dir;
}

function writeAstIndex(home, version) {
    const dir = path.join(home, 'plugins', 'cache', 'ast-index-marketplace', 'ast-index', version, 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const hooks = { description: 'x', hooks: {
        PreToolUse: [{ matcher: 'Grep', hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/grep-reminder.sh', timeout: 5 }] }],
        PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/post-edit-update.sh', timeout: 20 }] }],
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash x/session-start-refresh.sh', async: true }] }],
    } };
    const file = path.join(dir, 'hooks.json');
    fs.writeFileSync(file, JSON.stringify(hooks, null, 2));
    return file;
}

const same = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

console.log('=== warp: known version gets the payload ===');
{
    const home = tmp('epp-');
    const dir = writeWarp(home, '2.4.0');
    const msgs = run(home);
    check('silent on success', msgs.length === 0, JSON.stringify(msgs));
    for (const f of fs.readdirSync(PAYLOAD)) {
        check(`payload ${f} installed`, same(path.join(PAYLOAD, f), path.join(dir, 'scripts', f)));
    }
    check('untouched upstream file stays', fs.readFileSync(path.join(dir, 'scripts', 'build-payload.sh'), 'utf8').includes('upstream'));
    check('marker written', fs.existsSync(path.join(dir, 'scripts', '.warp-perf-patch')));
    check('backup of the untouched plugin kept', fs.readFileSync(
        path.join(home, 'patches', 'warp-perf', '.backup-2.4.0', 'scripts', 'on-stop.sh'), 'utf8').includes('upstream'));
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
    check('Stop timeout 15', hooks.hooks.Stop[0].hooks[0].timeout === 15);
    check('PostToolUse timeout 10', hooks.hooks.PostToolUse[0].hooks[0].timeout === 10);

    // idempotent: a second pass writes nothing
    const before = fs.statSync(path.join(dir, 'hooks', 'hooks.json')).mtimeMs;
    const onStop = fs.statSync(path.join(dir, 'scripts', 'on-stop.sh')).mtimeMs;
    const again = run(home);
    check('second pass silent', again.length === 0);
    check('second pass leaves hooks.json alone', fs.statSync(path.join(dir, 'hooks', 'hooks.json')).mtimeMs === before);
    check('second pass leaves scripts alone', fs.statSync(path.join(dir, 'scripts', 'on-stop.sh')).mtimeMs === onStop);

    // plugin update overwrote the scripts -> re-applied, the old backup is not replaced
    fs.writeFileSync(path.join(dir, 'scripts', 'on-stop.sh'), '#!/bin/bash\n# upstream again\n');
    check('re-apply after update silent', run(home).length === 0);
    check('re-applied after update', same(path.join(PAYLOAD, 'on-stop.sh'), path.join(dir, 'scripts', 'on-stop.sh')));
    check('first backup kept (not overwritten by re-apply)', fs.readFileSync(
        path.join(home, 'patches', 'warp-perf', '.backup-2.4.0', 'scripts', 'on-stop.sh'), 'utf8').includes('# upstream on-stop.sh'));
}

console.log('=== warp: unknown version and upstream merge ===');
{
    const home = tmp('epp-');
    const dir = writeWarp(home, '9.9.9');
    const msgs = run(home);
    check('unknown version -> one message', msgs.length === 1 && /warp 9\.9\.9/.test(msgs[0]), JSON.stringify(msgs));
    check('unknown version -> short message', msgs[0].length < 160, String(msgs[0].length));
    check('unknown version -> scripts untouched', fs.readFileSync(path.join(dir, 'scripts', 'on-stop.sh'), 'utf8').includes('upstream'));
    check('unknown version -> no notify.jq', !fs.existsSync(path.join(dir, 'scripts', 'notify.jq')));

    const home2 = tmp('epp-');
    const merged = writeWarp(home2, '2.4.0', { upstreamMerged: true });
    check('upstream ships notify.jq -> silent', run(home2).length === 0);
    check('upstream ships notify.jq -> untouched', fs.readFileSync(path.join(merged, 'scripts', 'notify.jq'), 'utf8') === '# upstream jq\n');
}

console.log('=== ast-index: grep-reminder dropped, the rest kept ===');
{
    const home = tmp('epp-');
    const file = writeAstIndex(home, '3.56.0');
    check('silent on success', run(home).length === 0);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('PreToolUse grep-reminder removed', !data.hooks.PreToolUse);
    check('PostToolUse kept', data.hooks.PostToolUse[0].hooks[0].command.includes('post-edit-update.sh'));
    check('SessionStart kept', data.hooks.SessionStart[0].hooks[0].async === true);
    check('description kept', data.description === 'x');
    const mtime = fs.statSync(file).mtimeMs;
    run(home);
    check('second pass leaves hooks.json alone', fs.statSync(file).mtimeMs === mtime);

    // another PreToolUse hook in the same plugin survives
    const mixed = path.join(tmp('epp-'), 'hooks.json');
    fs.writeFileSync(mixed, JSON.stringify({ hooks: { PreToolUse: [
        { matcher: 'Grep', hooks: [{ command: 'bash grep-reminder.sh' }, { command: 'bash other.sh' }] },
        { matcher: 'Bash', hooks: [{ command: 'bash keep.sh' }] },
    ] } }));
    check('mixed group: reports a change', astIndexHooksJson(mixed) === 1);
    const m = JSON.parse(fs.readFileSync(mixed, 'utf8')).hooks.PreToolUse;
    check('mixed group: sibling hook kept', m.length === 2 && m[0].hooks.length === 1 && m[0].hooks[0].command === 'bash other.sh');
    check('mixed group: other matcher kept', m[1].hooks[0].command === 'bash keep.sh');
    check('broken hooks.json -> no change, no throw', (() => {
        const bad = path.join(tmp('epp-'), 'hooks.json');
        fs.writeFileSync(bad, '{ not json');
        return astIndexHooksJson(bad) === 0;
    })());
}

console.log('=== no plugins installed / standalone run ===');
{
    const home = tmp('epp-');
    check('empty profile -> silent', run(home).length === 0);
    const r = spawnSync(process.execPath, [HOOK], { input: '{}', encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_PATCHES_HOME: home }) });
    check('standalone: exit 0, no output', r.status === 0 && r.stdout === '', `${r.status} ${r.stdout}`);
    writeWarp(home, '9.9.9');
    const r2 = spawnSync(process.execPath, [HOOK], { input: '{}', encoding: 'utf8',
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_PATCHES_HOME: home }) });
    let parsed = null;
    try { parsed = JSON.parse(r2.stdout); } catch (e) { /* checked below */ }
    check('standalone: unknown version -> systemMessage JSON', parsed && /9\.9\.9/.test(parsed.systemMessage), r2.stdout);
}

console.log('=== patched notify.jq: stop payload carries the 2.4.0 fields ===');
{
    const jq = spawnSync('jq', ['--version'], { encoding: 'utf8' });
    if (jq.status !== 0) {
        console.log('  SKIP jq not in PATH');
    } else {
        const input = JSON.stringify({ session_id: 's', cwd: '/tmp/proj', transcript_path: '/t.jsonl',
            background_tasks: [{ id: 1 }, { id: 2 }], session_crons: [] });
        const r = spawnSync('jq', ['-r', '--argjson', 'v', '1', '--arg', 'event', 'stop', '--argjson', 'wrap', 'false',
            '--arg', 'query', 'q', '--arg', 'response', 'r', '-f', path.join(PAYLOAD, 'notify.jq')], { input, encoding: 'utf8' });
        const m = (r.stdout || '').match(/warp:\/\/cli-agent;(\{.*\})/);
        let p = null;
        try { p = m && JSON.parse(m[1]); } catch (e) { /* checked below */ }
        check('stop: background_task_count = 2', p && p.background_task_count === 2, r.stdout + r.stderr);
        check('stop: session_cron_count = 0', p && p.session_cron_count === 0);
        check('stop: query/response kept', p && p.query === 'q' && p.response === 'r');
        const r2 = spawnSync('jq', ['-r', '--argjson', 'v', '1', '--arg', 'event', 'stop', '--argjson', 'wrap', 'false',
            '-f', path.join(PAYLOAD, 'notify.jq')], { input: '{"session_id":"s"}', encoding: 'utf8' });
        const m2 = (r2.stdout || '').match(/warp:\/\/cli-agent;(\{.*\})/);
        let p2 = null;
        try { p2 = m2 && JSON.parse(m2[1]); } catch (e) { /* checked below */ }
        check('stop without the arrays: counts default to 0', p2 && p2.background_task_count === 0 && p2.session_cron_count === 0, r2.stdout + r2.stderr);
    }
}

console.log('=== optional: real installed layout, on a COPY ===');
{
    const live = path.join(os.homedir(), '.claude', 'plugins', 'cache');
    const warpLive = path.join(live, 'claude-code-warp', 'warp');
    const astLive = path.join(live, 'ast-index-marketplace', 'ast-index');
    if (!fs.existsSync(warpLive) && !fs.existsSync(astLive)) {
        console.log('  SKIP no installed plugins');
    } else {
        const home = tmp('epp-live-');
        for (const [src, rel] of [[warpLive, 'claude-code-warp/warp'], [astLive, 'ast-index-marketplace/ast-index']]) {
            if (!fs.existsSync(src)) continue;
            const dst = path.join(home, 'plugins', 'cache', ...rel.split('/'));
            fs.cpSync(src, dst, { recursive: true, filter: (s) => !/[\\/]\.in_use([\\/]|$)/.test(s) });
        }
        const msgs = run(home);
        const versions = fs.existsSync(path.join(home, 'plugins', 'cache', 'claude-code-warp', 'warp'))
            ? fs.readdirSync(path.join(home, 'plugins', 'cache', 'claude-code-warp', 'warp')) : [];
        console.log(`  info: warp versions ${versions.join(', ') || '-'}; messages: ${JSON.stringify(msgs)}`);
        check('real layout: no failure message', !msgs.some((m) => /не применён \(/.test(m)), JSON.stringify(msgs));
        for (const v of fs.existsSync(path.join(home, 'plugins', 'cache', 'ast-index-marketplace', 'ast-index'))
            ? fs.readdirSync(path.join(home, 'plugins', 'cache', 'ast-index-marketplace', 'ast-index')) : []) {
            const hj = path.join(home, 'plugins', 'cache', 'ast-index-marketplace', 'ast-index', v, 'hooks', 'hooks.json');
            if (!fs.existsSync(hj)) continue;
            check(`real ast-index ${v}: grep-reminder gone`, !fs.readFileSync(hj, 'utf8').includes('grep-reminder.sh'));
        }
        check('real layout: second pass silent', run(home).length === msgs.length);
    }
}

for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
