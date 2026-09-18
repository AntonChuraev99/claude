#!/usr/bin/env node
// Integration tests for credentials-guard-prefilter.js -> credentials-guard.ps1.
//
// The unit tests only cover the routing decision. These run the real pwsh guard
// through the prefilter and compare the verdict against invoking the guard
// directly, because the failure mode that matters lives in the plumbing, not in
// the decision: the first version passed {encoding:'buffer'} with a string
// input, spawnSync threw ERR_UNKNOWN_ENCODING, the catch swallowed it and the
// hook exited 0 -- turning a deny on `gcloud run deploy` into a silent allow.
//
// Slow by design (each case starts pwsh twice). Not part of the fast suite.
//
// Usage: node hooks/credentials-guard-prefilter.integration.tests.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
// Проверяемые файлы берутся рядом с тестом, а не из ~/.claude: в worktree это
// разные копии, и на пути через homedir прогон зеленел бы на неизменённом
// файле, ничего не говоря о правке (поймано ревью 2026-08-19).
const GUARD = path.join(__dirname, 'credentials-guard.ps1');
const PREFILTER = path.join(__dirname, 'credentials-guard-prefilter.js');

// Префильтр внутри себя ищет guard по CLAUDE_HOME (иначе — ~/.claude). Без этой
// подмены он звал бы guard ГЛАВНОГО checkout'а, и прогон в worktree проверял бы
// не ту копию, что лежит рядом с тестом, — ровно то молчание, от которого
// защищает комментарий выше.
const ENV = Object.assign({}, process.env, { CLAUDE_HOME: path.dirname(__dirname) });

// The guard needs a repo that is in the credentials registry, otherwise every
// verdict is the same "not in the registry" deny and the comparison proves
// nothing. The path is read from the local registry rather than written here:
// ~/.claude is published, and real project paths do not belong in it.
function firstRegistryRepo() {
    const registry = path.join(CLAUDE_DIR, 'config', 'project-credentials.local.md');
    if (!fs.existsSync(registry)) return null;
    for (const line of fs.readFileSync(registry, 'utf8').split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const cell = line.split('|')[1];
        if (!cell) continue;
        const repoPath = cell.trim();
        if (!repoPath || repoPath === 'repo_path' || /^-+$/.test(repoPath)) continue;
        return repoPath.replace(/\\/g, '/');
    }
    return null;
}

const CWD = firstRegistryRepo();
if (!CWD) {
    console.log('SKIP: config/project-credentials.local.md has no repo rows — '
        + 'the guard would answer "not in the registry" for every case.');
    process.exitCode = 0;
    return;
}

const CASES = [
    'firebase deploy',
    'gcloud run deploy --region europe-west1',
    'adb uninstall com.example.app',
    'gh release create v1.0.0',
    'ls -la',
    'git status',
    'echo "firebase deploy"',
];

let passed = 0;
let failed = 0;

function decisionOf(stdout) {
    const text = (stdout || '').toString().trim();
    if (!text) return 'allow';
    try {
        const out = JSON.parse(text).hookSpecificOutput || {};
        // Ответ без permissionDecision — не вердикт: это подстановка аккаунта
        // (updatedInput, hooks/account-align.js) или подсказка про выбор
        // инструмента (additionalContext). Для сравнения с прямым вызовом
        // guard'а оба означают то же, что и молчание, — команда исполняется.
        // Строгость проверки от этого не падает: deny остаётся deny.
        return out.permissionDecision || 'allow';
    } catch (e) {
        return `unparseable(${text.slice(0, 60)})`;
    }
}

function outputOf(stdout) {
    const text = (stdout || '').toString().trim();
    if (!text) return {};
    try {
        return JSON.parse(text).hookSpecificOutput || {};
    } catch (e) {
        return {};
    }
}

// Инвариант «префильтр не меняет вердикт guard'а» с появлением выравнивания
// уточнён: префильтр меняет саму КОМАНДУ (hooks/account-align.js), и guard судит
// уже выровненную. Сравнивать его прямой вызов на ИСХОДНОЙ команде было бы
// сравнением разных входов — именно так `gcloud run deploy` и разошёлся: guard
// на исходной видел глобально активный проект и денаил, а исполниться должен был
// проект из реестра. Поэтому обе стороны получают то, что реально исполнится.
// Строгость сохранена: расхождение вердиктов на одинаковом входе всё так же FAIL.
const alignForTest = require('./account-align.js');
function alignedFor(command) {
    try {
        const a = alignForTest.alignCommand(command, CWD, { shell: 'bash' });
        return a ? a.command : command;
    } catch (e) {
        return command;
    }
}

