#!/usr/bin/env node
// Приёмка docs-length-guard.js. Запуск: node hooks/docs-length-guard.tests.js
//
// Половина кейсов ниже — регрессии на дефекты, найденные ревью уже после «зелёной»
// разовой матрицы: заголовок и маркер внутри ```-фенса, `## Связанные файлы` внутри
// фенса (съедал документ целиком), маркер без числа, рост код-блоков на легаси,
// git через symlink, BOM, фенс в цитате. Разовый прогон их не удержит — тесты лежат
// рядом с хуком по той же причине, по которой существует сам хук.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'docs-length-guard.js');
const { analyze } = require('./docs-length-guard.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-tests-'));
const FM = '---\ntitle: t\nsummary: s\n---\n\n';
const words = (n, w = 'слово') => Array(n).fill(w).join(' ');
const fence = (n, lang = 'kotlin') => '```' + lang + '\n' + Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n```';

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

const codes = (md) => analyze(md).problems.map((p) => p.code).sort();

// ---------- анализатор ----------

check('документ сверх потолка ловится', () => {
    assert.ok(codes(FM + '# T\n\n## Решение\n\n' + words(500)).includes('doc'));
});

check('короткий документ молчит', () => {
    assert.deepStrictEqual(codes(FM + '# T\n\n## Решение\n\n' + words(100)), []);
});

check('секция Проблема сверх потолка', () => {
    assert.ok(codes(FM + '## Проблема / Контекст\n\n' + words(120)).includes('section:Проблема / Контекст'));
});

check('секция Контекст без слова Проблема тоже считается', () => {
    assert.ok(codes(FM + '## Контекст\n\n' + words(120)).includes('section:Проблема / Контекст'));
});

check('## Решения (другое слово) не матчится как ## Решение', () => {
    assert.ok(!codes(FM + '## Решения\n\n' + words(300)).includes('section:Решение'));
});

check('секция первой строкой документа', () => {
    assert.ok(codes(FM + '## Проблема\n\n' + words(120)).length > 0);
});

check('подсекция ### входит в родительскую ##', () => {
    const md = FM + '## Решение\n\n' + words(80) + '\n\n### Деталь\n\n' + words(80);
    assert.ok(codes(md).includes('section:Решение'));
});

check('код-блок длиннее потолка', () => {
    assert.ok(codes(FM + '## Решение\n\nкратко\n\n' + fence(20)).includes('codeblock'));
});

check('два код-блока в одной секции', () => {
    assert.ok(codes(FM + '## Решение\n\nкратко\n\n' + fence(2) + '\n\n' + fence(2)).includes('codeper'));
});

check('незакрытый фенс считается блоком до конца документа', () => {
    const md = FM + '## Решение\n\nкратко\n\n```kotlin\n' + Array.from({ length: 21 }, (_, i) => `l ${i}`).join('\n');
    assert.ok(codes(md).includes('codeblock'));
});

check('``` не закрывает ~~~', () => {
    const md = FM + '## Решение\n\n~~~\n' + Array.from({ length: 20 }, () => '```').join('\n') + '\n~~~';
    assert.ok(codes(md).includes('codeblock'));
});

check('блок Суть длиннее трёх строк', () => {
    assert.ok(codes(FM + '**Суть:** a\nb\nc\nd\n\n## Решение\n\nкратко').includes('sut'));
});

// --- регрессии на фенсы (найдено ревью)

check('## внутри фенса не считается секцией', () => {
    const md = FM + '## Решение\n\nкратко\n\n````md\n## Решение\n\n' + words(500) + '\n````';
    assert.ok(!codes(md).includes('section:Решение'));
});

check('маркер внутри фенса не глушит проверку', () => {
    const md = FM + '## Решение\n\n' + words(500) + '\n\n```md\n> Объём: 900 слов — пример\n```';
    assert.ok(analyze(md).marker === null);
});

check('## Связанные файлы внутри фенса не съедает документ', () => {
    const md = FM + '## Решение\n\n' + words(500) + '\n\n```md\n## Связанные файлы\n- a.kt\n```\n\n## Почему именно так\n\nхвост';
    assert.ok(codes(md).includes('doc'), 'документ на 500 слов обязан быть виден');
});

check('## Связанные файлы вне потолка документа', () => {
    const md = FM + '## Решение\n\n' + words(100) + '\n\n## Связанные файлы\n\n' + words(500);
    assert.deepStrictEqual(codes(md), []);
});

