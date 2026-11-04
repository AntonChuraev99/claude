#!/usr/bin/env node
'use strict';
// Запуск: node hooks/gcloud-autoapprove.tests.js

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide } = require('./gcloud-autoapprove');

const allowed = [
    ['bash', 'gcloud projects list --limit=1'],
    ['bash', 'gcloud functions describe fn --gen2 --region=us-central1 --format="value(state)"'],
    ['bash', "gcloud logging read 'severity>=ERROR AND textPayload:\"delete\"' --limit=5 2>&1 | head -20"],
    ['bash', 'gcloud run services list 2>/dev/null | grep api | wc -l'],
    ['bash', 'cd backend && gcloud functions list --regions=europe-west3 | sort | uniq -c'],
    ['bash', 'gcloud services list \\\n  --enabled'],
    ['bash', 'TOK=$(gcloud auth print-access-token) && echo ${#TOK}'],
    ['bash', 'A=--account=me@example.com; gcloud projects list $A'],
    ['powershell', 'gcloud projects list --limit=1'],
    ['powershell', '$rows = gcloud functions list --format="value(name)"; $rows | Select-Object -First 3'],
    ['powershell', 'gcloud storage ls gs://bucket 2>$null | Out-String'],
    ['powershell', '$p = "my-project"; gcloud projects describe $p 2>&1'],
    ['powershell', 'gcloud version && gcloud projects list'],
    ['bash', 'gcloud projects list | sort -k2 -n -r'],
];

const blocked = [
    ['bash', 'gcloud projects list && rm -rf build', 'not-allowed:rm'],
    ['bash', 'gcloud projects list; "rm" x', 'not-allowed'],
    ['bash', 'gcloud projects list | "reboot"', 'not-allowed'],
    ['bash', 'gcloud projects list | xargs rm', 'not-allowed:xargs'],
    ['bash', 'gcloud projects list | sh', 'not-allowed:sh'],
    ['bash', 'echo "$(rm -rf x)" && gcloud version', 'substitution-in-quotes'],
    ['bash', 'gcloud version $(rm -rf x)', 'not-allowed:rm'],
    ['bash', 'gcloud version `rm -rf x`', 'backtick'],
    ['bash', 'gcloud projects list > ~/.bashrc', 'redirect'],
    ['bash', 'gcloud projects list <<EOF\nrm -rf x\nEOF', 'redirect'],
    ['bash', '( rm -rf x ) ; gcloud version', 'subshell'],
    ['bash', 'PATH=/tmp/evil; gcloud version', 'unsafe-assignment'],
    ['bash', 'PATH=/tmp/evil gcloud version', 'not-allowed'],
    ['bash', 'gcloud projects list | sort -o ~/.bashrc', 'unsafe-args:sort'],
    ['bash', 'gcloud projects list | uniq - ~/.bashrc', 'unsafe-args:uniq'],
    ['bash', 'gcloud projects list | rg --pre ./x y', 'unsafe-args:rg'],
    ['bash', 'gcloud projects delete my-project', 'destructive-gcloud'],
    ['bash', 'gcloud functions delete fn --quiet', 'destructive-gcloud'],
    ['bash', 'gcloud projects "delete" my-project', 'destructive-gcloud'],
    ['bash', 'gcloud projects del"ete" my-project', 'destructive-gcloud'],
    ['bash', 'gcloud storage rm -r gs://bucket', 'destructive-gcloud'],
    ['bash', 'gcloud projects remove-iam-policy-binding p --member=x --role=y', 'destructive-gcloud'],
    ['bash', 'gcloud storage rsync a gs://b --delete-unmatched-destination-objects', 'destructive-gcloud'],
    ['bash', 'gcloud compute instances reset vm', 'destructive-gcloud'],
    ['bash', 'gcloud projects list | sort -uo ~/.bashrc', 'unsafe-args:sort'],
    ['bash', 'gcloud projects list | sort -ofile', 'unsafe-args:sort'],
    ['bash', 'gcloud projects list | sort --compress-program=./x', 'unsafe-args:sort'],
    ['bash', 'X=rm; $X = gcloud version', 'not-allowed:$x'],
    ['powershell', '$x = ./evil.ps1; gcloud version', 'not-allowed:./evil.ps1'],
    ['powershell', '$x = Restart-Computer; gcloud version', 'not-allowed:restart-computer'],
    ['powershell', '$x = "rm"; & $x; gcloud version', 'call-operator'],
    ['powershell', '& "rm" x; gcloud version', 'call-operator'],
    ['bash', 'bash -c "gcloud version"', 'not-allowed:bash'],
    ['bash', 'X=rm; gcloud version; $X y', 'not-allowed:$x'],
    ['bash', 'X=reboot; gcloud version; $X', 'not-allowed:$x'],
    ['bash', 'echo gcloud', 'no-gcloud-command'],
    ['bash', 'npm test', 'no-gcloud'],
    ['powershell', 'gcloud version; Remove-Item -Recurse x', 'not-allowed:remove-item'],
    ['powershell', 'gcloud version | ForEach-Object { Remove-Item x }', 'scriptblock'],
    ['powershell', 'gcloud version | Select-Object @{n="x";e={Remove-Item y}}', 'scriptblock'],
    ['powershell', '$env:PATH = "x"; gcloud version', 'not-allowed'],
    ['powershell', 'iex "gcloud version"', 'not-allowed:iex'],
];

for (const [shell, command] of allowed) {
    const verdict = decide(command, shell);
    assert.strictEqual(verdict.allow, true, `${command} => ${verdict.why}`);
}

for (const [shell, command, why] of blocked) {
    const verdict = decide(command, shell);
    assert.strictEqual(verdict.allow, false, `${command} одобрена`);
    assert.ok(verdict.why.startsWith(why), `${command}: ждали ${why}, получили ${verdict.why}`);
}

function runHook(stdin, log) {
    const env = Object.assign({}, process.env, { GCLOUD_AUTOAPPROVE_LOG: log });
    return spawnSync(process.execPath, [path.join(__dirname, 'gcloud-autoapprove.js')], {
        input: stdin, encoding: 'utf8', env,
    });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcloud-autoapprove-'));
const log = path.join(dir, 'nested', 'log.jsonl');

const approved = runHook(JSON.stringify({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'gcloud projects list', description: 'x' },
    permission_mode: 'bypassPermissions',
}), log);
assert.strictEqual(approved.status, 0);
const answer = JSON.parse(approved.stdout).hookSpecificOutput;
assert.strictEqual(answer.hookEventName, 'PermissionRequest');
assert.deepStrictEqual(answer.decision, { behavior: 'allow' });

const asked = runHook(JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'gcloud version && curl -H "Authorization: Bearer ya29.secret" "https://x?api_key=abc123"' },
}), log);
assert.strictEqual(asked.status, 0);
assert.strictEqual(asked.stdout, '', 'при отказе хук молчит и диалог остаётся');

assert.strictEqual(runHook('{broken', log).stdout, '', 'ошибка разбора не даёт одобрения');
assert.strictEqual(runHook(JSON.stringify({ tool_name: 'Edit', tool_input: {} }), log).stdout, '');

const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.strictEqual(lines.length, 2, 'журнал хранит только Bash и PowerShell');
assert.strictEqual(lines[0].allowed, true);
assert.strictEqual(lines[1].allowed, false);
assert.ok(!JSON.stringify(lines).includes('ya29.secret'), 'токен не попадает в журнал');
assert.ok(!JSON.stringify(lines).includes('abc123'), 'ключ API не попадает в журнал');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`ok: ${allowed.length} одобрены, ${blocked.length} отклонены, хук отвечает по контракту`);
