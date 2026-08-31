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

// Порогов теперь два, и граница у них разная по смыслу: голая пауза перед
// разовой проверкой судится низким порогом (это ожидание по таймеру), sleep
// внутри until/while — высоким (это шаг опроса). Прежний кейс проверял 30 с на
// команде без цикла и теперь по контракту обязан денаиться — заменён на пару.
check('sleep ровно на пороге поллинга не блокируется', () => {
    assert.strictEqual(d.judge(`sleep ${d.SLEEP_POLL_THRESHOLD_S}`, sid()), null);
});

check('пауза перед разовой проверкой блокируется как поллинг', () => {
    const v = d.judge('sleep 25; gh pr checks 104', sid());
    assert.strictEqual(v.decision, 'deny');
    // Замена — ожидание по условию в фоне. Про `Monitor` тут не говорится
    // намеренно: его контракт — поток событий, а для одного уведомления он сам
    // отсылает к `run_in_background` с until-циклом (ревью 2026-08-21).
    assert.ok(/until/.test(v.reason), 'в отказе нет готовой замены');
    assert.ok(/run_in_background/.test(v.reason));
    assert.ok(!/Monitor/.test(v.reason), 'Monitor для одиночного ожидания не рекомендуется');
    assert.ok(/25/.test(v.reason));
});

check('sleep как шаг опроса внутри until-цикла разрешён', () => {
    assert.strictEqual(d.judge('until gh pr checks 104 | grep -q pass; do sleep 20; done', sid()), null);
    assert.strictEqual(d.judge('while ! curl -sf http://localhost:8080; do sleep 15; done', sid()), null);
});

check('долгий sleep блокируется и внутри цикла', () => {
    const v = d.judge('until gh run view; do sleep 120; done', sid());
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/run_in_background/.test(v.reason));
});

check('порог поллинга ниже порога простоя', () => {
    assert.ok(d.SLEEP_POLL_THRESHOLD_S < d.SLEEP_DENY_THRESHOLD_S);
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
// КОНТРАКТ ИЗМЕНЁН 2026-08-21: поиск по исходникам через Bash был подсказкой,
// стал запретом. Основание — замер после снятия шелл-налога: подсказка сдвинула
// долю (1 вызов ast-index на 2 230 grep → 19 на 463), но текстовый grep остался
// преобладающим. Запрет не отнимает возможность искать: он переводит тот же
// поиск в нативный тул Grep, который работает и там, где индекса нет.
check('grep по kotlin-исходникам блокируется с готовой заменой', () => {
    const v = d.judge('grep -rn "FooViewModel" --include=*.kt .', sid());
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/тул Grep/.test(v.reason), 'нет замены нативным тулом');
    assert.ok(/pattern: "FooViewModel"/.test(v.reason), 'паттерн не подставлен');
    assert.ok(/glob: "\*\.kt"/.test(v.reason), 'фильтр не подставлен');
    assert.ok(/ast-index usages FooViewModel/.test(v.reason), 'нет символьной альтернативы');
});

// Запрет обязан оставаться узким: чтение файла — по-прежнему подсказка, иначе
// встанет обычная работа (`cat` в скрипте, `head` для куска лога).
check('чтение файла остаётся подсказкой, не запретом', () => {
    assert.strictEqual(d.judge('cat src/Foo.kt', sid()).decision, 'allow');
});

// Реальная команда из транскрипта: фильтр вычислялся по всей цепочке и в отказ
// уезжал glob чужого сегмента (`*.py` при поиске по `.js`) — замена вела в
// никуда. Плюс запрет останавливает всю цепочку, и отказ обязан это назвать.
check('в цепочке разбирается сегмент поиска, а не вся команда', () => {
    const v = d.judge(
        "python fix_market.py apps/webapp/i18n.js && node --check apps/webapp/i18n.js && grep -n 'fx_market_hint' apps/webapp/i18n.js | head -3",
        sid(),
    );
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/glob: "\*\.js"/.test(v.reason), 'фильтр взят из чужого сегмента: ' + v.reason);
    assert.ok(/pattern: "fx_market_hint"/.test(v.reason));
    assert.ok(/Остальные звенья/.test(v.reason), 'отказ не говорит, что делать с цепочкой');
});

