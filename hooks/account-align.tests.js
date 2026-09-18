#!/usr/bin/env node
// Tests for account-align.js.
//
// Асимметрия обратная префильтру: здесь опаснее ПОДСТАВИТЬ аккаунт там, где не
// надо, чем не подставить. Лишняя подстановка отправляет команду под чужой
// почтой — тот же класс ошибки, что и деплой не туда. Поэтому каждый случай,
// где каталог не опознан однозначно, обязан вернуть null.
//
// Usage: node hooks/account-align.tests.js

const { alignCommand, parseRegistry, effectiveDir, matchRow } = require('./account-align.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
    const ok = actual === expected;
    if (ok) {
        console.log(`  PASS ${name}`);
        passed++;
    } else {
        console.log(`  FAIL ${name}\n       expected: ${expected}\n       actual:   ${actual}`);
        failed++;
    }
}

const REGISTRY_FIXTURE = `# Реестр кредов проектов

| repo_path | account | gcp_project | cf_account_id | firebase_project | play_package | git_remote |
|---|---|---|---|---|---|---|
| C:\\Users\\U\\Projects\\AlphaApp | personal@example.com | alpha-1 | ff00 | alpha-1 | com.example.alpha | https://example.com/a.git |
| C:\\Users\\U\\Projects\\workapp | work@example.com | workapp-2 | ff01 | workapp-2 | com.example.work | https://example.com/b.git |
| C:\\Users\\U\\Projects\\AlphaApp\\tools\\inner | inner@example.com | inner-3 |  | inner-3 |  | https://example.com/c.git |
| C:\\Users\\U\\Projects\\nogcp | nogcp@example.com |  |  | nogcp-fb |  | https://example.com/d.git |
| C:\\Users\\U\\.claude | annotated@example.com (GitHub SomeNick) |  |  |  |  | https://example.com/e.git |

## Известные Cloudflare-аккаунты

| account_id | владелец | где используется |
|---|---|---|
| deadbeef | not-a-repo@example.com | эта секция не про репозитории |
`;

const rows = parseRegistry(REGISTRY_FIXTURE);
const ALPHA = 'C:\\Users\\U\\Projects\\AlphaApp';
const WORKAPP = 'C:\\Users\\U\\Projects\\workapp';

function align(command, cwd) {
    const r = alignCommand(command, cwd, { rows });
    return r ? r.command : null;
}

console.log('=== разбор реестра ===');
check('строк основной таблицы', rows.length, 5);
check('секция ниже таблицы не попадает в строки',
    rows.some((r) => r.account === 'not-a-repo@example.com'), false);
check('почта вычищена из "mail (GitHub Nick)"',
    rows.find((r) => r.repoPath.endsWith('.claude')).account, 'annotated@example.com');

console.log('\n=== gcloud: подстановка флагов ===');
check('простая команда',
    align('gcloud storage ls', ALPHA),
    'gcloud --account=personal@example.com --project=alpha-1 storage ls');
check('другой проект — другой аккаунт',
    align('gcloud storage ls', WORKAPP),
    'gcloud --account=work@example.com --project=workapp-2 storage ls');
check('пустой gcp_project — только аккаунт',
    align('gcloud auth print-access-token', 'C:\\Users\\U\\Projects\\nogcp'),
    'gcloud --account=nogcp@example.com auth print-access-token');
// Флаг живёт внутри своей команды, поэтому цепочка не рвётся ни в одном шелле.
// Префикс переменных окружения этим свойством не обладал: в PowerShell `;`
// после присваивания закрывает `&&`-цепочку, и команда исполнялась даже после
// провала предыдущего звена.
check('цепочка с && не рвётся',
    align('cd C:\\Users\\U\\Projects\\AlphaApp && gcloud run deploy', WORKAPP),
    'cd C:\\Users\\U\\Projects\\AlphaApp && gcloud --account=personal@example.com --project=alpha-1 run deploy');

console.log('\n=== firebase: подстановка флага ===');
check('простая команда',
    align('firebase deploy --only hosting', ALPHA),
    'firebase --account=personal@example.com deploy --only hosting');
check('npx-обёртка',
    align('npx firebase deploy', ALPHA),
    'npx firebase --account=personal@example.com deploy');
// Флаг, подставленный в gcloud, не должен читаться как «пользователь указал
// аккаунт вручную» при обработке firebase в той же цепочке.
check('оба инструмента в одной цепочке',
    align('gcloud storage ls && firebase deploy', ALPHA),
    'gcloud --account=personal@example.com --project=alpha-1 storage ls'
    + ' && firebase --account=personal@example.com deploy');

