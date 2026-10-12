#!/usr/bin/env node
// PreToolUse hint (mcp__claude-in-chrome__.* | mcp__plugin_playwright_playwright__.*).
//
// Problem: на запрос «данные из стора» главный агент открывал Play Console в
// браузере. За 60 дней до 2026-10-12 — 61 вызов claude-in-chrome на
// play.google.com/console в 7 транскриптах; в 4 браузер открыли раньше, чем
// @google-play-console-expert, в 3 — после него, за установками, acquisition/CVR,
// статистикой и подписками, хотя GCS-экспорт отдаёт эти данные через API.
//
// Поведение: первый вызов браузерного тула агента, в input которого есть
// play.google.com/console, получает additionalContext с картой «данные → API».
// Вызов НЕ блокируется (решение пользователя: предупреждать, а не запрещать) —
// у части разделов консоли API нет. Повторно тот же агент подсказку не получает.
//
// Ключ — transcript_path (у каждого агента свой), с откатом на session_id.
// Fail-open: любая ошибка -> exit 0 без вывода.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'claude-play-console-hint');
const STATE_TTL_MS = 3 * 24 * 3600 * 1000;
const BROWSER_TOOL = /^mcp__(claude-in-chrome|plugin_playwright_playwright)__/;
const PLAY_CONSOLE = /play\.google\.com\/console/i;

const HINT =
    'Play Console в браузере. Данные стора сначала берёт `@google-play-console-expert` через официальные API: '
    + 'установки, удаления, активные устройства по стране/версии/устройству; рейтинг; acquisition '
    + '(посетители листинга, CVR, источник трафика, UTM, поисковые запросы); подписки (новые, отмены, активные); '
    + 'отзывы (история и свежие); crash/ANR vitals; треки, релизы, тексты листинга. Скрипты: '
    + '`play_stats.py`, `play_vitals.py`, `play_publish.py` в `~/.claude/agents/google-play-console-expert/scripts/`. '
    + 'Браузер законен, когда агента уже вызывали и он вернул, что API этого не отдаёт, либо для разделов без API: '
    + 'Policy center, App content, детали store listing experiments, Store analysis (сравнение с пирами), '
    + 'данные за последние 3-7 дней, которых ещё нет в GCS-экспорте, а также ручная настройка, о которой просил пользователь. '
    + 'Тогда продолжай. Подсказка одна на агента, вызов не заблокирован.';

const SCREEN = '⚠ Play Console в браузере: данные стора есть в API — @google-play-console-expert';

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

// Возвращает текст подсказки либо null, если вызов идёт молча.
function evaluate(payload) {
    if (!payload || !BROWSER_TOOL.test(String(payload.tool_name || ''))) return null;
    if (!PLAY_CONSOLE.test(JSON.stringify(payload.tool_input || {}))) return null;
    const file = stateFile(payload.transcript_path || payload.session_id);
    if (fs.existsSync(file)) return null;
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        sweepStale();
        fs.writeFileSync(file, JSON.stringify({ hinted: Date.now() }));
    } catch (e) {
        // Не смогли запомнить — подсказку всё равно отдаём: она ничего не блокирует.
    }
    return HINT;
}

function main() {
    let raw = '';
    try {
        raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
        return;
    }
    if (!raw || !raw.trim()) return;

    const hint = evaluate(JSON.parse(raw));
    if (!hint) return;

    process.stdout.write(JSON.stringify({
        systemMessage: SCREEN,
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: hint,
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

module.exports = { evaluate, stateFile, STATE_DIR, HINT };