check('одиночный поиск про цепочку не упоминает', () => {
    const v = d.judge('grep -rn "Foo" --include=*.kt .', sid());
    assert.ok(!/Остальные звенья/.test(v.reason));
});

check('regex-паттерн блокируется, но ast-index не предлагается', () => {
    const v = d.judge('grep -rn "fun .*Screen(" --include=*.kt .', sid());
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/тул Grep/.test(v.reason));
    assert.ok(!/ast-index/.test(v.reason), 'regex символом не является');
});

// Вывод уходит в ОБРАБОТКУ — тул Grep этого не умеет, запрет был бы ложным.
// Приёмники, которые только показывают или считают (`| cat`, `| wc -l`), сюда
// не относятся: у тула Grep для них есть свои режимы, и щадить их значило бы
// оставить обход в один символ (проверяется кейсом про вырожденный приёмник).
check('поиск, уходящий в обработку, не блокируется', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rl "Foo" --include=*.kt . | xargs sed -i s/a/b/'), null);
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . > /tmp/hits.txt'), null);
    assert.ok(d.feedsAnotherCommand('grep -rn "Foo" --include=*.kt . | xargs sed -i s/a/b/'));
});

check('поиск внутри heredoc и чужого интерпретатора не блокируется', () => {
    assert.strictEqual(d.codeSearchVerdict('python - <<PY\nimport re  # grep Foo.kt\nPY'), null);
    assert.strictEqual(d.codeSearchVerdict('perl -e "# grep Foo.kt"'), null);
});

// Обходы, найденные пробой руками: каждый снимал запрет одним лишним символом
// или обёрткой, то есть правило переставало быть правилом, не переставая
// существовать на бумаге.
check('вырожденный приёмник не снимает запрет', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rn Foo --include=*.kt . | cat').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rn Foo --include=*.kt . | head -50').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rn Foo --include=*.kt . | wc -l').decision, 'deny');
    // ...а настоящая обработка по-прежнему щадится: тул Grep её не заменяет.
    assert.strictEqual(d.codeSearchVerdict('grep -rl Foo --include=*.kt . | xargs sed -i s/a/b/'), null);
});

check('обёртка bash -c не снимает запрет', () => {
    assert.strictEqual(d.codeSearchVerdict("bash -c 'grep -rn Foo --include=*.kt .'").decision, 'deny');
    assert.strictEqual(d.sleepVerdict('bash -c \'sleep 600\'').decision, 'deny');
});

// Команда на чужом языке — текст программы, а не вызовы шелла. Поймано живьём:
// проверочный `node -e "... sleep 120 ..."` получил deny как ожидание.
check('чужой интерпретатор не судится как команда шелла', () => {
    // Пауза обязана стоять там, где разбор шелла её ВИДИТ (после `;`), иначе
    // кейс зеленел бы и без защиты — просто потому, что regex её не нашёл.
    // Мутационная матрица поймала ровно это: первая редакция кейса прятала
    // `sleep` за `//` и защиту не проверяла.
    assert.strictEqual(d.sleepVerdict('node -e \'console.log(1); sleep 120\''), null);
    assert.strictEqual(d.sleepVerdict('python3 -c "import x; sleep 300"'), null);
    assert.strictEqual(d.codeSearchVerdict('python -c "x = 1  # grep Foo.kt"'), null);
});

check('слова цикла в тексте циклом не считаются', () => {
    // Есть и `while`, и `do`, но нет тела цикла — пауза голая, порог низкий.
    assert.strictEqual(d.sleepVerdict('sleep 25; echo "while true do"').decision, 'deny');
    // Голая пауза перед настоящим циклом судится отдельно от шага опроса.
    assert.strictEqual(d.sleepVerdict('sleep 25; until gh pr checks; do sleep 20; done').decision, 'deny');
    assert.strictEqual(d.sleepVerdict('until gh pr checks; do sleep 20; done'), null);
});

check('текст команды в кавычках вердикта не получает', () => {
    assert.strictEqual(d.sleepVerdict('echo "sleep 600"'), null);
    assert.strictEqual(d.codeSearchVerdict('git commit -m "fix: grep in Foo.kt"'), null);
});

