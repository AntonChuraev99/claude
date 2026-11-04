#!/usr/bin/env node
'use strict';
// PermissionRequest: снимает диалог Claude Code с команд gcloud и пишет каждый
// диалог Bash/PowerShell в локальный журнал — транскрипт одобренные диалоги не
// хранит, и без журнала причину не восстановить.
//
// Одобряется только цепочка, где КАЖДОЕ звено — gcloud или безопасный фильтр
// вывода. Всё остальное, включая разбор, упавший с ошибкой, — молчание, то есть
// обычный диалог. Хук не возвращает updatedInput, а deny/ask-правила Claude Code
// проверяет сам уже после ответа хука.

const fs = require('fs');
const path = require('path');
const { maskText } = require('./account-align');

const LOG_FILE = process.env.GCLOUD_AUTOAPPROVE_LOG
    || path.join(__dirname, '..', 'stats', 'permission-requests.jsonl');
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_FIELD_MAX = 2000;

// Необратимые команды gcloud оставляем за человеком: ради них диалог и нужен.
// Слово ищется и внутри составных форм: `remove-iam-policy-binding`,
// `--delete-unmatched-destination-objects`. Лишний диалог дешевле потери данных.
const DESTRUCTIVE = /(^|\s)(rm|reset|clear|-{0,2}[\w-]*(delete|destroy|purge|remove)[\w-]*)(\s|$)/i;

// Фильтры читают stdin или файл и ничего не исполняют. awk, sed, xargs, tee и
// ForEach-Object сюда не входят: они запускают код или пишут файлы.
const FILTERS = new Set([
    'cat', 'cd', 'cut', 'echo', 'grep', 'head', 'jq', 'rg', 'sort', 'tail', 'tr', 'uniq', 'wc',
    'convertfrom-json', 'convertto-json', 'format-list', 'format-table',
    'measure-object', 'out-null', 'out-string', 'select-object', 'select-string',
    'set-location', 'sort-object', 'where-object',
]);

// У этих фильтров есть формы, которые пишут файл или запускают программу.
const UNSAFE_ARGS = {
    sort: /\s-[a-zA-Z]*o|\s--(o|comp)/,
    uniq: /\s[^-\s]/,
    rg: /\s--pre\b/,
};

// Эти переменные меняют то, какой код запустит следующая команда.
const UNSAFE_ASSIGN = /^(PATH|LD_|DYLD_|PYTHON|CLOUDSDK_|BASH_ENV$|ENV$|IFS$|PS4$)/;

const BENIGN_REDIRECT = /\d?>&\d|\d?>>?\s*(\/dev\/null|\$null|nul)(?=[\s;&|)]|$)/gi;

function reject(why) {
    return { allow: false, why };
}

// Текст в кавычках становится символами Q: разделители внутри него не режут
// цепочку, а `"rm"` остаётся словом и не проходит список фильтров.
function codeView(command, shell) {
    const masked = maskText(command, shell);
    let out = '';
    for (let i = 0; i < command.length; i++) {
        out += masked[i] === ' ' && !/\s/.test(command[i]) ? 'Q' : masked[i];
    }
    return out;
}

// maskText скрывает `$(…)` внутри "…", поэтому подстановку ищем и в исходнике.
function hasHiddenSubstitution(command, code) {
    for (let i = command.indexOf('$('); i >= 0; i = command.indexOf('$(', i + 1)) {
        if (code[i] !== '$') return true;
    }
    return false;
}

// Заменяет `$(…)` на слово, а содержимое отдаёт на ту же проверку.
function extractSubstitutions(code) {
    const inner = [];
    let out = code;
    for (let start = out.indexOf('$('); start >= 0; start = out.indexOf('$(')) {
        let depth = 0;
        let end = -1;
        for (let i = start + 1; i < out.length; i++) {
            if (out[i] === '(') depth++;
            else if (out[i] === ')' && --depth === 0) { end = i; break; }
        }
        if (end < 0) return null;
        inner.push(out.slice(start + 2, end));
        out = `${out.slice(0, start)}X${out.slice(end + 1)}`;
    }
    return { code: out, inner };
}

// bash присваивает значение как текст. PowerShell исполняет правую часть, поэтому
// там проходит только литерал; `$x = gcloud …` разбирает checkCommand.
function checkAssignment(segment, shell) {
    const re = shell === 'powershell'
        ? /^\$([A-Za-z_]\w*)\s*=\s*(?:Q+|\d+)$/
        : /^([A-Za-z_]\w*)=\S*$/;
    const m = re.exec(segment);
    if (!m) return null;
    return UNSAFE_ASSIGN.test(m[1]) ? 'unsafe-assignment' : 'ok';
}