console.log('\n=== чего трогать НЕЛЬЗЯ ===');
check('gcloud auth login — пользователь чинит токен', align('gcloud auth login', ALPHA), null);
check('firebase login --reauth', align('firebase login --reauth', ALPHA), null);
check('firebase logout', align('firebase logout', ALPHA), null);
check('явный --account у firebase', align('firebase deploy --account other@example.com', ALPHA), null);
check('явный --account у gcloud', align('gcloud storage ls --account other@example.com', ALPHA), null);
check('явная конфигурация gcloud глушит и аккаунт, и проект',
    align('gcloud storage ls --configuration foo', ALPHA), null);
// `--project` говорит только о проекте. Глушить им ещё и аккаунт значило бы
// отправить деплой в правильный проект под той почтой, что осталась активной
// глобально, — то есть ровно в чужую учётку.
check('явный --project глушит проект, но НЕ аккаунт',
    align('gcloud run deploy --project other', ALPHA),
    'gcloud --account=personal@example.com run deploy --project other');
check('слово firebase внутри пути, не команда',
    align('cat /c/proj/firebase.json', ALPHA), null);
check('слово gcloud в аргументе, не команда',
    align('echo "run gcloud later"', ALPHA), null);
// Скобка scope в Conventional Commits — не subshell. Прецедент 2026-09-18:
// `chore(gcloud): …` получил `--account=<почта>` и чуть не уехал в публичный репо.
check('scope commit-message: chore(gcloud) — не позиция команды',
    align('git commit -m "chore(gcloud): перейти с gsutil на gcloud storage"', ALPHA), null);
check('scope commit-message: fix(firebase) — не позиция команды',
    align('git commit -m "fix(firebase): reauth flow"', ALPHA), null);
check('subshell (gcloud …) — по-прежнему позиция команды',
    align('(gcloud storage ls)', ALPHA),
    '(gcloud --account=personal@example.com --project=alpha-1 storage ls)');
check('подстановка $(gcloud …) — по-прежнему позиция команды',
    align('TOKEN=$(gcloud auth print-access-token)', ALPHA),
    'TOKEN=$(gcloud --account=personal@example.com --project=alpha-1 auth print-access-token)');
check('каталог вне реестра', align('firebase deploy', 'C:\\Users\\U\\Projects\\unknown'), null);
check('пустая команда', align('   ', ALPHA), null);

console.log('\n=== граница каталога ===');
check('соседний каталог с общим префиксом не матчится',
    align('firebase deploy', 'C:\\Users\\U\\Projects\\AlphaAppOld'), null);
check('подкаталог проекта матчится',
    align('firebase deploy', 'C:\\Users\\U\\Projects\\AlphaApp\\app\\src'),
    'firebase --account=personal@example.com deploy');
check('вложенный репозиторий выигрывает у родителя',
    align('firebase deploy', 'C:\\Users\\U\\Projects\\AlphaApp\\tools\\inner'),
    'firebase --account=inner@example.com deploy');
check('прямой слэш и регистр',
    align('firebase deploy', 'c:/users/u/projects/alphaapp'),
    'firebase --account=personal@example.com deploy');

console.log('\n=== каталог берётся из cd в цепочке ===');
check('cd уводит в другой проект',
    align('cd C:\\Users\\U\\Projects\\workapp && firebase deploy', ALPHA),
    'cd C:\\Users\\U\\Projects\\workapp && firebase --account=work@example.com deploy');
check('cd в каталог вне реестра — не подставляем',
    align('cd /tmp/scratch && firebase deploy', ALPHA), null);
check('effectiveDir берёт последнюю cd',
    effectiveDir('cd /a && cd /b && ls', '/cwd'), '/b');
check('effectiveDir без cd — это cwd',
    effectiveDir('firebase deploy', '/cwd'), '/cwd');
check('cd - не считается сменой каталога',
    effectiveDir('cd - && ls', '/cwd'), '/cwd');
// `cd functions && firebase deploy` — обычная форма в монорепозитории. Сырой
// относительный путь не совпал бы ни с одной строкой реестра, и команда ушла бы
// под глобальным дефолтом — чужим аккаунтом на личном проекте.
check('относительный cd резолвится от cwd',
    align('cd functions && firebase deploy', ALPHA),
    'cd functions && firebase --account=personal@example.com deploy');
check('относительный cd наружу выводит из проекта',
    align('cd ../unknown && firebase deploy', ALPHA), null);

console.log('\n=== отсутствие реестра ===');
check('пустой список строк — работаем как раньше',
    (() => { const r = alignCommand('firebase deploy', ALPHA, { rows: [] }); return r ? r.command : null; })(),
    null);
check('битый реестр не роняет разбор', parseRegistry('|||\n| | |\n').length, 0);

console.log('\n=== matchRow напрямую ===');
check('пустой каталог не матчится', matchRow(rows, ''), null);
check('undefined не матчится', matchRow(rows, undefined), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
