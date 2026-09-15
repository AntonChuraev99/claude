#!/usr/bin/env node
// Приёмка docs-facts-guard.js. Запуск: node hooks/docs-facts-guard.tests.js
//
// Два слоя: извлечение претензий (чистые функции) и e2e через временный git-репозиторий —
// CLI с кодами выхода и хук через stdin. Кейсы на ложные срабатывания (бренды в прозе,
// frontmatter, маркеры, легаси в HEAD) стоят здесь же: хук с шумом выключают, а не чинят.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'docs-facts-guard.js');
const { extractClaims, resolveTarget } = require('./docs-facts-guard.js');

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

const FM = '---\ntitle: t\nkeywords: [fakeKeyword, snake_keyword]\n---\n\n';
const toks = (md, cls) => extractClaims(md).filter((c) => !cls || c.cls === cls).map((c) => c.token);

// ---------- извлечение претензий ----------

check('camelCase в прозе — IDENT', () => assert.deepStrictEqual(toks('вызов setEnabled в координаторе', 'IDENT'), ['setEnabled']));
check('snake_case в прозе — IDENT', () => assert.deepStrictEqual(toks('событие screen_opened шлётся', 'IDENT'), ['screen_opened']));
check('PascalCase в прозе — не претензия (бренды)', () => assert.deepStrictEqual(toks('через RevenueCat и GitHub', 'IDENT'), []));
check('PascalCase в бэктиках — IDENT', () => assert.deepStrictEqual(toks('класс `UiState` пуст', 'IDENT'), ['UiState']));
check('вызов foo() — IDENT без скобок', () => assert.deepStrictEqual(toks('`isPlayableNow()` вернул', 'IDENT'), ['isPlayableNow']));
check('UPPER_SNAKE — IDENT', () => assert.deepStrictEqual(toks('флаг MAX_RETRIES', 'IDENT'), ['MAX_RETRIES']));
check('dotted-идентификатор — IDENT, домен — нет', () => {
    assert.deepStrictEqual(toks('`kotlinx.coroutines.flow.Flow` и code.claude.com', 'IDENT'), ['kotlinx.coroutines.flow.Flow']);
});
check('стоп-слова не претензия', () => assert.deepStrictEqual(toks('`return` `import` `commonMain` `README`', 'IDENT'), []));
check('однословный PascalCase в бэктиках — не претензия', () => assert.deepStrictEqual(toks('`Loading` и `Solution`', 'IDENT'), []));
check('плейсхолдеры <…> — не претензии', () => assert.deepStrictEqual(toks('`node <script> <doc.md> --base <BASE_SHA>` и [a](<path-from-INDEX>)'), []));
check('диапазон — не замер', () => assert.deepStrictEqual(toks('slug — 3-5 слов, 3–8 термов', 'NUMBER'), []));
check('короткие и обычные слова не претензия', () => assert.deepStrictEqual(toks('`id` `result` `value` слово', 'IDENT'), []));
check('путь с расширением — PATH', () => assert.deepStrictEqual(toks('файл `core/data/Foo.kt` и src/Bar.kt', 'PATH'), ['core/data/Foo.kt', 'src/Bar.kt']));
check('каталог со слэшем — PATH', () => assert.deepStrictEqual(toks('лежит в `docs/active/`', 'PATH'), ['docs/active/']));
check('относительная ссылка — LINK, http — нет', () => {
    assert.deepStrictEqual(toks('см. [a](../solutions/x.md#sec) и [b](https://example.com/y.md)', 'LINK'), ['../solutions/x.md']);
});
check('индексация в коде и бэктиках — не ссылка', () => {
    assert.deepStrictEqual(toks('```js\nhandlers[type](evt)\n```\nи `map[key](arg)`', 'LINK'), []);
});
check('маркер не закрывает LINK', () => assert.deepStrictEqual(toks('см. [a](../nope.md) (не проверено)', 'LINK'), ['../nope.md']));
check('путь с обратным слэшем и с точечным сегментом — PATH', () => {
    assert.deepStrictEqual(toks('`app\\src\\Ghost.kt` и `.github/workflows/deploy.yml`', 'PATH'), ['app\\src\\Ghost.kt', '.github/workflows/deploy.yml']);
});
check('единица не режет кириллическое слово', () => assert.deepStrictEqual(toks('4 секции и 5 словарей', 'NUMBER'), []));
check('число с единицей — NUMBER', () => assert.deepStrictEqual(toks('лог — 740 слов, сборка 2m14s, −26% к baseline', 'NUMBER'), ['740 слов', '2m14s', '−26%']));
check('дата и версия — не NUMBER', () => assert.deepStrictEqual(toks('2026-08-05, версия 2.1.272, 5 файлов', 'NUMBER'), ['5 файлов']));
check('маркер > Объём не считается замером', () => assert.deepStrictEqual(toks('> Объём: 619 слов — матрица', 'NUMBER'), []));
check('число с названным источником — не претензия', () => assert.deepStrictEqual(toks('82.2% (источник: Amplitude, chart 123)', 'NUMBER'), []));
check('строка с источником снимает IDENT и PATH, но не LINK', () => {
    assert.deepStrictEqual(extractClaims('поле `maxTurns` и `x/y.kt` (источник: docs) — см. [a](../nope.md)').map((c) => c.cls), ['LINK']);
});
check('маркер с причиной в скобках снимает строку', () => assert.deepStrictEqual(toks('`finishReason` (не проверено — Gemini API), 12 мс (приблизительно, по логу)'), []));
check('протокольные статусы — не претензия', () => assert.deepStrictEqual(toks('вернул `STATUS: NEEDS_INPUT`', 'IDENT'), []));
check('маркер TODO: сверить снимает строку', () => assert.deepStrictEqual(toks('вызов fakeName — TODO: сверить с Foo.kt'), []));
check('маркер (не проверено) снимает строку', () => assert.deepStrictEqual(toks('`UseParallelGC` (не проверено)'), []));
check('маркер (приблизительно) снимает строку', () => assert.deepStrictEqual(toks('740 слов (приблизительно)'), []));
check('frontmatter не разбирается', () => assert.deepStrictEqual(toks(FM + 'текст'), []));
check('номера строк учитывают frontmatter', () => {
    const c = extractClaims(FM + 'вызов setEnabled');
    assert.strictEqual(c[0].line, 6);
});
check('токены внутри фенса — претензии', () => {
    assert.deepStrictEqual(toks('```kotlin\nval x = fetchProfile()\n```', 'IDENT'), ['fetchProfile']);
});
check('повтор токена — одна претензия', () => assert.strictEqual(toks('setEnabled и снова setEnabled', 'IDENT').length, 1));
check('URL в прозе не разбирается', () => assert.deepStrictEqual(toks('см. https://example.com/fooBar/x_y.md'), []));
check('CRLF как LF', () => assert.deepStrictEqual(toks('a\r\nвызов setEnabled\r\n', 'IDENT'), ['setEnabled']));

