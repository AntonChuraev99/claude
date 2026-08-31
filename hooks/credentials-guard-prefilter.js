#!/usr/bin/env node
// PreToolUse(Bash) prefilter in front of credentials-guard.ps1.
//
// The guard itself is correct but expensive to reach: it ran on EVERY Bash call
// and a pwsh start costs 1.4–2.4 s on this machine. The overwhelming majority
// of Bash calls cannot possibly deploy anything, so this decides — in ~0.3 s of
// node — whether the real guard has to run at all, then hands stdin over
// untouched and proxies its verdict.
//
// Deliberately CRUDER than the guard: it only asks whether the command mentions
// one of the external-service tools AND one of the state-changing verbs
// anywhere. The guard then applies the same words positionally (command
// position, wrapper handling, per-service checks). Cruder means this can only
// over-approximate — it may pay for a pwsh start that the guard then waves
// through, never the reverse.
//
// Both sides read the same word lists from config/credentials-guard-patterns.json
// so they cannot drift apart. Anything unexpected — missing file, bad JSON,
// unreadable stdin — falls through to running the guard. Fail-safe here means
// running the expensive check, never skipping it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Подсказки про выбор инструмента — необязательная функция поверх обязательной.
// require намеренно ленивый и в try/catch: на верхнем уровне сломанный или
// отсутствующий модуль убил бы процесс ДО main(), а обёртка `try { main() }`
// время загрузки не покрывает. Пустой stdout харнесс читает как «возражений нет»,
// то есть падение подсказки пропустило бы деплой мимо credentials-guard.
// Сломанный модуль молча выключает ВСЕ жёсткие запреты, и на replay «правило ни
// разу не понадобилось» неотличимо от «правило не работает». Одна строка в лог
// эту разницу и делает; сам лог падать не имеет права — он тут не главный.
function noteDisciplineFailure(err) {
    try {
        const dir = path.join(os.homedir(), '.claude', 'error-logs');
        // Каталог существует не по конструкции: на чистом профиле его нет, и без
        // mkdir запись молча провалилась бы в catch — то есть ровно то молчание,
        // против которого этот лог и заведён (ревью 2026-08-21).
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            hook: 'credentials-guard-prefilter',
            event: 'discipline-module-unavailable',
            error: String((err && err.message) || err).slice(0, 300),
        });
        fs.appendFileSync(path.join(dir, 'hook-failures.jsonl'), line + '\n');
    } catch (e) { /* лог не работает — вердикт всё равно важнее */ }
}

// Результат мемоизируется: loadDiscipline зовётся дважды за вызов (жёсткие
// запреты и подсказки), а неудачный require в Node не кешируется — сломанный
// модуль парсился заново и логировался ДВАЖДЫ на каждую команду.
let disciplineCache;
function loadDiscipline() {
    if (disciplineCache !== undefined) return disciplineCache;
    try {
        disciplineCache = require('./bash-tool-discipline.js');
    } catch (e) {
        noteDisciplineFailure(e);
        disciplineCache = null;
    }
    return disciplineCache;
}

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const GUARD = path.join(CLAUDE_DIR, 'hooks', 'credentials-guard.ps1');
const PATTERNS = path.join(CLAUDE_DIR, 'config', 'credentials-guard-patterns.json');

// Returns true when the real guard must run.
function needsGuard(raw) {
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        return true; // unparseable input is the guard's problem, not ours
    }

    if (payload.tool_name !== 'Bash') return false;
    // The guard honours this too; checking here avoids the spawn entirely.
    if (process.env.CLAUDE_ALLOW_DEPLOY === '1') return false;

    const command = payload.tool_input && payload.tool_input.command;
    if (!command || typeof command !== 'string') return false;

    let tools;
    let verbs;
    try {
        const cfg = JSON.parse(fs.readFileSync(PATTERNS, 'utf8'));
        // An empty or blank entry collapses the alternation into one that
        // matches at nearly any word boundary, so every command would look
        // dangerous — which is safe here but defeats the whole prefilter.
        const clean = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : []);
        tools = clean(cfg.tools);
        verbs = clean(cfg.verbs);
        if (!tools.length || !verbs.length) return true;
    } catch (e) {
        return true; // no word list -> cannot rule anything out
    }

    try {
        // Case-insensitive to match PowerShell's -match, which the guard uses
        // and which ignores case by default. Without the flag `Firebase Deploy`
        // and `GCLOUD deploy` skipped a guard that denies them — verified.
        const toolRe = new RegExp(`\\b(${tools.join('|')})\\b`, 'i');
        const verbRe = new RegExp(`\\b(${verbs.join('|')})`, 'i');
        return toolRe.test(command) && verbRe.test(command);
    } catch (e) {
        return true; // bad pattern -> let the guard decide
    }
}