check('escape hatch снимает запрет поиска', () => {
    process.env.CLAUDE_ALLOW_CODE_GREP = '1';
    try {
        assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt .'), null);
    } finally {
        delete process.env.CLAUDE_ALLOW_CODE_GREP;
    }
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt .').decision, 'deny');
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
    // Тема read, а не search: поиск по коду теперь денаится и состояния не пишет.
    const v = d.judge('cat src/Foo.kt', `../../${name}`);
    assert.ok(v && v.decision === 'allow', 'подсказка не выдалась — проверять нечего');
    assert.ok(!fs.existsSync(escaped), 'состояние записано за пределы каталога: ' + escaped);
});

check('cd-префикс не мешает распознать поиск', () => {
    const v = d.judge('cd "C:/repo/.claude/worktrees/x" && grep -rn "Foo" --include=*.ts src', sid());
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/glob: "\*\.ts"/.test(v.reason));
});

check('rg -r по дереву — тоже поиск по коду', () => {
    assert.ok(d.isCodeSearch('rg -rn "Repository" .'));
});

// Поймано живьём: прогон тестов с фильтром вывода получал подсказку про
// ast-index. grep после пайпа читает stdout соседа, файлов не открывает,
// и заменить его ast-index нельзя в принципе.
check('grep после пайпа — фильтр вывода, не поиск по коду', () => {
    assert.strictEqual(d.isCodeSearch('node hooks/bash-tool-discipline.tests.js | grep -E "FAIL|passed"'), false);
    assert.strictEqual(d.isCodeSearch('cat src/Foo.kt | grep -n "fun render"'), false);
    assert.strictEqual(d.judge('./gradlew build 2>&1 | grep -i "warning.*\\.kt"', sid()), null);
});

check('обёртки перед настоящим поиском не мешают', () => {
    assert.ok(d.isCodeSearch('LC_ALL=C grep -rn "FooViewModel" --include=*.kt .'));
    assert.ok(d.isCodeSearch('cd /repo && grep -rn "FooViewModel" --include=*.kt .'));
    assert.ok(d.isCodeSearch('timeout 30 rg -n "FooViewModel" --type kt'));
});

check('|| разделяет сегменты, одиночный | — нет', () => {
    assert.ok(d.isCodeSearch('test -d src || grep -rn "Foo" --include=*.kt .'));
    assert.strictEqual(d.isCodeSearch('ls src/*.kt | grep Foo'), false);
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
    assert.ok(d.judge('cat src/A.kt', s));
    assert.strictEqual(d.judge('cat src/B.kt', s), null);
});

// Кулдаун живёт только у подсказок. Запрет обязан срабатывать КАЖДЫЙ раз:
// пропущенный второй вызов означал бы, что правило действует через раз.
check('запрет не глушится кулдауном', () => {
    const s = sid();
    assert.strictEqual(d.judge('grep -rn "A" --include=*.kt .', s).decision, 'deny');
    assert.strictEqual(d.judge('grep -rn "B" --include=*.kt .', s).decision, 'deny');
    assert.strictEqual(d.judge('sleep 25; gh pr checks', s).decision, 'deny');
});

check('разные темы не глушат друг друга', () => {
    const s = sid();
    assert.ok(d.judge('cat A.kt', s));
    assert.strictEqual(d.judge('grep -rn "A" --include=*.kt .', s).decision, 'deny');
});

// --- находки ревью 2026-08-21 ------------------------------------------
// Каждый кейс ниже — дефект, найденный ревью диффа на двух осях. Держим их
// тестами, а не памятью: почти все были обходами в один-два символа.

check('поиск файлов по имени ведёт в Glob, а не в Grep', () => {
    const v = d.codeSearchVerdict('find . -name "*.kt"');
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/тул Glob \(pattern: "\*\*\/\*\.kt"\)/.test(v.reason), v.reason);
    assert.ok(!/ast-index usages find/.test(v.reason), 'мусорная замена в отказе');
});

check('пакетная операция find не трогается вовсе', () => {
    assert.strictEqual(d.codeSearchVerdict('find . -name "*.kt" -exec sed -i s/a/b/ {} +'), null);
    assert.strictEqual(d.codeSearchVerdict('find src -name "*.kt" -delete'), null);
});

