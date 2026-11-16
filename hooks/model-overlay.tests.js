#!/usr/bin/env node
// Suite for model-overlay.js. Ported case-for-case from model-overlay.tests.ps1 (2026-11-16)
// plus the per-session / per-cwd cache of issue #71.
// Dependency-free: spawns the hook with piped stdin, asserts on JSON stdout. Overlay dir and
// cache are redirected (CLAUDE_MODEL_OVERLAY_DIR / CLAUDE_MODEL_OVERLAY_STATE), so the suite
// never touches the real ~/.claude/model-overlays or the profile cache.
//
// Contract: fable* -> fable.md ; *opus-5-5* -> opus-5-5.md ; *opus-5* -> opus-5.md ; any other
// known id (opus 4.x, sonnet, haiku) -> opus.md. A present model id is cached; absent / empty /
// malformed model -> the cached id (SessionStart on /clear carries no model), no cache ->
// opus-5-5.md (newest). Any missing overlay file -> opus.md; opus.md missing -> silent.
// Run: node hooks/model-overlay.tests.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = process.argv.includes('--hook')
    ? path.resolve(process.argv[process.argv.indexOf('--hook') + 1])
    : path.join(__dirname, 'model-overlay.js');

let pass = 0;
let fail = 0;
function eq(expected, actual, name) {
    if (expected === actual) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n        expected: [${expected}]\n        actual:   [${actual}]`); }
}

const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'mov-fx-'));
const put = (name, text) => fs.writeFileSync(path.join(fx, name), text);
put('opus.md', 'OPUS_SENTINEL');
put('fable.md', 'FABLE_SENTINEL');
put('opus-5.md', 'OPUS5_SENTINEL');
put('opus-5-5.md', 'OPUS55_SENTINEL');
const stateDir = path.join(fx, 'state');
const state = path.join(stateDir, 'last-model.txt');

// every call starts with an empty model cache unless keep (cache scenarios)
function invoke(json, keep) {
    if (!keep) fs.rmSync(stateDir, { recursive: true, force: true });
    const env = Object.assign({}, process.env, { CLAUDE_MODEL_OVERLAY_DIR: fx, CLAUDE_MODEL_OVERLAY_STATE: state });
    const r = spawnSync(process.execPath, [HOOK], { input: json, encoding: 'utf8', env });
    return (r.stdout || '').trim();
}
function out(json, keep) {
    const s = invoke(json, keep);
    if (!s) return null;
    try { return JSON.parse(s).hookSpecificOutput; } catch (e) { return null; }
}
const ctx = (json, keep) => { const o = out(json, keep); return o ? o.additionalContext : null; };

console.log('model-overlay — suite');

// happy path
eq('OPUS_SENTINEL', ctx('{"model":"claude-opus-4-8[1m]"}'), 'opus 4.8 id -> opus.md');
eq('FABLE_SENTINEL', ctx('{"model":"claude-fable-5"}'), 'fable id -> fable.md');
eq('OPUS5_SENTINEL', ctx('{"model":"claude-opus-5"}'), 'opus 5 id -> opus-5.md');
eq('OPUS5_SENTINEL', ctx('{"model":"claude-opus-5[1m]"}'), 'opus 5 [1m] id -> opus-5.md');
eq('OPUS55_SENTINEL', ctx('{"model":"claude-opus-5-5"}'), 'opus 5.5 id -> opus-5-5.md');
eq('OPUS55_SENTINEL', ctx('{"model":"claude-opus-5-5[1m]"}'), 'opus 5.5 [1m] id -> opus-5-5.md (not opus-5.md)');

// regression: 4.x ids must NOT be swallowed by the *opus-5* pattern
eq('OPUS_SENTINEL', ctx('{"model":"claude-opus-4-5"}'), 'opus 4.5 -> opus.md (not opus-5.md)');
eq('OPUS_SENTINEL', ctx('{"model":"claude-opus-4-5-20251101"}'), 'opus 4.5 dated -> opus.md');

// known non-opus-5 id (sonnet / haiku) -> opus.md
eq('OPUS_SENTINEL', ctx('{"model":"claude-sonnet-5"}'), 'sonnet -> opus.md');
eq('OPUS_SENTINEL', ctx('{"model":"claude-haiku-4-5"}'), 'haiku -> opus.md');

// absent / empty / null model, no cache -> newest overlay (opus-5-5.md)
eq('OPUS55_SENTINEL', ctx('{"source":"clear"}'), 'no model, no cache -> opus-5-5.md');
eq('OPUS55_SENTINEL', ctx('{"model":""}'), 'empty model, no cache -> opus-5-5.md');
eq('OPUS55_SENTINEL', ctx('{"model":null}'), 'null model, no cache -> opus-5-5.md');

// cache: present model is remembered and reused when a later payload has none (/clear, /compact)
invoke('{"model":"claude-opus-4-8"}');
eq('OPUS_SENTINEL', ctx('{"source":"clear"}', true), 'cached opus 4.8 + no model -> opus.md');
invoke('{"model":"claude-fable-5"}');
eq('FABLE_SENTINEL', ctx('{"source":"compact"}', true), 'cached fable + no model -> fable.md');
eq('OPUS5_SENTINEL', ctx('{"model":"claude-opus-5"}', true), 'present model wins over cache');
eq('OPUS5_SENTINEL', ctx('{"source":"clear"}', true), 'cache updated by latest present model');

// edge: case-insensitive + substring (bedrock-style arn)
eq('OPUS_SENTINEL', ctx('{"model":"CLAUDE-OPUS-4-8"}'), 'uppercase OPUS -> opus.md');
eq('FABLE_SENTINEL', ctx('{"model":"US.ANTHROPIC.CLAUDE-FABLE-5-V1"}'), 'bedrock fable arn (uppercase) -> fable.md');
eq('OPUS5_SENTINEL', ctx('{"model":"US.ANTHROPIC.CLAUDE-OPUS-5"}'), 'bedrock opus 5 arn (uppercase) -> opus-5.md');

// error: malformed / empty stdin -> treated as absent model, never crash
eq('OPUS55_SENTINEL', ctx('not json at all'), 'malformed stdin, no cache -> opus-5-5.md');
eq('OPUS55_SENTINEL', ctx(''), 'empty stdin, no cache -> opus-5-5.md');

// output shape
eq('SessionStart', (out('{"model":"claude-opus-4-8"}') || {}).hookEventName, 'output hookEventName = SessionStart');

// PostModelSwitch: to_model picks the overlay, output tagged PostModelSwitch, cache follows the
// switch; same-overlay switch stays silent (once per change).
const sw = out('{"hook_event_name":"PostModelSwitch","from_model":"claude-opus-5-5","to_model":"claude-fable-5","source":"command"}');
eq('FABLE_SENTINEL', sw && sw.additionalContext, 'switch opus-5-5 -> fable: fable.md injected');
eq('PostModelSwitch', sw && sw.hookEventName, 'switch output hookEventName = PostModelSwitch');
eq('FABLE_SENTINEL', ctx('{"source":"clear"}', true), 'after switch to fable, /clear reuses fable (cache updated)');
eq('', invoke('{"hook_event_name":"PostModelSwitch","from_model":"claude-opus-5-5","to_model":"claude-opus-5-5[1m]","source":"command"}'), 'switch within one overlay family -> silent');
eq('OPUS55_SENTINEL', ctx('{"source":"clear"}', true), 'silent switch still updates the cache');
invoke('{"model":"claude-opus-5-5"}');
eq('', invoke('{"hook_event_name":"PostModelSwitch","from_model":"claude-opus-5-5"}', true), 'switch payload without to_model -> silent');

// #71: parallel sessions of one profile. B (other cwd, Opus 4.8) writes last; A runs /clear.
invoke('{"model":"claude-opus-5-5","session_id":"A","cwd":"C:\\\\proj\\\\a"}');
invoke('{"model":"claude-opus-4-8","session_id":"B","cwd":"C:\\\\proj\\\\b"}', true);
eq('OPUS55_SENTINEL', ctx('{"source":"clear","session_id":"A2","cwd":"C:\\\\proj\\\\a"}', true), '#71 /clear with a new session id: own cwd wins over another session');
eq('OPUS55_SENTINEL', ctx('{"source":"clear","session_id":"A","cwd":"C:/PROJ/A/"}', true), '#71 /clear keeping the session id: session key wins; cwd normalised');
eq('OPUS_SENTINEL', ctx('{"source":"clear","session_id":"Z","cwd":"C:\\\\proj\\\\z"}', true), '#71 unknown session and cwd -> profile cache (last writer)');
invoke('{"hook_event_name":"PostModelSwitch","from_model":"claude-opus-5-5","to_model":"claude-fable-5","session_id":"A","cwd":"C:\\\\proj\\\\a"}', true);
eq('FABLE_SENTINEL', ctx('{"source":"clear","session_id":"A3","cwd":"C:\\\\proj\\\\a"}', true), '#71 switch updates the cwd cache too');
eq('OPUS_SENTINEL', ctx('{"source":"clear","session_id":"B2","cwd":"C:\\\\proj\\\\b"}', true), '#71 the other session keeps its own model');

// SubagentStart: every subagent gets subagent.md, never the main-session overlay, and the event
// must not touch the main session's model cache.
put('subagent.md', 'SUBAGENT_SENTINEL');
invoke('{"model":"claude-fable-5"}');
const sa = out('{"hook_event_name":"SubagentStart","agent_type":"core-expert","agent_id":"a1"}', true);
eq('SUBAGENT_SENTINEL', sa && sa.additionalContext, 'SubagentStart -> subagent.md');
eq('SubagentStart', sa && sa.hookEventName, 'subagent output hookEventName = SubagentStart');
eq('FABLE_SENTINEL', ctx('{"source":"clear"}', true), 'SubagentStart leaves the model cache untouched');
fs.unlinkSync(path.join(fx, 'subagent.md'));
eq('', invoke('{"hook_event_name":"SubagentStart","agent_type":"core-expert"}'), 'subagent.md missing -> silent (no main overlay fallback)');

// fallback: fable.md / opus-5.md missing -> opus.md
fs.unlinkSync(path.join(fx, 'fable.md'));
eq('OPUS_SENTINEL', ctx('{"model":"claude-fable-5"}'), 'fable.md missing -> opus.md (fallback)');
fs.unlinkSync(path.join(fx, 'opus-5.md'));
eq('OPUS_SENTINEL', ctx('{"model":"claude-opus-5"}'), 'opus-5.md missing -> opus.md (fallback)');
fs.unlinkSync(path.join(fx, 'opus-5-5.md'));
eq('OPUS_SENTINEL', ctx('{"model":"claude-opus-5-5"}'), 'opus-5-5.md missing -> opus.md (fallback)');
eq('OPUS_SENTINEL', ctx('{"source":"clear"}'), 'no model + opus-5-5.md missing -> opus.md');

// fallback: opus.md (the fallback itself) also gone -> empty stdout (never crash)
fs.unlinkSync(path.join(fx, 'opus.md'));
eq('', invoke('{"model":"claude-opus-4-8"}'), 'all overlays gone -> empty stdout');

fs.rmSync(fx, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
