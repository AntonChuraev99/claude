#!/usr/bin/env node
// SessionStart hook: keep the local perf patch applied to the installed warp plugin.
//
// Why this exists: the warp plugin's hooks each spawn two bash processes and
// four-to-five jq processes per fire. Measured here (Windows 11, Claude Code
// 2.1.235): PostToolUse 1,718 ms on every tool call, UserPromptSubmit 3,263 ms
// on every prompt -- and UserPromptSubmit's ceiling is 30 s, which a loaded
// machine reaches, producing "hook timed out after 30s". The patch rebuilds the
// payload in a single jq pass (515 ms / 364 ms) and gives every hook an explicit
// timeout. It is upstream at warpdotdev/claude-code-warp (issue #77); this hook
// only bridges the gap until a release carries it.
//
// A plugin update overwrites plugins/cache wholesale, so the patch has to be
// re-applied. That is all this does -- and it deliberately does nothing when it
// cannot be sure the patch still fits:
//
//   - target already has notify.jq  -> upstream shipped it, stand down
//   - plugin version not in KNOWN   -> unverified layout, report and stand down
//
// Fail-open: any error exits 0. A patcher must never block a session.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Versions whose script layout this patch was verified against.
const KNOWN_VERSIONS = ['2.1.0', '2.2.0'];

// Notification-only hooks: cap them under each event's own ceiling.
const TIMEOUTS = {
    SessionStart: 15, Stop: 15, StopFailure: 15, Notification: 10,
    PermissionRequest: 10, UserPromptSubmit: 10, PostToolUse: 10,
};

// The file list comes from the patch directory itself. These three are new
// files the patch introduces; everything else only replaces a script the
// target already has, so an older plugin without on-stop-failure.sh does not
// get a script no hook would ever call.
const ALWAYS = ['notify.jq', 'transcript.jq', 'emit.sh'];

// Messages are collected, not printed: the loop can visit several plugin
// versions (an update leaves the old directory around for a while), and two
// JSON objects on stdout are not valid hook output.
const messages = [];
function log(msg) {
    messages.push(msg);
}

// Keeps a copy of the untouched plugin directory the first time a version is
// patched, so there is something to roll back to.
function backupOnce(claudeDir, version, target) {
    const dest = path.join(claudeDir, 'patches', 'warp-perf', `.backup-${version}`);
    if (fs.existsSync(dest)) return;
    try {
        fs.cpSync(target, dest, { recursive: true });
    } catch (e) {
        log(`warp-perf-patch: не удалось сохранить резервную копию плагина ${version} (${e.message}) — `
            + 'патч не применялся, откатывать нечем.');
        throw e;
    }
}

function main() {
    const claudeDir = path.join(os.homedir(), '.claude');
    const patchDir = path.join(claudeDir, 'patches', 'warp-perf', 'scripts');
    const cacheRoot = path.join(claudeDir, 'plugins', 'cache', 'claude-code-warp', 'warp');

    if (!fs.existsSync(patchDir) || !fs.existsSync(cacheRoot)) return;

    for (const version of fs.readdirSync(cacheRoot)) {
        const target = path.join(cacheRoot, version);
        const scripts = path.join(target, 'scripts');
        if (!fs.statSync(target).isDirectory() || !fs.existsSync(scripts)) continue;

        // Upstream merged it: the plugin ships its own single-pass filter.
        if (fs.existsSync(path.join(scripts, 'notify.jq'))
            && !fs.existsSync(path.join(scripts, '.warp-perf-patch'))) {
            continue;
        }

        if (!KNOWN_VERSIONS.includes(version)) {
            log(`warp-perf-patch: plugin ${version} is not among the versions this patch was `
                + `verified against (${KNOWN_VERSIONS.join(', ')}). Left unpatched — re-verify `
                + `~/.claude/patches/warp-perf against the new layout, or drop it if upstream `
                + `merged warpdotdev/claude-code-warp#77.`);
            continue;
        }

        // What to install comes from the patch directory itself; only the
        // exceptions are hand-maintained. A file added to the patch and
        // forgotten in a list would otherwise never be copied, silently.
        const payload = fs.readdirSync(patchDir);
        const pending = payload.filter((name) => {
            const dst = path.join(scripts, name);
            // Files that only replace an existing script: an older plugin has
            // no on-stop-failure.sh, and adding one would register nothing.
            if (!ALWAYS.includes(name) && !fs.existsSync(dst)) return false;
            const want = fs.readFileSync(path.join(patchDir, name));
            return !fs.existsSync(dst) || !fs.readFileSync(dst).equals(want);
        });

        let changed = 0;
        if (pending.length) {
            backupOnce(claudeDir, version, target);
            for (const name of pending) {
                fs.writeFileSync(path.join(scripts, name), fs.readFileSync(path.join(patchDir, name)));
                changed++;
            }
        }

        changed += patchHooksJson(path.join(target, 'hooks', 'hooks.json'));

        if (changed > 0) {
            fs.writeFileSync(path.join(scripts, '.warp-perf-patch'),
                `applied to plugin ${version}\n`);
            log(`warp-perf-patch: re-applied to warp plugin ${version} (${changed} file(s)) — `
                + `a plugin update had reverted it.`);
        }
    }
}

// Adds the explicit timeouts without rewriting the file's structure, so a
// plugin version with a different set of events keeps its own entries.
function patchHooksJson(file) {
    if (!fs.existsSync(file)) return 0;
    const text = fs.readFileSync(file, 'utf8');
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return 0;
    }
    if (!data.hooks) return 0;

    let changed = false;
    for (const [event, groups] of Object.entries(data.hooks)) {
        const want = TIMEOUTS[event] || 10;
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
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    return 1;
}

try {
    main();
} catch (e) {
    // Fail open, but not in silence: if the patch stops being applied, hook
    // latency quietly returns to seconds per tool call and the timeout with it.
    log(`warp-perf-patch: не отработал (${e && e.message}) — плагин warp мог вернуться `
        + 'к непропатченным скриптам, проверь латентность хуков.');
}

if (messages.length) {
    process.stdout.write(JSON.stringify({ systemMessage: messages.join(' | ') }) + '\n');
}
// process.exitCode, not process.exit(): see hooks/docs-length-guard.js — on
// Windows the pipe write is async and exit() can truncate it.
process.exitCode = 0;