// Переменная читается из окружения процесса хука: агент не может открыть себе
// хатч из команды, и отказ обязан это сказать, иначе цикл «отказ → префикс →
// тот же отказ» повторяется без новой информации.
check('escape hatch описан как действие пользователя', () => {
    const v = d.codeSearchVerdict('grep -rn "Foo" --include=*.kt .');
    assert.ok(/снимает пользователь/.test(v.reason));
    assert.ok(/префикс в самой команде/.test(v.reason));
    const inline = d.codeSearchVerdict('CLAUDE_ALLOW_CODE_GREP=1 grep -rn "Foo" --include=*.kt .');
    assert.strictEqual(inline.decision, 'deny', 'inline-префикс не должен снимать запрет');
});

check('флаг -e отдаёт паттерн, -c его не съедает', () => {
    assert.ok(/pattern: "Foo"/.test(d.codeSearchVerdict('grep --include=*.kt -e Foo .').reason));
    assert.ok(/pattern: "Foo"/.test(d.codeSearchVerdict('grep -rn -e "Foo" --include=*.kt .').reason));
    assert.ok(/pattern: "TODO"/.test(d.codeSearchVerdict('grep -c "TODO" src/Foo.kt').reason));
    // Форма через `=` — единственная, где общий пропуск «флаг со значением»
    // съел бы сам паттерн и в отказ уехала бы точка вместо запроса.
    assert.ok(/pattern: "Foo"/.test(d.codeSearchVerdict('grep --regexp=Foo --include=*.kt .').reason));
});

check('редирект stderr запрет не снимает', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . 2>&1').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . 2>/dev/null').decision, 'deny');
    // Настоящий редирект вывода по-прежнему щадится — тул Grep в файл не пишет.
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . > out.txt'), null);
});

check('альтернация в кавычках за пайп не принимается', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rnE "Foo|Bar" --include=*.kt .').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict("grep -rn 'a|b' --include=*.kt .").decision, 'deny');
});

// NON_CODE_PATH проверялся по всей строке: слово `build` в паттерне или
// `&& ./gradlew build` в соседнем звене глушило правило целиком.
check('некодовый путь узнаётся по пути, а не по слову', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rn "build" --include=*.kt .').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . && ./gradlew build').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rni error build/reports/'), null);
    assert.strictEqual(d.codeSearchVerdict('grep -n FATAL ~/Downloads/crash.kt.txt'), null);
});

check('git grep и обёртки не проходят мимо правила', () => {
    assert.strictEqual(d.codeSearchVerdict('git grep -n "Foo" -- "*.kt"').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('env grep -rn "Foo" --include=*.kt .').decision, 'deny');
});

check('форма записи флага не решает судьбу приёмника', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . | head -n 50').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . | tail -n +2').decision, 'deny');
    // ...а второй grep — уже обработка, там Bash уместен.
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . | grep -v test'), null);
});

check('кавычки внутри паттерна экранируются', () => {
    const v = d.codeSearchVerdict('grep -rn \'val "x"\' --include=*.kt .');
    assert.ok(/pattern: "val \\"x\\""/.test(v.reason), v.reason);
});

check('дробная пауза и префиксы видны', () => {
    assert.strictEqual(d.sleepVerdict('sleep 0.5m; git status').decision, 'deny');
    assert.strictEqual(d.sleepVerdict('time sleep 600').decision, 'deny');
    assert.strictEqual(d.sleepVerdict('sleep 8; git status'), null);
});

// `for` перебирает готовый список, а не ждёт события: пауза внутри него — такой
// же простой, как голая. Все тексты правил говорят только про until/while.
check('for без break — перебор списка, не ожидание', () => {
    assert.strictEqual(d.sleepVerdict('for f in a b; do sleep 20; done').decision, 'deny');
    assert.strictEqual(d.sleepVerdict('until gh pr checks; do sleep 20; done'), null);
    assert.strictEqual(d.sleepVerdict(`until x; do sleep ${d.SLEEP_DENY_THRESHOLD_S}; done`), null);
});

