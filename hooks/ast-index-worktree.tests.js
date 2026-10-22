#!/usr/bin/env node
// Tests for ast-index-worktree.js and its wiring in credentials-guard-prefilter.js.
//
// Pin: внутри `.claude/worktrees/<slug>` поисковые вызовы ast-index получают
// `AST_INDEX_DB_PATH` с индексом основного checkout'а — bash префиксом каждого
// вызова, PowerShell одной строкой в начале команды. Основной checkout, команды
// управления индексом, текст команды, явная переменная или флаг, worktree со
// своим индексом и основной checkout без индекса — без изменений. Сквозной
// прогон префильтра проверяет, что подстановка доезжает до `updatedInput`.
//
// Usage: node hooks/ast-index-worktree.tests.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Кэш ast-index подменяется фикстурой через его же переменную: прогон не должен
// зависеть от индексов на машине разработчика.
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwt-'));
const FX_CACHE = path.join(FX, 'cache');
fs.mkdirSync(FX_CACHE);
process.env.AST_INDEX_CACHE_DIR = FX_CACHE;

const { worktreeIndexCommand } = require('./ast-index-worktree.js');
const { astIndexHash } = require('./bash-tool-discipline.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        pass++;
    } catch (e) {
        console.log(`  FAIL ${name}\n    ${e.message}`);
        fail++;
    }
}

// Возвращает путь к фикстурной базе в той форме, в какой его подставляет модуль.
function fakeIndex(dir, bytes) {
    const at = path.join(FX_CACHE, astIndexHash(fs.realpathSync.native(dir)));
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, 'index.db'), Buffer.alloc(bytes));
    return path.join(at, 'index.db').replace(/\\/g, '/');
}

