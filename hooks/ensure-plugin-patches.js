#!/usr/bin/env node
// SessionStart: keep local perf patches applied to installed third-party plugins.
// Runs inside hooks/session-start.js; standalone `node ensure-plugin-patches.js`
// works too. Replaces ensure-warp-perf-patch.js (2026-11-16).
//
// A plugin update overwrites plugins/cache wholesale, so every patch is
// re-applied on each session start. Each patch is idempotent and verifies its
// own target before writing.
//
//   warp       — the plugin's hooks spawn two bash processes and four-to-five jq
//                processes per fire. Measured (Windows 11, CLI 2.1.235):
//                PostToolUse 1,718 ms on every tool call, UserPromptSubmit
//                3,263 ms on every prompt. The patch (hooks/plugin-patches/
//                warp-perf/scripts) rebuilds the payload in one jq pass (515 /
//                364 ms) and gives every hook an explicit timeout. Upstream
//                proposal: warpdotdev/claude-code-warp#77. Only applied to
//                versions whose layout was diffed against the patch.
//   ast-index  — the plugin registers PreToolUse(Grep) -> bash + jq
//                grep-reminder.sh on every Grep call: 73 of 157 hook timeouts in
//                30 days (2026-10-17..11-16), and it answers `permissionDecision:
//                allow`, which skips the permission flow. The same Grep is judged
//                in-process by credentials-guard-prefilter.js (renderGrepDeny).
//                The patch removes that one entry from the plugin's hooks.json;
//                the edit/session hooks of the plugin stay as they are. Located
//                by command text, so it is version-agnostic.
//
// Output: silent on success. A one-line systemMessage only when a patch is
// left unapplied (unknown plugin version) or fails.
// Fail-open: any error exits 0. A patcher must never block a session.
//
// Env (tests): CLAUDE_PLUGIN_PATCHES_HOME — profile root instead of ~/.claude.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const WARP_PAYLOAD = path.join(__dirname, 'plugin-patches', 'warp-perf', 'scripts');

// Versions whose script layout was diffed against the patch.
// 2.3.0 (2026-10-08): against 2.1.0 only adds the agent_needs_input matcher,
//   on-stop-failure.sh (the patch ships its own) and a 120-char clip of the
//   notification message (notify.jq clips it too).
// 2.4.0 (2026-11-16): against 2.3.0 only on-stop.sh changed — two payload fields,
//   background_task_count and session_cron_count; notify.jq now emits both.
const WARP_KNOWN_VERSIONS = ['2.1.0', '2.2.0', '2.3.0', '2.4.0'];

// Notification-only hooks: cap them under each event's own ceiling.
const WARP_TIMEOUTS = {
    SessionStart: 15, Stop: 15, StopFailure: 15, Notification: 10,
    PermissionRequest: 10, UserPromptSubmit: 10, PostToolUse: 10,
};

// New files the patch introduces; everything else only replaces a script the
// target already has, so an older plugin without on-stop-failure.sh does not get
// a script no hook would ever call.
const WARP_ALWAYS = ['notify.jq', 'transcript.jq', 'emit.sh'];

const AST_INDEX_DROP = /grep-reminder\.sh/;

function claudeHome() {
    return process.env.CLAUDE_PLUGIN_PATCHES_HOME || path.join(os.homedir(), '.claude');
}