// Ограниченный поллинг из mr-merge.md: `for` со счётчиком и `break` — это
// ожидание по условию с потолком итераций, и порог у него как у until-цикла.
// Без этой ветки рекомендованная самим репозиторием форма получала бы deny.
check('for со счётчиком и break — законное ожидание', () => {
    assert.strictEqual(d.sleepVerdict(
        'for i in $(seq 1 20); do [ "$(gh pr view 12 --json state -q .state)" = "MERGED" ] && break; sleep 15; done',
    ), null);
});

// --- находки второго раунда ревью ---------------------------------------

check('rg --files — листинг, замена ему Glob', () => {
    const v = d.codeSearchVerdict('rg --files -g "*.kt"');
    assert.strictEqual(v.decision, 'deny');
    assert.ok(/тул Glob \(pattern: "\*\*\/\*\.kt"\)/.test(v.reason), v.reason);
    assert.ok(!/ast-index/.test(v.reason));
});

// heredoc, скормленный bash, — шелл, а не чужой язык: иначе обход в одну строку,
// того же класса, что закрытая обёртка `bash -c`.
check('heredoc для bash запрет не снимает', () => {
    assert.strictEqual(d.sleepVerdict('bash <<EOF\nsleep 600\nEOF').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('sh <<EOF\ngrep -rn Foo --include=*.kt .\nEOF').decision, 'deny');
    // ...а heredoc чужого интерпретатора по-прежнему не трогается.
    assert.strictEqual(d.codeSearchVerdict('python - <<PY\n# grep Foo.kt\nPY'), null);
});

check('timeout перед паузой её не прячет', () => {
    assert.strictEqual(d.sleepVerdict('timeout 60 sleep 45').decision, 'deny');
});

check('редирект всего вывода щадится, редирект stderr — нет', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rn Foo --include=*.kt . &> out.txt'), null);
    assert.strictEqual(d.codeSearchVerdict('grep -rn Foo --include=*.kt . 2>&1').decision, 'deny');
});

// Индекс не покрывает .md — совет `ast-index usages TODO` отправлял бы в
// инструмент, который этих файлов не видит.
check('ast-index не предлагается для некодового фильтра', () => {
    const v = d.codeSearchVerdict('grep -rn "TODO" --include=*.md docs/');
    if (v) assert.ok(!/ast-index/.test(v.reason), v.reason);
});

check('тексты отказов знают про for с break', () => {
    const poll = d.sleepVerdict('sleep 25; gh pr checks');
    assert.ok(/for` с `break`/.test(poll.reason), poll.reason);
    const long = d.sleepVerdict('sleep 600');
    assert.ok(/for` с `break`/.test(long.reason), long.reason);
});

check('отказ по паузе не советует прятать в фон саму паузу', () => {
    const v = d.sleepVerdict('sleep 25; gh pr checks');
    assert.ok(/until/.test(v.reason));
    assert.ok(!/запускай саму команду через/.test(v.reason));
});

// --- периметр: обходы второго раунда ------------------------------------

check('рекурсия ripgrep по умолчанию видна, но без фильтра — подсказка', () => {
    // `-r` у rg значит `--replace`, поэтому требовать его было ошибкой.
    assert.ok(d.isCodeSearch('rg "FooViewModel"'));
    // Без явного фильтра по коду поиск может идти по чему угодно — только подсказка.
    assert.strictEqual(d.codeSearchVerdict('rg "FooViewModel"'), null);
    assert.strictEqual(d.codeSearchVerdict('rg -t kt FooViewModel').decision, 'deny');
});

check('рекурсивный поиск по не-исходникам не денаится', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rn "TODO" docs'), null);
    assert.strictEqual(d.codeSearchVerdict('grep -rn ERROR build'), null);
    assert.strictEqual(d.codeSearchVerdict('grep -rn FATAL logs'), null);
});

check('предикатный grep заменить нечем', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -q "Foo" src/Foo.kt && ./gradlew build'), null);
});