check('фенс внутри цитаты распознаётся', () => {
    const md = FM + '## Решение\n\nкратко\n\n> ```kotlin\n' + Array.from({ length: 20 }, (_, i) => `> l ${i}`).join('\n') + '\n> ```';
    assert.ok(codes(md).includes('codeblock'));
});

// --- маркер

check('маркер с числом снимает проверку', () => {
    const md = FM + '# T\n\n> Объём: 504 слов — матрица\n\n## Решение\n\n' + words(500);
    const a = analyze(md);
    assert.strictEqual(a.marker.declared, 504);
});

check('маркер с тильдой распознаёт число', () => {
    const a = analyze(FM + '# T\n\n> Объём: ~5600 слов — матрица\n\n## Решение\n\n' + words(500));
    assert.strictEqual(a.marker.declared, 5600);
});

check('маркер без числа НЕ действует', () => {
    const a = analyze(FM + '# T\n\n> Объём: много слов — матрица\n\n## Решение\n\n' + words(500));
    assert.strictEqual(a.marker, null);
});

check('маркер ниже пятнадцатой строки не действует', () => {
    const md = FM + '# T\n' + '\nстрока'.repeat(20) + '\n> Объём: 999 слов — поздно\n\n## Решение\n\n' + words(500);
    assert.strictEqual(analyze(md).marker, null);
});

// --- frontmatter, BOM, переводы строк

check('BOM без frontmatter не ломает поиск секции', () => {
    assert.ok(codes('﻿## Проблема\n\n' + words(120)).length > 0);
});

check('--- как горизонтальная черта не считается frontmatter', () => {
    assert.ok(codes('---\n\n' + words(300) + '\n\n---\n\n' + words(300)).includes('doc'));
});

check('CRLF считается так же, как LF', () => {
    const lf = FM + '## Решение\n\n' + words(500);
    assert.deepStrictEqual(codes(lf.replace(/\n/g, '\r\n')), codes(lf));
});

// --- сравнение версий

check('рост код-блоков виден при неизменном числе слов', () => {
    const before = analyze(FM + '## Решение\n\n' + words(500));
    const after = analyze(FM + '## Решение\n\n' + words(500) + '\n\n' + fence(100));
    const { compare } = require('./docs-length-guard.js');
    assert.ok(compare(after, before), 'новое нарушение по код-блоку обязано быть замечено');
});

check('легаси без ухудшения молчит', () => {
    const { compare } = require('./docs-length-guard.js');
    const before = analyze(FM + '## Решение\n\n' + words(500));
    const after = analyze(FM + '## Решение\n\n' + words(505));
    assert.strictEqual(compare(after, before), null);
});

// ---------- scope-фильтр ----------

const { resolveTarget } = require('./docs-length-guard.js');
const P = (fp, cwd) => resolveTarget({ tool_input: { file_path: fp }, cwd: cwd || ROOT });

check('docs/solutions в области', () => assert.ok(P(path.join(ROOT, 'docs', 'solutions', 'a.md'))));
check('docs/decisions в области', () => assert.ok(P(path.join(ROOT, 'docs', 'decisions', 'a.md'))));
check('docs/active вне области', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'active', 'a.md')), null));
check('вложенный подкаталог вне области', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'solutions', 'sub', 'a.md')), null));
check('mydocs/solutions вне области', () => assert.strictEqual(P(path.join(ROOT, 'mydocs', 'solutions', 'a.md')), null));
check('docs/analytics/decisions вне области', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'analytics', 'decisions', 'a.md')), null));
check('INDEX.md пропускается', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'solutions', 'INDEX.md')), null));
check('INDEX-archive пропускается', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'solutions', 'INDEX-archive-2026.md')), null));
check('INDEXING-strategy НЕ пропускается', () => assert.ok(P(path.join(ROOT, 'docs', 'solutions', 'INDEXING-strategy.md'))));
check('не .md вне области', () => assert.strictEqual(P(path.join(ROOT, 'docs', 'solutions', 'a.txt')), null));
check('относительный путь резолвится от cwd', () => assert.ok(P('docs/solutions/a.md', ROOT)));

// ---------- end-to-end через stdin ----------

function run(payload, opts) {
    const stdin = payload === null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const r = spawnSync(process.execPath, [HOOK], Object.assign({ input: stdin, encoding: 'utf8' }, opts || {}));
    return (r.stdout || '').trim();
}