function versionDirs(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
        .map((v) => ({ version: v, dir: path.join(root, v) }))
        .filter((e) => fs.statSync(e.dir).isDirectory());
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ---- warp -------------------------------------------------------------------

// Keeps a copy of the untouched plugin directory the first time a version is
// patched, so there is something to roll back to.
function backupOnce(home, version, target) {
    const dest = path.join(home, 'patches', 'warp-perf', `.backup-${version}`);
    if (fs.existsSync(dest)) return;
    fs.cpSync(target, dest, { recursive: true });
}

// Adds the explicit timeouts without rewriting the file's structure, so a
// plugin version with a different set of events keeps its own entries.
function warpHooksJson(file) {
    const data = fs.existsSync(file) ? readJson(file) : null;
    if (!data || !data.hooks) return 0;
    let changed = false;
    for (const [event, groups] of Object.entries(data.hooks)) {
        const want = WARP_TIMEOUTS[event] || 10;
        for (const group of groups) {
            for (const hook of group.hooks || []) {
                if (hook.timeout !== want) {
                    hook.timeout = want;
                    changed = true;
                }
            }
        }
    }
    if (!changed) return 0;
    writeJson(file, data);
    return 1;
}

function patchWarp(home, messages) {
    const cacheRoot = path.join(home, 'plugins', 'cache', 'claude-code-warp', 'warp');
    if (!fs.existsSync(WARP_PAYLOAD)) return;
    for (const { version, dir: target } of versionDirs(cacheRoot)) {
        const scripts = path.join(target, 'scripts');
        if (!fs.existsSync(scripts)) continue;
        // Upstream merged it: the plugin ships its own single-pass filter.
        if (fs.existsSync(path.join(scripts, 'notify.jq'))
            && !fs.existsSync(path.join(scripts, '.warp-perf-patch'))) continue;
        if (!WARP_KNOWN_VERSIONS.includes(version)) {
            messages.push(`plugin-patches: warp ${version} не сверен с патчем — не применён `
                + '(hooks/ensure-plugin-patches.js, WARP_KNOWN_VERSIONS)');
            continue;
        }
        // What to install comes from the payload directory itself; a file added
        // there and forgotten in a list would otherwise never be copied.
        const pending = fs.readdirSync(WARP_PAYLOAD).filter((name) => {
            const dst = path.join(scripts, name);
            if (!WARP_ALWAYS.includes(name) && !fs.existsSync(dst)) return false;
            const want = fs.readFileSync(path.join(WARP_PAYLOAD, name));
            return !fs.existsSync(dst) || !fs.readFileSync(dst).equals(want);
        });
        let changed = 0;
        if (pending.length) {
            backupOnce(home, version, target);
            for (const name of pending) {
                fs.writeFileSync(path.join(scripts, name), fs.readFileSync(path.join(WARP_PAYLOAD, name)));
                changed++;
            }
        }
        changed += warpHooksJson(path.join(target, 'hooks', 'hooks.json'));
        if (changed > 0) {
            fs.writeFileSync(path.join(scripts, '.warp-perf-patch'), `applied to plugin ${version}\n`);
        }
    }
}

// ---- ast-index --------------------------------------------------------------

// Drops every hook whose command runs grep-reminder.sh, then the groups and the
// event key it leaves empty. Nothing else in the file changes.
function astIndexHooksJson(file) {
    const data = fs.existsSync(file) ? readJson(file) : null;
    if (!data || !data.hooks || !Array.isArray(data.hooks.PreToolUse)) return 0;
    let changed = false;
    const groups = [];
    for (const group of data.hooks.PreToolUse) {
        const hooks = Array.isArray(group.hooks) ? group.hooks : [];
        const kept = hooks.filter((h) => !AST_INDEX_DROP.test(String((h && h.command) || '')));
        if (kept.length !== hooks.length) changed = true;
        if (kept.length) groups.push(Object.assign({}, group, { hooks: kept }));
        else if (!hooks.length) groups.push(group);
    }
    if (!changed) return 0;
    if (groups.length) data.hooks.PreToolUse = groups;
    else delete data.hooks.PreToolUse;
    writeJson(file, data);
    return 1;
}

function patchAstIndex(home) {
    const cacheRoot = path.join(home, 'plugins', 'cache', 'ast-index-marketplace', 'ast-index');
    for (const { dir } of versionDirs(cacheRoot)) {
        astIndexHooksJson(path.join(dir, 'hooks', 'hooks.json'));
    }
}

// ---- entry ------------------------------------------------------------------

const PATCHES = [
    ['warp', patchWarp],
    ['ast-index', patchAstIndex],
];

// Returns the messages for the user; empty when everything is in place.
// One patch failing does not stop the next one.
function run(home) {
    const root = home || claudeHome();
    const messages = [];
    for (const [name, apply] of PATCHES) {
        try {
            apply(root, messages);
        } catch (e) {
            messages.push(`plugin-patches: ${name} не применён (${e && e.message}) — проверь латентность хуков плагина`);
        }
    }
    return messages;
}

if (require.main === module) {
    try {
        try { fs.readFileSync(0); } catch (e) { /* stdin is optional */ }
        const messages = run();
        if (messages.length) {
            process.stdout.write(JSON.stringify({ systemMessage: messages.join('\n') }) + '\n');
        }
    } catch (e) {
        // fail open
    }
    // process.exitCode, not process.exit(): on Windows a pipe write is async and
    // exit() can truncate it (see hooks/docs-length-guard.js).
    process.exitCode = 0;
}

module.exports = { run, astIndexHooksJson, warpHooksJson, WARP_KNOWN_VERSIONS };