check('слово в паттерне путём не считается', () => {
    assert.strictEqual(d.codeSearchVerdict('grep -rn "build" --include=*.kt .').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . && ls build/').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('grep -rn "Foo" --include=*.kt . # see build/x').decision, 'deny');
});

check('цитирование bash разбирается по правилам bash', () => {
    // Экранированная кавычка внутри двойных строку не закрывает — `|` не пайп.
    assert.strictEqual(d.codeSearchVerdict(String.raw`grep -rnE "foo\"|bar" --include=*.kt .`).decision, 'deny');
    // ...а `\'` вне кавычек строку не открывает — пайп настоящий, это обработка.
    assert.strictEqual(d.codeSearchVerdict(String.raw`grep -rn It\'s --include=*.kt . | xargs sed -i 's/a/b/'`), null);
});

check('разделитель в кавычках сегмент не разваливает', () => {
    const v = d.codeSearchVerdict('grep -rn "a && b" --include=*.kt .');
    assert.ok(/pattern: "a && b"/.test(v.reason), v.reason);
    assert.ok(!/Остальные звенья/.test(v.reason), 'ложная приписка про цепочку');
});

check('листинг с обработкой ведёт не в Glob', () => {
    assert.strictEqual(d.codeSearchVerdict('find . -name "*.kt" | xargs grep Foo'), null);
});

check('интерпретатор прикрывает только свой сегмент', () => {
    assert.strictEqual(d.sleepVerdict('python -c "print(1)"; sleep 600').decision, 'deny');
    assert.strictEqual(d.codeSearchVerdict('node build.js && grep -c "Foo" src/Foo.kt').decision, 'deny');
    // Маркер heredoc в паттерне иммунитета не даёт.
    assert.strictEqual(d.codeSearchVerdict('grep -rn "a<<EOF" --include=*.kt .').decision, 'deny');
});

check('обёртка bash -lc разворачивается', () => {
    assert.strictEqual(d.sleepVerdict("bash -lc 'sleep 600'").decision, 'deny');
});

check('дробная пауза не даёт артефакта в тексте', () => {
    assert.ok(/простаивает 252 с/.test(d.sleepVerdict('sleep 0.07h').reason));
});

// --- склейка вызовов больше не снимает запрет (2026-08-31) ----------------
check('поиск с безобидным приёмником и склейкой блокируется', () => {
    // `| head -20` — приёмник, который лишь показывает тот же результат; `; echo`
    // принадлежит СОСЕДНЕМУ звену. До фикса кусок после пайпа разбирался целиком
    // и вся команда объявлялась «обработкой», то есть запрет снимался склейкой.
    const v = d.codeSearchVerdict('grep -rn "CAVEMAN_DEFAULT_MODE" --include=*.js . | head -20; echo "=== next ==="');
    assert.ok(v && v.decision === 'deny', 'склейка сняла запрет');
    assert.ok(/Остальные звенья/.test(v.reason), 'нет подсказки про цепочку');
});

check('настоящая обработка вывода по-прежнему разрешена', () => {
    assert.strictEqual(d.codeSearchVerdict("grep -rn Foo --include=*.kt . | xargs sed -i 's/a/b/'"), null);
    assert.strictEqual(d.codeSearchVerdict('find . -name "*.kt" | xargs grep Foo'), null);
});

// --- тул Grep: символ уходит в ast-index ---------------------------------
check('символьный паттерн Grep отклоняется с готовой командой ast-index', () => {
    const v = d.grepVerdict({ pattern: 'GenerationJobsRegistry' }, sid());
    assert.ok(v && v.decision === 'deny', 'символ не отклонён');
    assert.ok(/ast-index usages GenerationJobsRegistry/.test(v.reason), v.reason);
    assert.ok(/повтори этот же Grep/.test(v.reason), 'нет выхода на случай отсутствия индекса');
});

check('повтор того же паттерна проходит — запрет одноразовый', () => {
    const key = sid();
    assert.ok(d.grepVerdict({ pattern: 'PurchaseGate' }, key).decision === 'deny');
    assert.strictEqual(d.grepVerdict({ pattern: 'PurchaseGate' }, key), null);
    // Другой символ в той же сессии судится независимо.
    assert.ok(d.grepVerdict({ pattern: 'OnboardingGate' }, key).decision === 'deny');
});

check('текст и регулярка остаются работой Grep', () => {
    assert.strictEqual(d.grepVerdict({ pattern: 'TODO: fix' }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'val\\s+x' }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'foo.bar' }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'id' }, sid()), null, 'слишком короткий — не символ');
});