function checkCommand(segment, shell, state) {
    // В PowerShell голая переменная выводит значение, а в bash запускает его.
    if (shell === 'powershell' && /^\$[A-Za-z_]\w*$/.test(segment)) return null;
    const command = shell === 'powershell'
        ? segment.replace(/^\$[A-Za-z_]\w*\s*=\s*/, '')
        : segment;
    const word = command.split(/\s+/, 1)[0].toLowerCase();
    if (word === 'gcloud' || word === 'gcloud.cmd') {
        state.gcloud = true;
        return null;
    }
    if (!FILTERS.has(word)) return `not-allowed:${word.slice(0, 40)}`;
    const unsafe = UNSAFE_ARGS[word];
    return unsafe && unsafe.test(command) ? `unsafe-args:${word}` : null;
}

function checkChain(code, shell, state) {
    const extracted = extractSubstitutions(code);
    if (!extracted) return 'unbalanced-substitution';
    for (const inner of extracted.inner) {
        const why = checkChain(inner, shell, state);
        if (why) return why;
    }
    const flat = extracted.code.replace(BENIGN_REDIRECT, ' ');
    if (/[<>]/.test(flat)) return 'redirect';
    if (/[()]/.test(flat)) return 'subshell';
    if (shell === 'powershell' && /[{}]/.test(flat)) return 'scriptblock';
    // В PowerShell одиночный `&` — оператор вызова: `& $x` запускает значение.
    if (shell === 'powershell' && /(^|[^&])&([^&]|$)/.test(flat)) return 'call-operator';

    for (const raw of flat.split(/&&|\|\||[;&|\n]/)) {
        const segment = raw.trim();
        if (!segment) continue;
        const assignment = checkAssignment(segment, shell);
        if (assignment === 'ok') continue;
        if (assignment) return assignment;
        const why = checkCommand(segment, shell, state);
        if (why) return why;
    }
    return null;
}

function decide(command, shell) {
    const cmd = String(command || '').replace(/\r\n/g, '\n');
    if (!/\bgcloud\b/i.test(cmd)) return reject('no-gcloud');
    if (cmd.includes('`')) return reject('backtick');

    const code = codeView(cmd, shell);
    if (hasHiddenSubstitution(cmd, code)) return reject('substitution-in-quotes');

    const joined = shell === 'powershell' ? code : code.replace(/\\\n/g, '  ');
    const state = { gcloud: false };
    const why = checkChain(joined, shell, state);
    if (why) return reject(why);
    if (!state.gcloud) return reject('no-gcloud-command');
    // Проверка идёт по тексту без кавычек: `"delete"` и `del"ete"` — то же слово.
    if (DESTRUCTIVE.test(cmd.replace(/["'\\]/g, ''))) return reject('destructive-gcloud');
    return { allow: true, why: 'gcloud-chain' };
}

function appendLog(entry) {
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
            fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
        }
        fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
    } catch (e) {
        // Журнал — диагностика: его сбой не должен менять решение.
    }
}

function redact(text) {
    return String(text || '')
        .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
        .replace(/ya29\.[\w.-]+/g, '<redacted>')
        .replace(/((?:api[-_]?key|token|secret|password)["']?\s*[:=]\s*)\S+/gi, '$1<redacted>')
        .slice(0, LOG_FIELD_MAX);
}

function handle(payload) {
    const tool = payload && payload.tool_name;
    if (tool !== 'Bash' && tool !== 'PowerShell') return null;
    const command = payload.tool_input && payload.tool_input.command;
    const verdict = decide(command, tool === 'PowerShell' ? 'powershell' : 'bash');
    appendLog({
        ts: new Date().toISOString(),
        tool,
        cwd: payload.cwd,
        mode: payload.permission_mode,
        allowed: verdict.allow,
        why: verdict.why,
        command: redact(command),
        suggestions: redact(JSON.stringify(payload.permission_suggestions || [])),
    });
    if (!verdict.allow) return null;
    return {
        hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
        },
    };
}

function main() {
    try {
        const output = handle(JSON.parse(fs.readFileSync(0, 'utf8')));
        if (output) process.stdout.write(JSON.stringify(output));
    } catch (e) {
        // Молчание оставляет обычный диалог: ошибка разбора не даёт одобрения.
    }
    return 0;
}

// process.exitCode, а не process.exit(): на Windows запись в pipe асинхронна, и
// exit() может оборвать JSON ответа на середине.
if (require.main === module) process.exitCode = main();

module.exports = { decide, handle };