const GIT = path.join(ROOT, 'repo');
fs.mkdirSync(path.join(GIT, 'docs', 'solutions'), { recursive: true });
const g = (...a) => execFileSync('git', ['-C', GIT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
g('init', '-q');
g('config', 'user.email', 'test@example.invalid');
g('config', 'user.name', 'test');
const legacy = path.join(GIT, 'docs', 'solutions', 'legacy.md');
const fresh = path.join(GIT, 'docs', 'solutions', 'fresh.md');
fs.writeFileSync(legacy, FM + '## Решение\n\n' + words(900), 'utf8');
fs.writeFileSync(fresh, FM + '## Решение\n\n' + words(100), 'utf8');
g('add', '-A');
g('commit', '-qm', 'init');

const W = (p, extra) => ({ tool_name: 'Write', tool_input: Object.assign({ file_path: p }, extra || {}), cwd: GIT });

check('e2e: новый файл вне истории → вердикт', () => {
    const nf = path.join(GIT, 'docs', 'solutions', 'brand-new.md');
    fs.writeFileSync(nf, FM + '## Решение\n\n' + words(600), 'utf8');
    assert.ok(run(W(nf)).includes('Бюджет длины документации превышен'));
});

check('e2e: правка вывела документ за бюджет', () => {
    fs.writeFileSync(fresh, FM + '## Решение\n\n' + words(600), 'utf8');
    assert.ok(run(W(fresh)).includes('вывела документ за бюджет'));
});

check('e2e: легаси без ухудшения → тишина', () => {
    fs.writeFileSync(legacy, FM + '## Решение\n\n' + words(905), 'utf8');
    assert.strictEqual(run(W(legacy)), '');
});

check('e2e: легаси выросло → вердикт', () => {
    fs.writeFileSync(legacy, FM + '## Решение\n\n' + words(1500), 'utf8');
    assert.ok(run(W(legacy)).includes('вырос'));
});

check('e2e: легаси получило новый код-блок → вердикт', () => {
    g('checkout', '-q', '--', 'docs/solutions/legacy.md');
    fs.writeFileSync(legacy, FM + '## Решение\n\n' + words(900) + '\n\n' + fence(100), 'utf8');
    assert.ok(run(W(legacy)).includes('добавила нарушение'));
});

check('e2e: путь вне git-репозитория → тишина (git непригоден, не «новый файл»)', () => {
    const outside = path.join(ROOT, 'plain', 'docs', 'solutions', 'x.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, FM + '## Решение\n\n' + words(600), 'utf8');
    assert.strictEqual(run(Object.assign(W(outside), { cwd: ROOT })), '');
});

check('e2e: репозиторий без коммитов → тишина', () => {
    const empty = path.join(ROOT, 'empty');
    fs.mkdirSync(path.join(empty, 'docs', 'solutions'), { recursive: true });
    execFileSync('git', ['-C', empty, 'init', '-q'], { stdio: 'ignore' });
    const f = path.join(empty, 'docs', 'solutions', 'x.md');
    fs.writeFileSync(f, FM + '## Решение\n\n' + words(600), 'utf8');
    assert.strictEqual(run(Object.assign(W(f), { cwd: empty })), '');
});

check('e2e: Read не наш инструмент', () => {
    assert.strictEqual(run({ tool_name: 'Read', tool_input: { file_path: legacy }, cwd: GIT }), '');
});

check('e2e: MultiEdit ловится', () => {
    const nf = path.join(GIT, 'docs', 'solutions', 'multi.md');
    fs.writeFileSync(nf, FM + '## Решение\n\n' + words(600), 'utf8');
    assert.ok(run({ tool_name: 'MultiEdit', tool_input: { file_path: nf }, cwd: GIT }).length > 0);
});

check('e2e: Edit-сокращение молчит', () => {
    const nf = path.join(GIT, 'docs', 'solutions', 'shrink.md');
    fs.writeFileSync(nf, FM + '## Решение\n\n' + words(600), 'utf8');
    assert.strictEqual(run(W(nf, { old_string: words(40), new_string: 'кратко' })), '');
});

check('e2e: файла нет на диске', () => {
    assert.strictEqual(run(W(path.join(GIT, 'docs', 'solutions', 'ghost.md'))), '');
});

check('e2e: пустой stdin', () => assert.strictEqual(run(null), ''));
check('e2e: мусор вместо JSON', () => assert.strictEqual(run('garbage'), ''));

check('e2e: вывод — валидный JSON контракта PostToolUse', () => {
    const nf = path.join(GIT, 'docs', 'solutions', 'contract.md');
    fs.writeFileSync(nf, FM + '## Решение\n\n' + words(600), 'utf8');
    const parsed = JSON.parse(run(W(nf)));
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Потолки заданы'));
});

check('e2e: exit code всегда 0', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'garbage', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
