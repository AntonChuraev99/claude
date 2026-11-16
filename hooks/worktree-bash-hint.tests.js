#!/usr/bin/env node
// Tests for worktree-bash-hint.js.
//
// Pin: подсказка приходит на EnterWorktree и на старт сессии или субагента
// внутри .claude/worktrees/<name> (оба разделителя пути); обычный checkout,
// сам каталог worktrees без имени и чужие тулы — тишина.
//
// Usage: node hooks/worktree-bash-hint.tests.js

const { evaluate, HINT } = require('./worktree-bash-hint.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    if (actual === expected) {
        console.log(`  PASS ${name}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}`);
        console.log(`    expected: ${expected}`);
        console.log(`    actual:   ${actual}`);
        failed++;
    }
}

const hinted = (payload) => evaluate(payload) === HINT;

console.log('=== EnterWorktree ===');
check('PostToolUse EnterWorktree hints', hinted({ hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree' }), true);
check('PostToolUse Bash silent', hinted({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), false);

console.log('=== start inside a worktree ===');
const winWt = 'C:\\Users\\Someone\\proj\\.claude\\worktrees\\fix-x';
const posixWt = '/c/Users/Someone/proj/.claude/worktrees/fix-x/web';
check('SessionStart windows path hints', hinted({ hook_event_name: 'SessionStart', cwd: winWt }), true);
check('SubagentStart posix subdir hints', hinted({ hook_event_name: 'SubagentStart', cwd: posixWt }), true);

console.log('=== silence elsewhere ===');
check('SessionStart main checkout silent', hinted({ hook_event_name: 'SessionStart', cwd: 'C:\\Users\\Someone\\proj' }), false);
check('SubagentStart bare worktrees dir silent', hinted({ hook_event_name: 'SubagentStart', cwd: 'C:\\proj\\.claude\\worktrees' }), false);
check('SessionStart without cwd silent', hinted({ hook_event_name: 'SessionStart' }), false);
check('unknown event silent', hinted({ hook_event_name: 'Stop', cwd: winWt }), false);
check('null payload silent', hinted(null), false);

// --- main-repo write guard (ported from ensure-worktree-guard.ps1) ---------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureWorktreeGuard, run } = require('./worktree-bash-hint.js');

const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'wbh-'));
const repo = path.join(fx, 'repo');
const wt = path.join(repo, '.claude', 'worktrees', 'fix-y');
fs.mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(wt, { recursive: true });
fs.writeFileSync(path.join(repo, '.claude', 'hooks', 'guard-main-repo-edit.ps1'), '# stub');
const settingsPath = path.join(wt, '.claude', 'settings.local.json');
const registered = () => fs.existsSync(settingsPath)
    && JSON.stringify(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse).includes('guard-main-repo-edit');

console.log('=== worktree guard: SessionStart inside a worktree ===');
let r = run({ hook_event_name: 'SessionStart', cwd: path.join(wt, 'app') });
check('registers the guard', registered(), true);
check('tells the user', /worktree guard/.test((r && r.systemMessage) || ''), true);
check('context carries hint and guard note', Boolean(r && r.context.includes(HINT) && r.context.includes('worktree-guard: registered')), true);
const entry = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0];
check('entry shape: matcher', entry.matcher, 'Edit|Write|MultiEdit');
check('entry shape: powershell shell + script path', entry.hooks[0].shell === 'powershell' && entry.hooks[0].command.includes('guard-main-repo-edit.ps1'), true);
r = run({ hook_event_name: 'SessionStart', cwd: wt });
check('second start: no re-registration', ensureWorktreeGuard({ hook_event_name: 'SessionStart', cwd: wt }), null);
check('second start: hint only, silent screen', Boolean(r && r.context === HINT && !r.systemMessage), true);

console.log('=== worktree guard: other keys kept, EnterWorktree mid-session ===');
fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }));
ensureWorktreeGuard({ hook_event_name: 'SessionStart', cwd: wt });
const kept = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
check('permissions kept', kept.permissions.allow[0], 'Bash');
check('existing PreToolUse kept, guard appended', kept.hooks.PreToolUse.length === 2 && kept.hooks.PreToolUse[0].matcher === 'Bash', true);
fs.unlinkSync(settingsPath);
const enter = { hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree', cwd: repo,
    tool_response: `Created worktree at ${wt} on branch fix-y. The session is now working in the worktree.` };
r = run(enter);
check('EnterWorktree: guard not registered mid-session (SessionStart only)', fs.existsSync(settingsPath), false);
check('EnterWorktree: hint still sent', Boolean(r && r.context.startsWith(HINT)), true);
const cli = spawnSync(process.execPath, [path.join(__dirname, 'worktree-bash-hint.js')], { input: JSON.stringify(enter), encoding: 'utf8' });
check('standalone EnterWorktree output tagged PostToolUse', JSON.parse(cli.stdout).hookSpecificOutput.hookEventName, 'PostToolUse');

console.log('=== worktree guard: no-ops ===');
if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
check('SubagentStart never registers', ensureWorktreeGuard({ hook_event_name: 'SubagentStart', cwd: wt }), null);
check('main checkout -> null', ensureWorktreeGuard({ hook_event_name: 'SessionStart', cwd: repo }), null);
fs.unlinkSync(path.join(repo, '.claude', 'hooks', 'guard-main-repo-edit.ps1'));
check('repo without the guard script -> null', ensureWorktreeGuard({ hook_event_name: 'SessionStart', cwd: wt }), null);
fs.writeFileSync(path.join(repo, '.claude', 'hooks', 'guard-main-repo-edit.ps1'), '# stub');
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, '{ broken');
r = run({ hook_event_name: 'SessionStart', cwd: wt });
check('malformed settings.local.json: fail open, hint still sent', Boolean(r && r.context === HINT), true);
check('malformed settings.local.json left as is', fs.readFileSync(settingsPath, 'utf8'), '{ broken');
const silent = spawnSync(process.execPath, [path.join(__dirname, 'worktree-bash-hint.js')], { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: repo }), encoding: 'utf8' });
check('standalone main checkout -> no output', silent.stdout, '');
fs.rmSync(fx, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
