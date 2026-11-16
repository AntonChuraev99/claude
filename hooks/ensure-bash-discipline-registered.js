#!/usr/bin/env node
// SessionStart assertion: the single PreToolUse entry which carries BOTH the
// credentials guard and the Bash/Grep tool discipline is still registered, and the
// failure log that guard writes when it degrades is surfaced.
// Port of ensure-bash-discipline-registered.ps1 (2026-11-16); runs inside
// hooks/session-start.js. The check itself costs milliseconds — the 0.57–0.79 s
// were the pwsh start, so it needs no cache: the in-process call is the saving.
//
// Why an assertion and not a second hook. bash-tool-discipline.js is deliberately
// NOT registered in settings.json on its own: it is require()d in-process by
// hooks/credentials-guard-prefilter.js, because a separate PreToolUse entry costs
// another process spawn on every Bash and every Grep call. The coupling is
// invisible: drop the prefilter entry from settings.json and three things die at
// once and in silence — the credentials guard before deploy, the code-search ban,
// and the sleep ban. So this restates the invariant once per session. It never
// edits settings: a hook that silently rewrites them would hide the drift.
//
// Second job: credentials-guard-prefilter.js logs a JSONL line to
// ~/.claude/error-logs/ when the discipline module fails to load or throws; a
// recent entry there is reported here.
//
// Fail-open by construction. Env (tests): CLAUDE_HOME — profile root.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TAIL_LINES = 500;
// Bounded read: the same directory carries a continuously appended heartbeat log.
const TAIL_BYTES = 256 * 1024;

function tailLines(file) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split(/\r?\n/);
        if (len < size) lines.shift(); // first line is cut
        return lines.filter((l) => l.length).slice(-TAIL_LINES);
    } catch (e) {
        return [];
    } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* closed */ }
    }
}

// Returns the list of broken parts; empty when the invariant holds or cannot be judged.
function problems(claudeDir) {
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) return []; // nothing to assert against
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''));
    const out = [];

    let pre = settings && settings.hooks && settings.hooks.PreToolUse;
    pre = pre === undefined || pre === null ? [] : (Array.isArray(pre) ? pre : [pre]);
    // Matched by command text, not by matcher shape: the matcher may be reworded,
    // the script path may not disappear.
    const entries = pre.filter((e) => JSON.stringify(e).includes('credentials-guard-prefilter'));

    if (!entries.length) {
        out.push('PreToolUse-запись credentials-guard-prefilter отсутствует в settings.json — '
            + 'разом выключены credentials-guard, запрет code-search через Bash и запрет sleep');
    } else {
        // Coverage is the UNION over every entry that calls the prefilter; an entry
        // without a matcher matches every tool, which is wider, not narrower.
        const matcherless = entries.some((e) => !e || typeof e.matcher !== 'string' || !e.matcher.trim());
        if (!matcherless) {
            const union = entries.map((e) => String(e.matcher)).join('|');
            for (const tool of ['Bash', 'Grep']) {
                if (!new RegExp(tool, 'i').test(union)) {
                    out.push(`matcher '${union}' не покрывает тул ${tool} — дисциплина для него не применяется`);
                }
            }
        }
    }

    if (!fs.existsSync(path.join(claudeDir, 'hooks', 'bash-tool-discipline.js'))) {
        out.push('hooks/bash-tool-discipline.js не найден — prefilter загрузит null и промолчит');
    }

    // Window judged per LINE (`ts` of each record), not by file mtime: one fresh
    // line must not drag every stale record into the count.
    const logDir = path.join(claudeDir, 'error-logs');
    if (fs.existsSync(logDir)) {
        const cutoff = Date.now() - WINDOW_MS;
        let recent = 0;
        for (const name of fs.readdirSync(logDir)) {
            if (!name.toLowerCase().endsWith('.jsonl')) continue;
            const f = path.join(logDir, name);
            try {
                if (fs.statSync(f).mtimeMs <= cutoff) continue;
            } catch (e) {
                continue;
            }
            for (const line of tailLines(f)) {
                if (!line.includes('discipline-module-unavailable')) continue;
                try {
                    const ts = Date.parse(JSON.parse(line).ts);
                    if (ts > cutoff) recent++;
                } catch (e) { /* malformed line */ }
            }
        }
        if (recent > 0) {
            out.push(`в error-logs за 7 дней ${recent} записей `
                + 'discipline-module-unavailable — модуль дисциплины падал на живых вызовах');
        }
    }
    return out;
}

// {systemMessage, context} or null. Never throws.
function run(claudeDir) {
    let list = [];
    try {
        list = problems(claudeDir || process.env.CLAUDE_HOME
            || path.join(process.env.USERPROFILE || os.homedir(), '.claude'));
    } catch (e) {
        return null;
    }
    if (!list.length) return null;
    return {
        systemMessage: '⚠ bash-discipline: инвариант хука нарушен\n' + list.map((p) => '  ' + p).join('\n'),
        context: 'bash-discipline assertion failed: ' + list.join('; ')
            + '. Проверь hooks.PreToolUse в ~/.claude/settings.json — запись '
            + 'credentials-guard-prefilter несёт и credentials-guard, и дисциплину Bash/Grep '
            + '(bash-tool-discipline.js регистрации не имеет по конструкции).',
    };
}

if (require.main === module) {
    try {
        try { fs.readFileSync(0); } catch (e) { /* stdin is optional */ }
        const r = run();
        if (r) {
            process.stdout.write(JSON.stringify({
                suppressOutput: true,
                systemMessage: r.systemMessage,
                hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.context },
            }));
        }
    } catch (e) {
        // fail open
    }
    process.exitCode = 0;
}

module.exports = { run, problems };