function fakeRepo(name) {
    const dir = path.join(FX, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
}

function fakeWorktree(main, slug) {
    const wt = path.join(main, '.claude', 'worktrees', slug);
    fs.mkdirSync(path.join(wt, 'web'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ../../../.git/worktrees/${slug}\n`);
    return wt;
}

const MAIN = fakeRepo('proj');
const DB = fakeIndex(MAIN, 20000);
const WT = fakeWorktree(MAIN, 'fix-x');
const P = `AST_INDEX_DB_PATH='${DB}' `;

const run = (command, cwd, shell) => {
    const r = worktreeIndexCommand(command, cwd === undefined ? WT : cwd, { shell });
    return r ? r.command : null;
};

console.log('=== bash в worktree: префикс перед каждым поисковым вызовом ===');
check('поиск в корне worktree', () => {
    assert.strictEqual(run('ast-index usages PurchaseGate'), `${P}ast-index usages PurchaseGate`);
});
check('подкаталог worktree, posix-разделители', () => {
    const posix = path.join(WT, 'web').replace(/\\/g, '/');
    assert.strictEqual(run('ast-index search Foo', posix), `${P}ast-index search Foo`);
});
check('каждый вызов цепочки, конвейер не мешает', () => {
    assert.strictEqual(
        run('ast-index refs A && ast-index explore B | head -20'),
        `${P}ast-index refs A && ${P}ast-index explore B | head -20`,
    );
});
check('cd в worktree из основного checkout', () => {
    assert.strictEqual(run(`cd "${WT}" && ast-index symbol Foo`, MAIN), `cd "${WT}" && ${P}ast-index symbol Foo`);
});
check('глобальная опция до подкоманды и ast-index.exe', () => {
    assert.strictEqual(run('ast-index --format json search Foo'), `${P}ast-index --format json search Foo`);
    assert.strictEqual(run('ast-index.exe callers onClick'), `${P}ast-index.exe callers onClick`);
});
check('подстановка $(…) — вызов внутри неё', () => {
    assert.strictEqual(run('echo "$(ast-index stats)"'), null, 'внутри "…" — текст по маске');
    assert.strictEqual(run('x=$(ast-index stats)'), `x=$(${P}ast-index stats)`);
});
check('в смешанной цепочке префикс только у поиска', () => {
    assert.strictEqual(run('ast-index update && ast-index usages Foo'), `ast-index update && ${P}ast-index usages Foo`);
});
check('перевод строки и ключевые слова bash начинают новую команду', () => {
    assert.strictEqual(
        run('ast-index usages A\nast-index usages B'),
        `${P}ast-index usages A\n${P}ast-index usages B`,
    );
    assert.strictEqual(
        run('for s in A B; do ast-index usages $s; done'),
        `for s in A B; do ${P}ast-index usages $s; done`,
    );
    assert.strictEqual(
        run('if ast-index class Foo | grep -q Foo; then ast-index refs Foo; fi'),
        `if ${P}ast-index class Foo | grep -q Foo; then ${P}ast-index refs Foo; fi`,
    );
});
check('graph без build — чтение', () => {
    assert.strictEqual(run('ast-index graph dependents Foo'), `${P}ast-index graph dependents Foo`);
});
check('пустой индекс worktree (только схема) — подставляем', () => {
    const wt = fakeWorktree(MAIN, 'schema-only');
    fakeIndex(wt, 12288);
    assert.strictEqual(run('ast-index usages Foo', wt), `${P}ast-index usages Foo`);
});
check('worktree самого ~/.claude: .claude/.claude/worktrees/<slug>', () => {
    const home = fakeRepo(path.join('home', '.claude'));
    const db = fakeIndex(home, 20000);
    const wt = fakeWorktree(home, 'hook-fix');
    assert.strictEqual(run('ast-index usages Foo', wt), `AST_INDEX_DB_PATH='${db}' ast-index usages Foo`);
});

console.log('=== PowerShell в worktree: одна строка в начале команды ===');
check('оператор вызова и ;', () => {
    assert.strictEqual(
        run('& ast-index usages Foo; ast-index stats', WT, 'powershell'),
        `$env:AST_INDEX_DB_PATH='${DB}'; & ast-index usages Foo; ast-index stats`,
    );
});
check('команда с управлением индексом не меняется целиком', () => {
    // Переменная PowerShell действует до конца вызова: `update` с чужим путём
    // переписал бы индекс основного checkout'а файлами worktree.
    assert.strictEqual(run('ast-index usages Foo; ast-index update', WT, 'powershell'), null);
});
check('запись вне позиции команды тоже снимает подстановку (ревью Spec)', () => {
    const ps = (c) => run(c, WT, 'powershell');
    assert.strictEqual(ps('ast-index usages Foo\nast-index update'), null, 'перевод строки');
    assert.strictEqual(ps('ast-index usages Foo; if ($?) { ast-index update }'), null, 'блок в скобках');
    assert.strictEqual(ps('$x = ast-index update; ast-index usages Foo'), null, 'присваивание');
    assert.strictEqual(ps('ast-index usages Foo; ast-index graph build'), null, 'graph build');
    assert.strictEqual(ps('ast-index hotspots --collect'), null, '--collect');
});
check('слово записи в строке PowerShell — текст, подстановка остаётся', () => {
    assert.strictEqual(
        run("Write-Output 'update later'; ast-index usages Foo", WT, 'powershell'),
        `$env:AST_INDEX_DB_PATH='${DB}'; Write-Output 'update later'; ast-index usages Foo`,
    );
});

console.log('=== команда не меняется ===');
check('основной checkout', () => {
    assert.strictEqual(run('ast-index usages Foo', MAIN), null);
});
check('каталог worktrees без имени', () => {
    assert.strictEqual(run('ast-index usages Foo', path.join(MAIN, '.claude', 'worktrees')), null);
});
check('cd из worktree в основной checkout', () => {
    assert.strictEqual(run(`cd "${MAIN}" && ast-index usages Foo`), null);
});
check('у worktree свой непустой индекс', () => {
    const wt = fakeWorktree(MAIN, 'own-index');
    fakeIndex(wt, 20000);
    assert.strictEqual(run('ast-index usages Foo', wt), null);
});
check('у основного checkout нет индекса', () => {
    const bare = fakeRepo('bare');
    assert.strictEqual(run('ast-index usages Foo', fakeWorktree(bare, 'fix-y')), null);
});
check('кавычка в пути к индексу (профиль O\'Neil) — не подставляем', () => {
    // '…' закрылась бы на кавычке пути, и команда упала бы синтаксисом.
    const cache = path.join(FX, "cache'o");
    const at = path.join(cache, astIndexHash(fs.realpathSync.native(MAIN)));
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, 'index.db'), Buffer.alloc(20000));
    process.env.AST_INDEX_CACHE_DIR = cache;
    try {
        assert.strictEqual(run('ast-index usages Foo'), null);
    } finally {
        process.env.AST_INDEX_CACHE_DIR = FX_CACHE;
    }
});
check('переменная или флаг уже указаны', () => {
    assert.strictEqual(run("AST_INDEX_DB_PATH='/x/index.db' ast-index usages Foo"), null);
    assert.strictEqual(run('AST_INDEX_WALK_UP=1 ast-index usages Foo'), null);
    assert.strictEqual(run('ast-index usages Foo --walk-up'), null);
});
check('управление индексом и служебные подкоманды', () => {
    for (const sub of ['rebuild', 'update', 'clear', 'watch', 'watch-status', 'add-root src', 'version', 'help']) {
        assert.strictEqual(run(`ast-index ${sub}`), null, sub);
    }
    assert.strictEqual(run('ast-index --help'), null, '--help без подкоманды');
    assert.strictEqual(run('ast-index'), null, 'голый вызов');
});
check('запись внутри читающих подкоманд (ревью Spec)', () => {
    // SKILL.md плагина: restore подменяет базу, subtree меняет состав индекса,
    // graph build / --refresh / hotspots --collect пишут состояние.
    for (const c of ['restore backup.db', 'subtree add shared ../lib', 'subtree remove shared',
        'graph build', 'graph dependents Foo --refresh', 'hotspots --collect']) {
        assert.strictEqual(run(`ast-index ${c}`), null, c);
    }
    assert.strictEqual(
        run('ast-index graph build && ast-index usages Foo'),
        `ast-index graph build && ${P}ast-index usages Foo`,
        'в bash префикс только у читающего вызова',
    );
});
check('ast-index в тексте — не вызов', () => {
    assert.strictEqual(run('git commit -m "docs: ast-index usages in worktree"'), null);
    assert.strictEqual(run('echo ast-index usages Foo'), null);
    assert.strictEqual(run("cat <<'EOF' > n.md\nast-index usages Foo\nEOF"), null);
});
check('похожие имена и обёртки — не трогаем', () => {
    assert.strictEqual(run('ast-index-helper usages Foo'), null);
    assert.strictEqual(run('ls ~/.claude/plugins/ast-index/'), null);
    assert.strictEqual(run('npx ast-index usages Foo'), null);
});
check('пустая и не-строковая команда', () => {
    assert.strictEqual(run(''), null);
    assert.strictEqual(run(undefined), null);
});

console.log('=== префильтр: подстановка доезжает до updatedInput ===');
const PREFILTER = path.join(__dirname, 'credentials-guard-prefilter.js');
function prefilter(toolName, command, cwd) {
    const r = spawnSync('node', [PREFILTER], {
        input: JSON.stringify({ tool_name: toolName, cwd, tool_input: { command }, session_id: 'aiwt-test' }),
        env: Object.assign({}, process.env, { CLAUDE_HOME: path.dirname(__dirname) }),
        timeout: 15000,
    });
    const text = (r.stdout || '').toString().trim();
    return text ? JSON.parse(text).hookSpecificOutput || {} : {};
}
check('Bash в worktree', () => {
    const out = prefilter('Bash', 'ast-index usages PurchaseGate', WT);
    assert.strictEqual(out.updatedInput && out.updatedInput.command, `${P}ast-index usages PurchaseGate`);
    assert.strictEqual(out.permissionDecision, undefined, 'подстановка не должна выносить решение');
});
check('PowerShell в worktree', () => {
    const out = prefilter('PowerShell', 'ast-index refs Foo', WT);
    assert.strictEqual(out.updatedInput && out.updatedInput.command, `$env:AST_INDEX_DB_PATH='${DB}'; ast-index refs Foo`);
});
check('основной checkout — без updatedInput', () => {
    assert.strictEqual(prefilter('Bash', 'ast-index usages PurchaseGate', MAIN).updatedInput, undefined);
});

try { fs.rmSync(FX, { recursive: true, force: true }); } catch (e) { /* tmp, не критично */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
