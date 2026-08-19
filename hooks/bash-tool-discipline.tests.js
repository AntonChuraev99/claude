#!/usr/bin/env node
// Приёмка bash-tool-discipline.js. Запуск: node hooks/bash-tool-discipline.tests.js
//
// Кейсы держат две границы, на которых правило ломается в обе стороны:
// ложный deny на легитимном коротком sleep и ложная подсказка там, где Bash —
// единственный способ (сборка, git, пайплайн с | head). Подсказка, которая
// срабатывает не по делу, обесценивается и перестаёт читаться.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('./bash-tool-discipline.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        fn();
        pass++;
        console.log('PASS  ' + name);
    } catch (e) {
        fail++;
        console.log('FAIL  ' + name + '\n      ' + (e && e.message));
    }
}

// Уникальная сессия на кейс — иначе кулдаун подсказок глушит соседние проверки.
// pid в ключ не годится: Windows переиспользует его между быстрыми прогонами, и
// состояние прошлого запуска гасит подсказки в текущем (поймано мутационной матрицей).
let n = 0;
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sid = () => `test-${RUN}-${n++}`;

// --- sleep ---------------------------------------------------------------
check('долгий sleep блокируется', () => {
    const v = d.judge('sleep 300; python -m pytest', sid());
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/300/.test(v.reason));
});

check('sleep в минутах переводится в секунды', () => {
    assert.strictEqual(d.longSleepSeconds('sleep 5m'), 300);
    assert.strictEqual(d.longSleepSeconds('sleep 2h'), 7200);
});

check('короткий sleep разрешён', () => {
    assert.strictEqual(d.judge('sleep 5 && adb devices', sid()), null);
});

check('sleep ровно на пороге не блокируется', () => {
    assert.strictEqual(d.judge(`sleep ${d.SLEEP_DENY_THRESHOLD_S}`, sid()), null);
});

check('sleep после && тоже виден', () => {
    const v = d.judge('cd /repo && sleep 240 && gh run view', sid());
    assert.strictEqual(v.decision, 'deny');
});

check('слово sleep внутри пути не считается', () => {
    assert.strictEqual(d.longSleepSeconds('cat src/SleepTimer.kt'), 0);
    assert.strictEqual(d.longSleepSeconds('grep -rn "sleep 300" docs/'), 0);
});

// --- поиск по коду -------------------------------------------------------
check('grep по kotlin-исходникам получает подсказку про ast-index', () => {
    const v = d.judge('grep -rn "FooViewModel" --include=*.kt .', sid());
    assert.strictEqual(v.decision, 'allow');
    assert.ok(/ast-index usages/.test(v.context));
});

// Подсказка обязана оставаться подсказкой: вердикт `deny` на чтении или поиске
// заблокировал бы обычную работу, а тест на текст сообщения этого не заметит.
check('подсказки не блокируют команду', () => {
    assert.strictEqual(d.judge('grep -rn "Foo" --include=*.kt .', sid()).decision, 'allow');
    assert.strictEqual(d.judge('cat src/Foo.kt', sid()).decision, 'allow');
});

check('рекурсивный grep по логам и build/ подсказку не вызывает', () => {
    assert.strictEqual(d.judge('grep -rn "FATAL" logs/', sid()), null);
    assert.strictEqual(d.judge('grep -rni error build/reports/', sid()), null);
});

check('cat с редиректом и heredoc — это запись, не чтение', () => {
    assert.strictEqual(d.judge('cat > notes.md <<EOF', sid()), null);
    assert.strictEqual(d.judge('cat src/Foo.kt > /tmp/copy.kt', sid()), null);
});

check('sleep со второй строки многострочной команды виден', () => {
    assert.strictEqual(d.longSleepSeconds('echo start\nsleep 300\necho done'), 300);
});

