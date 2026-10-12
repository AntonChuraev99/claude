#!/usr/bin/env node
// Tests for play-console-browser-hint.js.
//
// Pin: первый браузерный вызов агента на play.google.com/console получает
// подсказку и НЕ получает permissionDecision; повтор того же агента молчит;
// другой агент получает свою подсказку; чужие URL и тулы не трогаются.
//
// Usage: node hooks/play-console-browser-hint.tests.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluate, stateFile } = require('./play-console-browser-hint.js');

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

const run = `test-${process.pid}-${Date.now()}`;
const prefix = 'C:\\Users\\Someone\\.claude-work\\projects\\C--Users-Someone-StudioProjects-long-project-name\\';
const agentA = `${prefix}${run}-aaaaaaaa-1111.jsonl`;
const agentB = `${prefix}${run}-bbbbbbbb-2222.jsonl`;
const agentC = `${prefix}${run}-cccccccc-3333.jsonl`;
const used = [agentA, agentB, agentC, `${prefix}${run}-x.jsonl`, `${prefix}${run}-y.jsonl`, `${prefix}${run}-z.jsonl`];
const CONSOLE_URL = 'https://play.google.com/console/u/0/developers/123/app/456/statistics';

function hinted(tool, input, transcript) {
    return evaluate({ tool_name: tool, tool_input: input, transcript_path: transcript }) !== null;
}

try {
    console.log('=== once per agent ===');
    check('first navigate to console hinted', hinted('mcp__claude-in-chrome__navigate', { url: CONSOLE_URL }, agentA), true);
    check('repeat silent', hinted('mcp__claude-in-chrome__navigate', { url: CONSOLE_URL }, agentA), false);
    check('another agent gets its own hint', hinted('mcp__claude-in-chrome__navigate', { url: CONSOLE_URL }, agentB), true);
    check('playwright navigate hinted',
        hinted('mcp__plugin_playwright_playwright__browser_navigate', { url: CONSOLE_URL }, `${prefix}${run}-x.jsonl`), true);

    console.log('=== hint content ===');
    const hint = evaluate({ tool_name: 'mcp__claude-in-chrome__tabs_create_mcp', tool_input: { url: CONSOLE_URL }, transcript_path: `${prefix}${run}-y.jsonl` }) || '';
    check('routes to the agent', /@google-play-console-expert/.test(hint), true);
    check('names play_stats.py', /play_stats\.py/.test(hint), true);
    check('says call is not blocked', /не заблокирован/.test(hint), true);

    console.log('=== untouched ===');
    check('other site silent', hinted('mcp__claude-in-chrome__navigate', { url: 'https://example.com' }, agentC), false);
    check('public store page silent',
        hinted('mcp__claude-in-chrome__navigate', { url: 'https://play.google.com/store/apps/details?id=com.x' }, agentC), false);
    check('non-browser tool silent', hinted('Bash', { command: `curl ${CONSOLE_URL}` }, agentC), false);
    check('empty payload', evaluate(null), null);

    console.log('=== process output: context, never a decision ===');
    const res = spawnSync(process.execPath, [path.join(__dirname, 'play-console-browser-hint.js')], {
        input: JSON.stringify({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input: { url: CONSOLE_URL }, transcript_path: `${prefix}${run}-z.jsonl` }),
        encoding: 'utf8',
    });
    const out = JSON.parse(res.stdout || '{}');
    check('exit 0', res.status, 0);
    check('no permissionDecision', (out.hookSpecificOutput || {}).permissionDecision, undefined);
    check('additionalContext present', Boolean((out.hookSpecificOutput || {}).additionalContext), true);
    check('event name', (out.hookSpecificOutput || {}).hookEventName, 'PreToolUse');
    const bad = spawnSync(process.execPath, [path.join(__dirname, 'play-console-browser-hint.js')], { input: '{not json', encoding: 'utf8' });
    check('malformed input fails open', bad.status === 0 && bad.stdout === '', true);

    console.log('=== key ===');
    check('long common prefix -> distinct state files', stateFile(agentA) !== stateFile(agentB), true);
} finally {
    for (const k of used) {
        try { fs.unlinkSync(stateFile(k)); } catch (e) { /* не создан */ }
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