// ---------- scope-фильтр хука ----------

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dfg-tests-'));
const P = (fp) => resolveTarget({ tool_input: { file_path: fp }, cwd: ROOT });
check('docs/solutions в области', () => assert.ok(P(path.join(ROOT, 'docs', 'solutions', 'a.md'))));
check('docs/decisions в области', () => assert.ok(P(path.join(ROOT, 'docs', 'decisions', 'a.md'))));
check('docs/archive с подкаталогом в области', () => assert.ok(P(path.join(ROOT, 'docs', 'archive', '2026', 'a.md'))));
check('docs/active вне области', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'active', 'a.md')), null));
check('INDEX.md пропускается', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'solutions', 'INDEX.md')), null));
check('mydocs вне области', () => assert.strictEqual(P(path.join(ROOT, 'mydocs', 'solutions', 'a.md')), null));
check('относительный путь от cwd', () => assert.ok(P('docs/solutions/a.md')));

// ---------- e2e: временный репозиторий ----------

const GIT = path.join(ROOT, 'repo');
fs.mkdirSync(path.join(GIT, 'src'), { recursive: true });
fs.mkdirSync(path.join(GIT, 'docs', 'solutions'), { recursive: true });
fs.mkdirSync(path.join(GIT, 'docs', 'archive'), { recursive: true });
fs.mkdirSync(path.join(GIT, 'docs', 'active'), { recursive: true });
const g = (...a) => execFileSync('git', ['-C', GIT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
g('init', '-q');
g('config', 'user.email', 'test@example.invalid');
g('config', 'user.name', 'test');
fs.writeFileSync(path.join(GIT, 'src', 'Foo.kt'), 'class UiState\nfun setEnabled() {}\nval user_name = 1\nfun legacyCall() {}\n', 'utf8');
fs.writeFileSync(path.join(GIT, '.gitignore'), 'stats/\n', 'utf8');
fs.mkdirSync(path.join(GIT, 'stats'));
fs.writeFileSync(path.join(GIT, 'stats', 'log.md'), 'ignored but real\n', 'utf8');
fs.writeFileSync(path.join(GIT, 'docs', 'solutions', 'other.md'), '# other\n', 'utf8');
const legacy = path.join(GIT, 'docs', 'solutions', 'legacy.md');
fs.writeFileSync(legacy, '# legacy\n\nстарый вымысел ancientFake остаётся\n', 'utf8');
g('add', '-A');
g('commit', '-qm', 'init');
const BASE = g('rev-parse', 'HEAD').trim();

function cli(args) {
    const r = spawnSync(process.execPath, [HOOK, ...args], { encoding: 'utf8', cwd: GIT });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function hook(payload) {
    const stdin = payload === null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', cwd: GIT });
    return (r.stdout || '').trim();
}
const W = (p, extra) => ({ tool_name: 'Write', tool_input: Object.assign({ file_path: p }, extra || {}), cwd: GIT });

const doc = path.join(GIT, 'docs', 'solutions', 'doc.md');
fs.writeFileSync(
    doc,
    FM +
        '# Док\n\n' +
        'Реальные: `setEnabled`, user_name, `UiState`, файл `src/Foo.kt`, [other](other.md), `stats/log.md`.\n' +
        'Выдуманные: `isPlayableNow()`, путь `src/Bar.kt`, [битая](../missing.md).\n' +
        'Замер: лог 740 слов.\n',
    'utf8'
);

check('e2e CLI: реальные факты не репортятся, выдуманные — по классам', () => {
    const r = cli([doc, '--json']);
    assert.strictEqual(r.code, 1, r.out);
    const j = JSON.parse(r.out);
    const f = j.results[0].findings.map((x) => `${x.cls}:${x.token}`).sort();
    assert.deepStrictEqual(f, ['IDENT:isPlayableNow', 'LINK:../missing.md', 'NUMBER:740 слов', 'PATH:src/Bar.kt']);
});

check('e2e CLI: чистый документ → exit 0', () => {
    const clean = path.join(GIT, 'docs', 'solutions', 'clean.md');
    fs.writeFileSync(clean, '# ok\n\n`setEnabled` из `src/Foo.kt`\n', 'utf8');
    const r = cli([clean]);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.out.includes('TOTAL: 0'));
});

check('e2e CLI: Class.method подтверждается по сегментам, путь — хвостом и каталогом', () => {
    const d = path.join(GIT, 'docs', 'solutions', 'dotted.md');
    fs.writeFileSync(d, '# d\n\n`UiState.setEnabled` и `Foo.kt` в `src/`, но `UiState.ghostMethod`\n', 'utf8');
    const r = cli([d, '--json']);
    const f = JSON.parse(r.out).results[0].findings.map((x) => `${x.cls}:${x.token}`);
    assert.deepStrictEqual(f, ['IDENT:UiState.ghostMethod']);
});

check('e2e CLI: голое имя — по basename, «модуль/Файл» — под каталогом, чужой каталог — PATH', () => {
    fs.mkdirSync(path.join(GIT, 'src', 'sub', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(GIT, 'src', 'sub', 'inner', 'Bar.kt'), 'class Bar\n', 'utf8');
    const d = path.join(GIT, 'docs', 'solutions', 'dirs.md');
    fs.writeFileSync(d, '# d\n\n`Foo.kt` есть, `src/sub/Bar.kt` — сокращение, `wrong/dir/Foo.kt` — нет, `src/Foo.kt` — хвост\n', 'utf8');
    const f = JSON.parse(cli([d, '--json']).out).results[0].findings.map((x) => `${x.cls}:${x.token}`);
    assert.deepStrictEqual(f, ['PATH:wrong/dir/Foo.kt']);
});

check('e2e CLI: --base фильтрует легаси документа, --all — нет', () => {
    const old = path.join(GIT, 'docs', 'solutions', 'old.md');
    fs.writeFileSync(old, '# old\n\nсм. [прошлогоднее](../missing-old.md)\n', 'utf8');
    g('add', 'docs/solutions/old.md');
    g('commit', '-qm', 'legacy doc');
    const baseSha = g('rev-parse', 'HEAD').trim();
    fs.writeFileSync(old, '# old\n\nсм. [прошлогоднее](../missing-old.md)\nновый `brandNewFake`\n', 'utf8');
    const scoped = JSON.parse(cli([old, '--base', baseSha, '--json']).out).results[0].findings.map((x) => `${x.cls}:${x.token}`);
    assert.deepStrictEqual(scoped, ['IDENT:brandNewFake']);
    const full = JSON.parse(cli([old, '--base', baseSha, '--all', '--json']).out).results[0].findings.map((x) => x.cls).sort();
    assert.deepStrictEqual(full, ['IDENT', 'LINK']);
});

check('e2e CLI: untracked-файл — источник', () => {
    fs.writeFileSync(path.join(GIT, 'src', 'New.kt'), 'fun brandNewFn() {}\n', 'utf8');
    const d = path.join(GIT, 'docs', 'solutions', 'untracked.md');
    fs.writeFileSync(d, '# u\n\n`brandNewFn` и `src/New.kt`\n', 'utf8');
    assert.strictEqual(cli([d]).code, 0);
});

check('e2e CLI: другой документ — не источник', () => {
    fs.writeFileSync(path.join(GIT, 'docs', 'solutions', 'other.md'), '# other\n\n`copiedFake`\n', 'utf8');
    const d = path.join(GIT, 'docs', 'solutions', 'copy.md');
    fs.writeFileSync(d, '# c\n\n`copiedFake`\n', 'utf8');
    assert.strictEqual(cli([d]).code, 1);
});

check('e2e CLI: --base — удалённое за задачу имя остаётся фактом', () => {
    fs.writeFileSync(path.join(GIT, 'src', 'Foo.kt'), 'class UiState\nfun setEnabled() {}\nval user_name = 1\n', 'utf8');
    g('add', 'src/Foo.kt');
    g('commit', '-qm', 'remove legacyCall');
    const d = path.join(GIT, 'docs', 'solutions', 'removed.md');
    fs.writeFileSync(d, '# r\n\nубран `legacyCall`\n', 'utf8');
    assert.strictEqual(cli([d]).code, 1, 'без base — не найдено');
    assert.strictEqual(cli([d, '--base', BASE]).code, 0, 'с base — найдено в диффе');
});

check('e2e CLI: docs/active тоже проверяется по явному пути', () => {
    const d = path.join(GIT, 'docs', 'active', 'task.md');
    fs.writeFileSync(d, '# t\n\n`plannedClassName`\n', 'utf8');
    assert.strictEqual(cli([d]).code, 1);
});

check('e2e CLI: несуществующий документ → PATH', () => {
    const r = cli([path.join(GIT, 'docs', 'solutions', 'ghost.md'), '--json']);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(JSON.parse(r.out).results[0].findings[0].cls, 'PATH');
});

check('e2e hook: Write нового документа → вердикт с выдуманным', () => {
    const out = hook(W(doc));
    assert.ok(out.includes('isPlayableNow'), out);
    assert.ok(!out.includes('setEnabled'));
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
});

check('e2e hook: Edit — только претензии из new_string', () => {
    const out = hook(W(doc, { old_string: 'x', new_string: 'добавлен `setEnabled`' }));
    assert.strictEqual(out, '');
    const out2 = hook(W(doc, { old_string: 'x', new_string: 'добавлен `isPlayableNow`' }));
    assert.ok(out2.includes('isPlayableNow'));
    assert.ok(!out2.includes('src/Bar.kt'));
});

check('e2e hook: легаси-вымысел в HEAD не репортится, новый — да', () => {
    fs.writeFileSync(legacy, '# legacy\n\nстарый вымысел ancientFake остаётся\n', 'utf8');
    assert.strictEqual(hook(W(legacy)), '');
    fs.writeFileSync(legacy, '# legacy\n\nстарый вымысел ancientFake остаётся\nновый freshFake\n', 'utf8');
    const out = hook(W(legacy));
    assert.ok(out.includes('freshFake'));
    assert.ok(!out.includes('ancientFake'));
});

check('e2e hook: docs/active вне области хука', () => {
    const d = path.join(GIT, 'docs', 'active', 'task.md');
    assert.strictEqual(hook(W(d)), '');
});

check('e2e hook: docs/archive в области', () => {
    const d = path.join(GIT, 'docs', 'archive', 'arch.md');
    fs.writeFileSync(d, '# a\n\n`archivedFake`\n', 'utf8');
    assert.ok(hook(W(d)).includes('archivedFake'));
});

check('e2e hook: Read не наш инструмент', () => assert.strictEqual(hook({ tool_name: 'Read', tool_input: { file_path: doc }, cwd: GIT }), ''));
check('e2e hook: файла нет на диске → тишина', () => assert.strictEqual(hook(W(path.join(GIT, 'docs', 'solutions', 'ghost.md'))), ''));
check('e2e hook: вне git → тишина', () => {
    const outside = path.join(ROOT, 'plain', 'docs', 'solutions', 'x.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '# x\n\n`someFakeName`\n', 'utf8');
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: outside }, cwd: ROOT }), encoding: 'utf8' });
    assert.strictEqual((r.stdout || '').trim(), '');
});
check('e2e hook: пустой stdin', () => assert.strictEqual(hook(null), ''));
check('e2e hook: мусор вместо JSON', () => assert.strictEqual(hook('garbage'), ''));
check('e2e hook: exit code всегда 0', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'garbage', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