for (const command of CASES) {
    const payload = JSON.stringify({
        tool_name: 'Bash', cwd: CWD, tool_input: { command },
    });
    const input = Buffer.from(payload, 'utf8');
    const directInput = Buffer.from(JSON.stringify({
        tool_name: 'Bash', cwd: CWD, tool_input: { command: alignedFor(command) },
    }), 'utf8');

    const direct = spawnSync('pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD], { input: directInput });
    const viaPrefilter = spawnSync('node', [PREFILTER], { input, env: ENV });

    const want = decisionOf(direct.stdout);
    const got = decisionOf(viaPrefilter.stdout);

    if (want === got) {
        console.log(`  PASS ${command}  -> ${got}`);
        passed++;
    } else {
        console.log(`  FAIL ${command}`);
        console.log(`    guard directly: ${want}`);
        console.log(`    via prefilter:  ${got}`);
        failed++;
    }
}

// Жёсткие запреты дисциплины вызовов сравнивать с pwsh-guard нельзя: у него на
// эти команды вердикта нет вовсе, весь смысл — что префильтр выносит свой,
// раньше guard и не спрашивая его. Поэтому ожидание задаётся явно, а прогон всё
// так же идёт через реальный процесс: юнит-тесты judge() не видят ни разбора
// stdin, ни порядка вердиктов, ни формы JSON, которую читает харнесс.
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const DISCIPLINE_CASES = [
    ['grep -rn "FooViewModel" --include=*.kt .', 'deny', /тул Grep \(pattern: "FooViewModel", glob: "\*\.kt"\)/],
    // Замена — ожидание по условию в фоне, а не Monitor: его контракт про поток
    // событий, для одиночного ожидания он сам отсылает к run_in_background.
    ['sleep 25; gh pr checks 104', 'deny', /until .*run_in_background|run_in_background/],
    ['sleep 600 && firebase deploy', 'deny', /run_in_background/],
    // `| wc -l` ничего не обрабатывает — считает то же, что вернул бы поиск, а
    // у тула Grep для этого есть count-режим. Щадить такой пайп значило бы
    // оставить обход запрета в один символ.
    ['grep -rn "Foo" --include=*.kt . | wc -l', 'deny', /count|тул Grep/],
    // А вот настоящая обработка остаётся за Bash: тул Grep в пайп не отдаёт.
    ['grep -rl "Foo" --include=*.kt . | xargs sed -i s/a/b/', 'context', null],
    ['node tests.js | grep -E "FAIL|passed"', 'allow', null],
    ['./gradlew :app:testDebugUnitTest', 'allow', null],
    ['until gh pr checks; do sleep 15; done', 'allow', null],
];

for (const [command, want, reasonRe] of DISCIPLINE_CASES) {
    const payload = JSON.stringify({
        tool_name: 'Bash', cwd: CWD, tool_input: { command },
        // Ключ уникален на прогон и на кейс: подсказки живут под кулдауном 10 мин,
        // и на фиксированном ключе второй запуск теста читал бы состояние первого
        // — «подсказки нет» вместо «подсказка выдана».
        session_id: 'integration', transcript_path: `integration-${RUN}-${command.length}`,
    });
    const res = spawnSync('node', [PREFILTER], { input: Buffer.from(payload, 'utf8'), env: ENV });
    const text = (res.stdout || '').toString().trim();
    let reason = '';
    let got = 'allow';
    try {
        const out = JSON.parse(text).hookSpecificOutput;
        reason = out.permissionDecisionReason || '';
        // Подсказка приходит без permissionDecision — это отдельный исход, а не
        // «нет вердикта»: подменять его на allow значило бы не отличать молчание
        // хука от выданной подсказки.
        got = out.permissionDecision || (out.additionalContext ? 'context' : 'allow');
    } catch (e) { /* пустой stdout — хук промолчал */ }

    const reasonOk = !reasonRe || reasonRe.test(reason);
    if (got === want && reasonOk) {
        console.log(`  PASS ${command}  -> ${got}`);
        passed++;
    } else {
        console.log(`  FAIL ${command}`);
        console.log(`    expected: ${want}${reasonRe ? ` matching ${reasonRe}` : ''}`);
        console.log(`    got:      ${got} ${reason.slice(0, 80)}`);
        failed++;
    }
}

// Выравнивание аккаунта: проверяется через реальный процесс, потому что
// юнит-тесты account-align.js не видят ни разбора stdin, ни того, доживает ли
// updatedInput до ответа рядом с вердиктом guard'а. Ожидаемая почта читается из
// того же реестра и в лог не печатается — ~/.claude публичный.
// Разбор реестра — один раз на оба блока проверок. Намеренно СВОЙ, а не через
// экспортированный `parseRegistry`: ожидание, взятое из той же функции, которую
// проверяем, превратило бы тест в тавтологию.
const FIRST_ROW = (() => {
    const registry = path.join(CLAUDE_DIR, 'config', 'project-credentials.local.md');
    try {
        for (const line of fs.readFileSync(registry, 'utf8').split('\n')) {
            if (!line.trim().startsWith('|')) continue;
            const cells = line.split('|').map((c) => c.trim());
            if (!cells[1] || cells[1] === 'repo_path' || /^-+$/.test(cells[1])) continue;
            const mail = (cells[2] || '').match(/[^\s(]+@[^\s)]+/);
            return { account: mail ? mail[0] : null, gcp: cells[3] || null };
        }
    } catch (e) { /* реестра нет — блоки ниже пропустятся */ }
    return { account: null, gcp: null };
})();

const EXPECTED_ACCOUNT = FIRST_ROW.account;

function alignCase(name, command, expect, toolName) {
    const payload = JSON.stringify({
        tool_name: toolName || 'Bash', cwd: CWD, tool_input: { command },
    });
    const res = spawnSync('node', [PREFILTER], { input: Buffer.from(payload, 'utf8'), env: ENV });
    const out = outputOf(res.stdout);
    const got = out.updatedInput ? out.updatedInput.command : null;
    const ok = expect === null ? got === null : (got !== null && expect.test(got));
    if (ok) {
        console.log(`  PASS ${name}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}`);
        console.log(`    expected: ${expect === null ? 'нет подстановки' : String(expect)}`);
        console.log(`    got:      ${got === null ? 'нет подстановки' : got.replace(EXPECTED_ACCOUNT || '@', '<account>')}`);
        failed++;
    }
}

if (EXPECTED_ACCOUNT) {
    console.log('');
    console.log('=== подстановка аккаунта по реестру ===');
    const mail = EXPECTED_ACCOUNT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    alignCase('firebase получает --account', 'firebase deploy',
        new RegExp(`^firebase --account=${mail}\\b`));
    alignCase('gcloud получает флаги', 'gcloud storage ls',
        new RegExp(`^gcloud --account=${mail}\\b.*\\bstorage ls$`));
    alignCase('gcloud auth login не трогается', 'gcloud auth login', null);
    alignCase('firebase login --reauth не трогается', 'firebase login --reauth', null);
    alignCase('явный --account пользователя сохраняется',
        'firebase deploy --account someone@example.com', null);
    alignCase('обычная команда не трогается', 'git status', null);
    // Тул PowerShell на Windows исполняет те же деплои и покрыт наравне с Bash.
    // Подстановка идёт флагом самого CLI, поэтому синтаксис одинаков в обоих
    // шеллах — и, в отличие от префикса переменных окружения, не разрывает
    // `&&`-цепочку в PowerShell.
    alignCase('PowerShell: gcloud получает те же флаги', 'gcloud storage ls',
        new RegExp(`^gcloud --account=${mail}\\b.*\\bstorage ls$`), 'PowerShell');
    alignCase('PowerShell: firebase получает --account', 'firebase deploy',
        new RegExp(`^firebase --account=${mail}\\b`), 'PowerShell');
    alignCase('цепочка cd && deploy не рвётся', 'cd . && firebase deploy',
        new RegExp(`^cd \\. && firebase --account=${mail}\\b`), 'PowerShell');
}

// Ветка guard'а «проект, названный в самой команде, приоритетнее глобального
// конфига». Сравнение префильтра с guard'ом её НЕ проверяет: обе стороны берут
// одну и ту же выровненную команду, поэтому сломанная ветка даёт deny с обеих
// сторон и прогон остаётся зелёным. Здесь guard вызывается напрямую, а ожидание
// задано явно — иначе правка guard'а осталась бы недоказанной.
const REGISTRY_GCP = FIRST_ROW.gcp;

function guardCase(name, command, want) {
    const payload = JSON.stringify({ tool_name: 'Bash', cwd: CWD, tool_input: { command } });
    const res = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD],
        { input: Buffer.from(payload, 'utf8') });
    const got = decisionOf(res.stdout);
    if (got === want) {
        console.log(`  PASS ${name}  -> ${got}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}`);
        console.log(`    expected: ${want}`);
        console.log(`    got:      ${got}`);
        failed++;
    }
}

