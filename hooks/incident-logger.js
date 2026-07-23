#!/usr/bin/env node
// Incident logger — UserPromptSubmit hook.
// Captures input-time hook/env failures into ~/.claude/error-logs/incidents/.
// Design: append-only heartbeat + dangling-start + slow-env detection.
// MUST be minimal, never hang, never block the prompt. All best-effort, all try/catch.
// See ~/.claude/error-logs/README.md for detection scope + limitations.

const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeDir = path.join(os.homedir(), '.claude');  // fixed source-of-truth dir → unified logs across profiles
const baseDir = path.join(claudeDir, 'error-logs');
const incidentsDir = path.join(baseDir, 'incidents');
const hbPath = path.join(baseDir, 'heartbeat.jsonl');
const SLOW_MS = 4000;   // logger normally ~50ms; >4s = environment under load
const HB_TRIM = 500;    // keep heartbeat.jsonl to last N lines

const started = Date.now();
let input = '';
let done = false;

function nowIso() { return new Date().toISOString(); }
function readLast() {
  try {
    const txt = fs.readFileSync(hbPath, 'utf8').trim();
    if (!txt) return null;
    const lines = txt.split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) { return null; }
}
function append(obj) { try { fs.appendFileSync(hbPath, JSON.stringify(obj) + '\n'); } catch (e) {} }
function trimHb() {
  try {
    const lines = fs.readFileSync(hbPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length > HB_TRIM) fs.writeFileSync(hbPath, lines.slice(-HB_TRIM).join('\n') + '\n');
  } catch (e) {}
}
function writeIncident(kind, detail) {
  try {
    const ts = nowIso().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(incidentsDir, `${ts}-${kind}.md`),
      `# Incident: ${kind}\n\n**Time:** ${nowIso()}\n**Kind:** ${kind}\n\n${detail}\n\n` +
      `## Триаж\n- [ ] Корень найден\n- [ ] Пофикшено / митигировано\n- [ ] Правило/хук обновлён\n`);
  } catch (e) {}
}

function finish() {
  if (done) return; done = true;
  try {
    try { fs.mkdirSync(incidentsDir, { recursive: true }); } catch (e) {}
    let prompt = '';
    try { prompt = String(JSON.parse(input).prompt || '').slice(0, 120); } catch (e) {}
    const runId = String(started);

    const last = readLast();
    if (last && last.phase === 'start' && last.runId) {
      const gapS = Math.round((started - (last.ts || started)) / 1000);
      writeIncident('userpromptsubmit-phase-incomplete',
        `Предыдущий UserPromptSubmit записал \`start\` (runId ${last.runId}), но не \`end\` — вся фаза зависла/убита таймаутом (снесло даже этот логгер).\n\n` +
        `- Предыдущий промпт: \`${String(last.prompt || '').replace(/`/g, "'")}\`\n` +
        `- Разрыв до следующего промпта: ~${gapS}s\n` +
        `- Вероятно: node-spawn starvation / stdin-EOF гонка под нагрузкой (см. error-logs/README.md).`);
    }

    append({ ts: started, runId, phase: 'start', prompt });
    const selfMs = Date.now() - started;
    if (selfMs > SLOW_MS) {
      writeIncident('slow-hook-environment',
        `Логгер отработал ${selfMs}ms (порог ${SLOW_MS}ms). Машина под нагрузкой — соседние UserPromptSubmit-хуки (caveman и пр.) рискуют таймаутом. Ранний сигнал.`);
    }
    append({ ts: Date.now(), runId, phase: 'end', self_ms: selfMs });
    trimHb();
  } catch (e) {}
  process.exit(0);   // pass-through: no output, never block the prompt
}

const guard = setTimeout(finish, 2000);   // never hang on missing stdin EOF
if (guard.unref) guard.unref();
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => { clearTimeout(guard); finish(); });
process.stdin.on('error', () => { clearTimeout(guard); finish(); });