check('ключ кулдауна не уводит запись состояния из каталога', () => {
    // Ключ уникален на прогон: с фиксированным именем состояние от прошлого
    // запуска попадает под кулдаун, и judge вернул бы null по чужой причине.
    const name = `evil-${RUN}`;
    const escaped = path.join(os.tmpdir(), '..', `${name}.json`);
    try { fs.unlinkSync(escaped); } catch (e) { /* его и не должно быть */ }
    const v = d.judge('grep -rn "Foo" --include=*.kt .', `../../${name}`);
    assert.ok(v && v.decision === 'allow', 'подсказка не выдалась — проверять нечего');
    assert.ok(!fs.existsSync(escaped), 'состояние записано за пределы каталога: ' + escaped);
});

check('cd-префикс не мешает распознать поиск', () => {
    const v = d.judge('cd "C:/repo/.claude/worktrees/x" && grep -rn "Foo" --include=*.ts src', sid());
    assert.ok(v && /ast-index/.test(v.context));
});

check('rg -r по дереву — тоже поиск по коду', () => {
    assert.ok(d.isCodeSearch('rg -rn "Repository" .'));
});

check('поиск по логам подсказку не вызывает', () => {
    assert.strictEqual(d.judge('grep "FATAL" build/reports/app.log', sid()), null);
});

// --- чтение файла --------------------------------------------------------
check('cat исходника получает подсказку про Read', () => {
    const v = d.judge('cat app/src/main/kotlin/Foo.kt', sid());
    assert.ok(v && /тулом Read/.test(v.context));
});

check('пайплайн с head — обрезка вывода, не чтение файла', () => {
    assert.strictEqual(d.judge('./gradlew :app:test 2>&1 | head -50', sid()), null);
    // Файл в аргументах чужой команды: head здесь режет вывод python, а не читает
    // config.yaml — Read тут неприменим, подсказка была бы ложной.
    assert.strictEqual(d.judge('python scripts/gen.py config.yaml | head -20', sid()), null);
});

// Без среза cd-префикса команда начинается с `cd`, и якорь `^` в isFileRead
// её не узнаёт — а именно в такой форме субагенты читают файлы в worktree.
check('cat после cd-префикса всё равно распознаётся как чтение', () => {
    const v = d.judge('cd "C:/repo/.claude/worktrees/x" && cat src/Foo.kt', sid());
    assert.ok(v && /тулом Read/.test(v.context));
});

check('sed -n по диапазону строк исходника — чтение', () => {
    assert.ok(d.isFileRead('sed -n "1,80p" build.gradle.kts'));
});

// --- то, что обязано остаться в Bash ------------------------------------
check('сборка не трогается', () => {
    assert.strictEqual(d.judge('./gradlew :feature:home:testDebugUnitTest', sid()), null);
});

check('git не трогается', () => {
    assert.strictEqual(d.judge('git diff --stat origin/main', sid()), null);
});

check('сам ast-index не трогается', () => {
    assert.strictEqual(d.judge('ast-index usages FooViewModel', sid()), null);
});

check('escape hatch снимает запрет sleep', () => {
    process.env.CLAUDE_ALLOW_SLEEP = '1';
    try {
        assert.strictEqual(d.judge('sleep 300', sid()), null);
    } finally {
        delete process.env.CLAUDE_ALLOW_SLEEP;
    }
    assert.strictEqual(d.judge('sleep 300', sid()).decision, 'deny');
});

check('пустая и мусорная команда безопасны', () => {
    assert.strictEqual(d.judge('', sid()), null);
    assert.strictEqual(d.judge(null, sid()), null);
    assert.strictEqual(d.judge('cd /repo &&', sid()), null);
});

// --- кулдаун -------------------------------------------------------------
check('вторая подсказка той же темы в рамках сессии молчит', () => {
    const s = sid();
    assert.ok(d.judge('grep -rn "A" --include=*.kt .', s));
    assert.strictEqual(d.judge('grep -rn "B" --include=*.kt .', s), null);
});

check('разные темы не глушат друг друга', () => {
    const s = sid();
    assert.ok(d.judge('grep -rn "A" --include=*.kt .', s));
    assert.ok(d.judge('cat Foo.kt', s));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
