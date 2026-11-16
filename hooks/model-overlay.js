#!/usr/bin/env node
// model-overlay.js — SessionStart + PostModelSwitch + SubagentStart: injects a behavioral overlay.
// Port of model-overlay.ps1 (2026-11-16): same routing, no pwsh start (0.32–0.35 s idle).
// On SessionStart/SubagentStart it runs inside hooks/session-start.js; PostModelSwitch
// registers this file directly.
//
// SubagentStart -> subagent.md for every subagent (model-neutral; payload carries no model).
// Reads the active model from the hook's stdin JSON — ground truth from the runtime, NOT the
// model's self-report — and returns the matching overlay file as additionalContext.
//   fable*     -> fable.md
//   *opus-5-5* -> opus-5-5.md
//   *opus-5*   -> opus-5.md
//   else       -> opus.md  (Opus 4.x overlay AND the fallback when a picked file is missing)
// Events:
//   SessionStart    -> `.model`. On /clear (and possibly /compact) the payload carries NO model:
//                      the last known model id is read from the cache; no cache -> newest
//                      overlay (opus-5-5.md).
//   SubagentStart   -> subagent.md, no model routing, no cache write.
//   PostModelSwitch -> `.to_model` / `.from_model` (CLI >= 2.1.251). The overlay is sent once per
//                      switch and only when the switch changes the overlay file; the cache always
//                      follows to_model so a later /clear picks the right overlay.
//
// Model cache (issue #71). One file per profile was shared by every parallel session of that
// profile: a session on Opus 5.5 ran /clear and read the model another session had written a
// minute earlier (Opus 4.8 overlay for the rest of the session). Now the model is cached under
// three keys and read back most-specific first:
//   1. session_id   — exact when /clear keeps the session id;
//   2. cwd          — parallel sessions usually run in different directories (worktrees);
//   3. profile      — the old file, last resort.
// Two sessions in the SAME directory that differ in model can still cross on /clear when the
// session id changes; that residue is named in improvements/2026-11-16-hooks-latency-2026-11.md.
//
// Never throws, never blocks the session: any failure -> silent.
// Env (tests): CLAUDE_MODEL_OVERLAY_DIR — overlay dir; CLAUDE_MODEL_OVERLAY_STATE — profile cache
// file (the per-key cache lives in `model-overlay-cache/` next to it).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Overlay file by model family (case-insensitive substring). opus-5-5 is tested before
// opus-5; opus-5 matches claude-opus-5 / [1m] / bedrock arns, but NOT claude-opus-4-5.
function overlayFile(model) {
    const m = String(model || '').toLowerCase();
    if (!m) return 'opus-5-5.md';
    if (m.includes('fable')) return 'fable.md';
    if (m.includes('opus-5-5')) return 'opus-5-5.md';
    if (m.includes('opus-5')) return 'opus-5.md';
    return 'opus.md';
}

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    } catch (e) {
        return null;
    }
}

function overlayDir() {
    return process.env.CLAUDE_MODEL_OVERLAY_DIR || path.join(path.dirname(__dirname), 'model-overlays');
}

function profileState() {
    if (process.env.CLAUDE_MODEL_OVERLAY_STATE) return process.env.CLAUDE_MODEL_OVERLAY_STATE;
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.USERPROFILE || os.homedir(), '.claude');
    return path.join(cfg, 'model-overlay-last-model.txt');
}

const sha = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 20);
const normCwd = (c) => String(c || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// Cache files for this payload, most specific first.
function cacheFiles(payload) {
    const state = profileState();
    const dir = path.join(path.dirname(state), 'model-overlay-cache');
    const files = [];
    const sid = String((payload && payload.session_id) || '');
    const cwd = normCwd(payload && payload.cwd);
    if (sid) files.push(path.join(dir, `s-${sha(sid)}.txt`));
    if (cwd) files.push(path.join(dir, `c-${sha(cwd)}.txt`));
    files.push(state);
    return files;
}

function readCache(payload) {
    for (const f of cacheFiles(payload)) {
        const v = readText(f);
        if (v && v.trim()) return v.trim();
    }
    return '';
}

function writeCache(payload, model) {
    const files = cacheFiles(payload);
    for (const f of files) {
        try {
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, model);
        } catch (e) { /* a cache miss later only costs the newest-overlay fallback */ }
    }
    // Per-session files accumulate; sweep the stale ones when writing.
    try {
        const dir = path.dirname(files[0]);
        if (files.length > 1) {
            const cutoff = Date.now() - CACHE_TTL_MS;
            for (const name of fs.readdirSync(dir)) {
                const f = path.join(dir, name);
                try {
                    if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
                } catch (e) { /* busy or gone */ }
            }
        }
    } catch (e) { /* sweep is best effort */ }
}

// Returns {eventName, context} or null when the hook stays silent.
function evaluate(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const dir = overlayDir();
    const event = String(p.hook_event_name || '');

    // SubagentStart: the main overlay never reaches subagents, so they get subagent.md.
    // The payload names no model and the main session's cache must stay intact.
    if (event === 'SubagentStart') {
        const sub = readText(path.join(dir, 'subagent.md'));
        if (!sub || !sub.trim()) return null;
        return { eventName: 'SubagentStart', context: sub };
    }

    const isSwitch = event === 'PostModelSwitch';
    const eventName = isSwitch ? 'PostModelSwitch' : 'SessionStart';
    let model = String((isSwitch ? p.to_model : p.model) || '');
    if (isSwitch && !model) return null; // nothing to route on

    const cached = readCache(p);
    if (model) writeCache(p, model);
    else model = cached;

    const file = overlayFile(model);

    // Switch that keeps the same overlay: the model already has it in context.
    if (isSwitch) {
        const prev = String(p.from_model || '') || cached;
        if (prev && overlayFile(prev) === file) return null;
    }

    let ctx = readText(path.join(dir, file));
    if (ctx === null) ctx = readText(path.join(dir, 'opus.md')); // fallback to the Opus overlay
    if (!ctx || !ctx.trim()) return null;
    return { eventName, context: ctx };
}

function safeEvaluate(payload) {
    try {
        return evaluate(payload);
    } catch (e) {
        return null;
    }
}

if (require.main === module) {
    try {
        let payload = null;
        try {
            const raw = fs.readFileSync(0, 'utf8');
            if (raw && raw.trim()) payload = JSON.parse(raw);
        } catch (e) { payload = null; }
        const r = safeEvaluate(payload);
        if (r) {
            process.stdout.write(JSON.stringify({
                hookSpecificOutput: { hookEventName: r.eventName, additionalContext: r.context },
            }));
        }
    } catch (e) {
        // fail open
    }
    // process.exitCode, not process.exit(): see hooks/docs-length-guard.js.
    process.exitCode = 0;
}

module.exports = { evaluate, safeEvaluate, overlayFile };
