#!/usr/bin/env node
// PreToolUse guard (Write | Edit | NotebookEdit).
//
// Problem: .claude-work\ is a junction/symlink PROJECTION of the source-of-truth
// .claude\ (see clauderules\profiles-and-linking.md). Agents keep writing infra
// files (CLAUDE.md, agents\, skills\, improvements\, settings.json, ...) to the
// .claude-work\ path. It "works" while the link is intact but silently diverges
// if the link ever breaks, and it muddies which tree is canonical.
//
// This hook DENIES such writes and tells the model the canonical .claude\ path.
// It runs regardless of permission mode (deny lists are unreliable under
// bypassPermissions; hooks are not).
//
// NOT blocked (data dirs — harness/agents legitimately target these; they are
// junctions to .claude\ anyway so nothing is lost): projects\, agent-memory\, stats\
//
// Ported from guard-claude-work-writes.ps1 (2026-08-19). The logic is pure
// string work, but it fired on every Write/Edit and a pwsh start cost 3.1–3.5 s
// on this machine against ~0.3 s for node. Behaviour is unchanged; see
// guard-claude-work-writes.tests.js.
//
// Fail-open by design: ANY error -> exit 0 (allow). A guard bug must never block
// real work.

const DATA_DIRS = ['projects\\', 'agent-memory\\', 'stats\\'];
const MARKER = '\\.claude-work\\';

// Returns the deny reason, or null when the write is allowed.
function evaluate(payload) {
    const input = payload && payload.tool_input;
    if (!input) return null;

    // Write/Edit use file_path; NotebookEdit uses notebook_path.
    const filePath = input.file_path || input.notebook_path;
    if (!filePath || !String(filePath).trim()) return null;

    const norm = String(filePath).replace(/\//g, '\\');
    const low = norm.toLowerCase();

    const idx = low.indexOf(MARKER);
    if (idx < 0) return null; // not under .claude-work -> allow

    // Path relative to .claude-work\, e.g. 'agents\foo.md' or 'projects\x\memory\m.md'
    const rel = low.substring(idx + MARKER.length);

    // Data dirs: let them pass untouched (memory & co.).
    if (DATA_DIRS.some((d) => rel.startsWith(d))) return null;

    // Everything else under .claude-work is source-of-truth infra -> redirect.
    // Preserve original casing of the rest of the path in the suggestion.
    const canonical = norm.replace(/\.claude-work\\/gi, '.claude\\');

    return `BLOCKED: '${filePath}' is under .claude-work (a junction/symlink PROJECTION, `
        + `not the source of truth). Retry the same Write/Edit with file_path = '${canonical}' `
        + `(the canonical .claude path). Only data dirs (projects, agent-memory, stats) may `
        + `stay under .claude-work; infra files belong in .claude.`;
}

function main() {
    const fs = require('fs');
    let raw = '';
    try {
        raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
        return;
    }
    if (!raw || !raw.trim()) return;

    const reason = evaluate(JSON.parse(raw));
    if (!reason) return;

    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        // Fail open — never block a legitimate write because the guard hiccuped.
    }
    // process.exitCode, not process.exit(): on Windows a write to a pipe is
    // async and exit() can truncate it, leaving the harness with half a deny.
    // Same reasoning as hooks/docs-length-guard.js.
    process.exitCode = 0;
}

module.exports = { evaluate };