check('не-кодовые фильтры выводят из-под запрета', () => {
    assert.strictEqual(d.grepVerdict({ pattern: 'ProfileScreen', glob: '*.md' }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'ProfileScreen', type: 'json' }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'ProfileScreen', path: 'build/reports' }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'ProfileScreen', '-i': true }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'ProfileScreen', multiline: true }, sid()), null);
});

// --- склейка с интерпретатором тоже не снимает запрет (ревью 2026-08-31) ---
check('однострочка интерпретатора прикрывает только свой сегмент', () => {
    // `python -c` кончается на своём разделителе; поиск в соседнем звене остаётся
    // поиском. На всей команде это был обход запрета в один префикс.
    assert.ok(d.codeSearchVerdict('python -c "import sys" ; grep -rn Foo --include=*.py .').decision === 'deny');
    assert.ok(d.codeSearchVerdict('node -e "console.log(1)" && grep -rn Foo --include=*.kt .').decision === 'deny');
    // ...а поиск ВНУТРИ однострочки по-прежнему её текст, а не команда шелла.
    assert.strictEqual(d.codeSearchVerdict('node -e "grep -rn Foo --include=*.kt ."'), null);
});

check('heredoc судится по всей команде, а не по сегменту', () => {
    // Тело heredoc'а продолжается за разделителями: сузив проверку до сегмента,
    // мы бы начали денаить содержимое чужого скрипта.
    assert.strictEqual(d.codeSearchVerdict('cat <<EOF > run.sh\ngrep -rn Foo --include=*.kt .\nEOF'), null);
    // Шеллу heredoc иммунитета не даёт — это тот же шелл, только в обёртке.
    assert.ok(d.codeSearchVerdict('bash <<EOF\ngrep -rn Foo --include=*.kt .\nEOF').decision === 'deny');
});

// --- Grep: символ отличается от обычного слова (ревью 2026-08-31) ----------
check('слово без признаков имени остаётся работой Grep', () => {
    // ast-index по построению не даёт совпадений в строках и комментариях,
    // поэтому отказ на литерале стоил бы трёх turn'ов: Grep → пусто → Grep.
    for (const p of ['TODO', 'FIXME', 'premium_purchase', 'onboarding', 'deprecated']) {
        assert.strictEqual(d.grepVerdict({ pattern: p }, sid()), null, p);
    }
    assert.strictEqual(d.grepVerdict({ pattern: 'TODO', glob: '*.kt' }, sid()), null, 'TODO с кодовым фильтром');
});

check('camelCase и PascalCase с внутренней заглавной — символ', () => {
    assert.ok(d.grepVerdict({ pattern: 'getUser' }, sid()).decision === 'deny');
    assert.ok(d.grepVerdict({ pattern: 'PurchaseGate' }, sid()).decision === 'deny');
});

check('односложное имя судится только под кодовым фильтром', () => {
    assert.strictEqual(d.grepVerdict({ pattern: 'Paywall' }, sid()), null, 'без фильтра — может быть текстом');
    assert.ok(d.grepVerdict({ pattern: 'Paywall', glob: '*.kt' }, sid()).decision === 'deny');
    assert.ok(d.grepVerdict({ pattern: 'Paywall', type: 'kotlin' }, sid()).decision === 'deny');
});

check('build-скрипты остаются работой Grep — индекса по ним нет', () => {
    // `*.gradle.kts` кончается на `.kts` и попадал в кодовый фильтр: отказ вёл в
    // ast-index, тот отвечал пусто, агент повторял Grep — два turn'а впустую.
    assert.strictEqual(d.grepVerdict({ pattern: 'Paywall', glob: '**/*.gradle.kts' }, sid()), null);
    assert.strictEqual(d.grepVerdict({ pattern: 'Paywall', glob: '*.gradle' }, sid()), null);
    // ...а обычный `.kts`-скрипт под фильтр по-прежнему попадает.
    assert.ok(d.grepVerdict({ pattern: 'Paywall', glob: '*.kts' }, sid()).decision === 'deny');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
