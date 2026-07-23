#!/usr/bin/env node
// Manual incident logger: node log-incident.js "<kind-slug>" "текст ошибки"
// Пишет файл в ~/.claude/error-logs/incidents/ для последующего триажа.
const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeDir = path.join(os.homedir(), '.claude');  // fixed source-of-truth dir → unified logs across profiles
const incidentsDir = path.join(claudeDir, 'error-logs', 'incidents');

const kindRaw = (process.argv[2] || 'manual').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'manual';
const detail = process.argv.slice(3).join(' ') || '(no detail)';

try {
  fs.mkdirSync(incidentsDir, { recursive: true });
  const iso = new Date().toISOString();
  const ts = iso.replace(/[:.]/g, '-');
  const f = path.join(incidentsDir, `${ts}-${kindRaw}.md`);
  fs.writeFileSync(f,
    `# Incident: ${kindRaw}\n\n**Time:** ${iso}\n**Kind:** ${kindRaw}\n**Source:** manual\n\n${detail}\n\n` +
    `## Триаж\n- [ ] Корень найден\n- [ ] Пофикшено / митигировано\n- [ ] Правило/хук обновлён\n`);
  console.log('logged: ' + f);
} catch (e) {
  console.error('failed to log incident: ' + e.message);
  process.exit(1);
}