if (REGISTRY_GCP) {
    console.log('');
    console.log('=== guard читает проект из самой команды ===');
    guardCase('проект из реестра в окружении команды',
        `CLOUDSDK_CORE_PROJECT=${REGISTRY_GCP} gcloud run deploy`, 'allow');
    guardCase('проект из реестра флагом --project',
        `gcloud run deploy --project ${REGISTRY_GCP}`, 'allow');
    guardCase('ЧУЖОЙ проект в команде всё так же блокируется',
        'CLOUDSDK_CORE_PROJECT=some-other-project-1234 gcloud run deploy', 'deny');
    guardCase('два разных проекта в цепочке — доверять нечему, идём пробой',
        `CLOUDSDK_CORE_PROJECT=${REGISTRY_GCP} gcloud run deploy `
        + '&& CLOUDSDK_CORE_PROJECT=some-other-project-1234 gcloud run deploy', 'deny');
    // Скобка scope в commit-message — не позиция команды (ревью 2026-09-18). Чужой
    // `--project` в тексте делает кейс детерминированным: старый регекс брал
    // `(gcloud` за вызов, находил `deploy` и денаил коммит по расхождению проекта.
    guardCase('scope commit-message: fix(gcloud) — не вызов, коммит проходит',
        'git commit -m "fix(gcloud): deploy --project some-other-project-1234 notes"', 'allow');
}

console.log('');
console.log(`Passed: ${passed}  Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
