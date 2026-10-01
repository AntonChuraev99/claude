#!/usr/bin/env node
// PreToolUse guard (mcp__mobile__.* — внутри фильтр на тулы устройства).
//
// Problem: ARTEMIS стал основным исполнителем проверок на устройстве 2026-09-30
// (PR #34), но правило жило только в /mcp-mobile-test. Сессия в проекте гоняла
// эмулятор напрямую, без команды, и 2026-10-01 по привычке взяла `mobile` MCP —
// пользователь остановил её вопросом «почему не ARTEMIS». Текстовое правило
// модель в этот момент не видит, поэтому дефолт держит хук.
//
// Поведение: первый вызов `mcp__mobile__*` агента получает deny с маршрутом на
// ARTEMIS; повтор проходит молча — `mobile` остаётся законным запасным путём
// (точечный assert, deeplink, ARTEMIS сорвался, пользователь велел). Та же
// механика, что у protected-branch-guard и Grep-запрета в bash-tool-discipline.
//
// Ключ — transcript_path (у каждого агента свой), с откатом на session_id:
// субагенты получают session_id родителя.
//
// Fail-open: любая ошибка -> exit 0 (allow). Сбой хука не должен блокировать работу.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'claude-artemis-default');
const STATE_TTL_MS = 3 * 24 * 3600 * 1000;
// Только тулы устройства. У `mobile` есть и модули без замены в ARTEMIS —
// browser_*, repl_*, clipboard_* и прочие: их хук не трогает.
const DEVICE_TOOL = /^mcp__mobile__(device|app|ui|screen|input|flow|system)(_|$)/;

const REASON =
    'Дефолт проверки на Android-устройстве/эмуляторе — ARTEMIS: `mcp__artemis__mobile_run_task` '
    + '(сценарий пишешь ты, ARTEMIS прокликивает, вердикт — по кадрам трейса), процедура — `/mcp-mobile-test`. '
    + '`mobile` MCP — только запасной путь: точечный assert одного экрана, deeplink, '
    + 'ARTEMIS недоступен или дважды сорвался, либо пользователь прямо попросил `mobile`. '
    + 'Не проверка Android-UI (iOS-симулятор, desktop, чтение логов, включение модуля) — тоже повод для `mobile`. '
    + 'Случай из этого списка — **повтори этот же вызов**, он пройдёт (запрет одноразовый на агента). '
    + 'Иначе переключись на ARTEMIS.';

function stateFile(key) {
    const safe = String(key || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(-64);
    return path.join(STATE_DIR, `${safe}.json`);
}

function sweepStale() {
    try {
        const now = Date.now();
        for (const name of fs.readdirSync(STATE_DIR)) {
            const p = path.join(STATE_DIR, name);
            try {
                if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.unlinkSync(p);
            } catch (e) { /* файл уже унесли */ }
        }
    } catch (e) { /* каталога нет */ }
}

// Возвращает текст deny либо null, если вызов пропускается.
function evaluate(payload) {
    if (!payload || !DEVICE_TOOL.test(String(payload.tool_name || ''))) return null;
    const key = payload.transcript_path || payload.session_id;
    const file = stateFile(key);
    if (fs.existsSync(file)) return null;
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        sweepStale();
        fs.writeFileSync(file, JSON.stringify({ nudged: Date.now() }));
    } catch (e) {
        // Не смогли запомнить — не блокируем, иначе deny повторялся бы бесконечно.
        return null;
    }
    return REASON;
}

function main() {
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
        // Fail open.
    }
    process.exitCode = 0;
}

module.exports = { evaluate, stateFile, STATE_DIR };