function denyBecause(detail) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                `credentials-guard не отработал (${detail}). `
                + 'Команда меняет состояние во внешнем сервисе — сверь активный аккаунт '
                + 'вручную, покажи результат пользователю и не снимай блокировку себе.',
        },
    }));
}

// Runs the real guard and proxies its verdict. Called only once the command is
// already suspect, so from here on failure means deny, never allow: a silent
// exit 0 would be a hook that waves a deploy through because of its own bug.
function runGuard(raw) {
    const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD],
        {
            input: Buffer.from(raw, 'utf8'),
            // A hung pwsh would otherwise be killed by the harness, and a killed
            // PreToolUse hook renders no decision — the command just runs. The
            // guard's own probes finish within ~6 s; this bounds the rest.
            timeout: 15000,
            killSignal: 'SIGKILL',
        },
    );

    if (result.error || result.status === null) {
        denyBecause(result.error ? result.error.message : 'процесс не вернул статус или был убит по таймауту');
        return 0;
    }

    // The guard exits 0 on every path it takes, including both of its catch
    // blocks. A non-zero status therefore means it never ran its logic —
    // broken pwsh, ExecutionPolicy, a syntax error — and its silence must not
    // be read as consent.
    if (result.status !== 0) {
        denyBecause(`guard завершился с кодом ${result.status}`);
        return 0;
    }

    if (result.stderr && result.stderr.length) process.stderr.write(result.stderr);

    const out = (result.stdout || Buffer.alloc(0)).toString('utf8').trim();
    if (!out) return 0; // guard stayed silent = allow, its normal pass path

    // Anything on stdout is the verdict, so it has to be a verdict: a banner or
    // stray warning would reach the harness as unparseable and be ignored,
    // turning a deny into an allow.
    try {
        JSON.parse(out);
    } catch (e) {
        denyBecause('guard вернул неразбираемый вывод вместо вердикта');
        return 0;
    }

    process.stdout.write(out);
    return 0;
}

// Второй, независимый смысл этого хука: он единственный, кто уже висит на
// PreToolUse(Bash), поэтому дисциплина вызовов (ast-index вместо grep, Read
// вместо cat, запрет долгого sleep) живёт здесь же — модулем в том же процессе.
// Отдельный хук стоил бы ещё один спавн на каждый Bash-вызов; см. шапку
// hooks/bash-tool-discipline.js. Вызывается только когда credentials-guard не
// нужен: деплой важнее подсказки, и два вердикта одновременно вернуть нельзя.
// Ключ дедупликации подсказок: transcript_path различает агентов внутри одной
// сессии (у субагентов фан-аута session_id общий с родителем).
function cooldownKey(payload) {
    return payload.transcript_path || payload.session_id;
}

// Жёсткие запреты (долгий sleep, поллинг по таймеру, текстовый поиск по
// исходникам) — отдельно от подсказок: они обязаны отработать даже на команде,
// которую дальше ждёт credentials-guard. Порядок безопасен в одну сторону:
// запрет СТРОЖЕ, чем разбор в guard, поэтому вынесение его вперёд не способно
// пропустить опасную команду — оно её блокирует. Обратный порядок стоил бы
// пропуска запрета на командах, где грубый префильтр увидел слово вроде
// `firebase` внутри поискового паттерна. Возвращает true, если вердикт вынесен.
function emitDeny(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
    return true;
}

// Тул Grep судится тем же модулем, но в ЭТОМ же процессе: отдельный хук на
// matcher "Grep" стоил бы второй спавн на каждый поиск (на Windows это заметно —
// docs/solutions/hook-spawn-cost-windows-2026-08-19.md), а плагинная напоминалка
// ast-index уже висит там своим bash-скриптом и не блокирует.
function renderGrepDeny(payload) {
    const discipline = loadDiscipline();
    if (!discipline || !discipline.grepVerdict) return false;
    let verdict = null;
    try {
        verdict = discipline.grepVerdict(payload.tool_input, cooldownKey(payload));
    } catch (e) {
        noteDisciplineFailure(e);
        return false;
    }
    if (!verdict || verdict.decision !== 'deny') return false;
    return emitDeny(verdict.reason);
}

