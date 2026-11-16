#!/usr/bin/env node
// PostToolUse(Write|Edit|MultiEdit): both docs checks in ONE process.
//
// docs-length-guard.js (length budget) and docs-facts-guard.js (facts against the
// repo) used to be two PostToolUse entries, i.e. two node starts after every
// Write/Edit of any file, while both stay silent outside docs/{solutions,
// decisions,archive}. This entry reads stdin once and asks both modules; each
// keeps its own tests and its own standalone entry point (the facts guard is also
// a CLI for /task-gate).
//
// Output: one additionalContext. A single verdict is printed exactly as its guard
// prints it alone; when both speak, the two texts are joined by a blank line,
// length first.
// Fail-open per check: one module throwing does not silence the other.

'use strict';

const STDIN_TIMEOUT_MS = 2000;

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        const finish = (v) => {
            if (!done) {
                done = true;
                resolve(v);
            }
        };
        // Async read with an unref'd watchdog: a stdin without EOF must not hold
        // the process (same guard as in docs-length-guard.js).
        const timer = setTimeout(() => finish(data), STDIN_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => {
            data += c;
        });
        process.stdin.on('end', () => {
            clearTimeout(timer);
            finish(data);
        });
        process.stdin.on('error', () => {
            clearTimeout(timer);
            finish('');
        });
    });
}

const CHECKS = ['./docs-length-guard.js', './docs-facts-guard.js'];

function verdicts(payload) {
    const out = [];
    for (const mod of CHECKS) {
        try {
            const v = require(mod).verdictFor(payload);
            if (v) out.push(v);
        } catch (e) {
            // fail open for this check only
        }
    }
    return out;
}

function render(texts) {
    if (!texts.length) return '';
    return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: texts.join('\n\n') },
    });
}

if (require.main === module) {
    readStdin()
        .then((raw) => {
            if (!raw || !raw.trim()) return;
            let payload = null;
            try { payload = JSON.parse(raw); } catch (e) { return; }
            const text = render(verdicts(payload));
            // process.exitCode, not process.exit(): on Windows the pipe write is
            // async and exit() can truncate it.
            if (text) process.stdout.write(text);
        })
        .catch(() => {})
        .then(() => {
            process.exitCode = 0;
        });
}

module.exports = { verdicts, render };