function renderHardDeny(payload) {
    const discipline = loadDiscipline();
    if (!discipline || payload.tool_name !== 'Bash') return false;

    let verdict = null;
    try {
        // Отдельные функции, а не judge: judge на команде чтения потратил бы
        // слот кулдауна, и подсказка ниже по потоку уже не выдалась бы.
        const command = payload.tool_input && payload.tool_input.command;
        verdict = discipline.sleepVerdict(command)
            || discipline.codeSearchVerdict(command);
    } catch (e) {
        // Тот же случай, что и несобравшийся модуль: запрет не вынесен, и это
        // должно быть видно в логе, а не выглядеть как «нарушений не было».
        noteDisciplineFailure(e);
        return false;
    }
    if (!verdict || verdict.decision !== 'deny') return false;
    return emitDeny(verdict.reason);
}

function renderDiscipline(payload) {
    const discipline = loadDiscipline();
    if (!discipline || !payload || payload.tool_name !== 'Bash') return 0;

    let verdict = null;
    try {
        verdict = discipline.judge(
            payload.tool_input && payload.tool_input.command,
            cooldownKey(payload),
        );
    } catch (e) {
        return 0; // подсказка не стоит того, чтобы мешать работе
    }
    if (!verdict) return 0;

    // Подсказка идёт БЕЗ permissionDecision: `allow` в этом контракте не «не
    // возражаю», а «пропустить мимо проверки прав», и тогда любая команда,
    // задевшая эвристику про cat/grep, автоматически обходила бы правила из
    // permissions.deny/ask. Решение выносится только на запреты (долгий sleep,
    // поллинг по таймеру, текстовый поиск по исходникам) — их отдаёт judge как
    // `decision: 'deny'`, и они уже отработали выше, в renderHardDeny.
    const out = verdict.decision === 'deny'
        ? { permissionDecision: 'deny', permissionDecisionReason: verdict.reason }
        : { additionalContext: verdict.context };

    process.stdout.write(JSON.stringify({
        hookSpecificOutput: Object.assign({ hookEventName: 'PreToolUse' }, out),
    }));
    return 0;
}

function main() {
    let raw = '';
    try {
        raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
        raw = '';
    }
    if (!raw || !raw.trim()) return 0;

    let payload = null;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        payload = null; // needsGuard разберётся сам, он отвечает true на неразбираемое
    }

    // Жёсткие запреты идут ДО credentials-guard: иначе `sleep 600 && firebase
    // deploy` уходит в гард и порога не видит вовсе, а `grep -rn firebase
    // --include=*.kt .` будит pwsh из-за слова в поисковом паттерне. Deny здесь
    // строже любого вердикта гарда — он всё равно был бы «нельзя» или «можно»,
    // а команда не должна выполняться в этом виде. Пороги пауз (10 с вне цикла,
    // 30 с внутри until/while) держит сам модуль, здесь их дублировать незачем.
    // Grep — не команда шелла: ни credentials-guard, ни подсказки про cat/grep к
    // нему неприменимы, а `needsGuard` на сыром JSON увидел бы слово вроде
    // `firebase` в поисковом паттерне и разбудил pwsh впустую. Поэтому ветка
    // закрывается здесь целиком.
    if (payload && payload.tool_name === 'Grep') {
        renderGrepDeny(payload);
        return 0;
    }

    if (payload && renderHardDeny(payload)) return 0;

    // Deciding is cheap and safe to fail open: needsGuard already answers true
    // for anything it cannot parse.
    if (!needsGuard(raw)) {
        if (!payload) return 0;
        return renderDiscipline(payload);
    }

    try {
        return runGuard(raw);
    } catch (e) {
        denyBecause(`внутренняя ошибка префильтра: ${e && e.message}`);
        return 0;
    }
}

if (require.main === module) {
    try {
        main();
    } catch (e) {
        // Reached only if reading stdin or the decision itself threw, i.e.
        // before the command was judged suspect.
    }
    // process.exitCode, not process.exit(): on Windows a write to a pipe is
    // async, and exit() can cut it off mid-JSON. A truncated deny is an
    // unparseable deny, which the harness reads as no objection at all.
    // Same reasoning as hooks/docs-length-guard.js.
    process.exitCode = 0;
}

module.exports = { needsGuard };
