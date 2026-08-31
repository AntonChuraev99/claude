// Дисциплина Bash-вызовов. НЕ отдельный хук: модуль подключается внутрь
// credentials-guard-prefilter.js, который и так висит на PreToolUse(Bash).
// Отдельный хук стоил бы ещё один спавн процесса на КАЖДЫЙ вызов — ровно та
// цена, которую снимал замер спавна на этой машине (docs/solutions/, 2026-08-19).
//
// ЗАЧЕМ. Исходный замер (2026-08-18) показывал 10.1 ч в день на «дешёвых»
// Bash-вызовах при медиане 5.5 с — эту статью закрыл фикс шелл-налога
// 2026-08-19. Replay 2026-08-21: медиана дешёвого вызова 1.1 с, у субагентов
// 0.93 с против 0.93 с у нативного тула, суммарно 0.67 ч в день. Осталось то,
// что ценой вызова не лечится:
//   * ast-index вызывался 19 раз против 463 текстовых grep по коду (08-20) —
//     при живом индексе и правиле в CLAUDE.md и в 13 файлах agents/;
//   * `sleep` вне цикла — 23 голых паузы дольше 10 с за двое суток.
// Правило текстом уже было написано и всё равно не исполнялось: в bypassPermissions
// системный промпт велит обратное («читай через cat, ищи через grep»), а
// плагинная напоминалка ast-index висит на matcher "Grep" и вызовы через Bash
// не видит вовсе. Документация Claude Code про это говорит прямо: инструкции в
// промпте и CLAUDE.md не меняют того, что агенту разрешено, — рычаг только хук.
//
// ПОВЕДЕНИЕ (2026-08-21). Запретов три, и каждый отдаёт ГОТОВУЮ замену, а не
// просто «нельзя»: долгий `sleep`, пауза перед разовой проверкой (ожидание по
// таймеру вместо ожидания по условию) и текстовый поиск по исходникам через
// Bash. Остальное — additionalContext БЕЗ permissionDecision, не чаще раза в
// COOLDOWN_MS на тему и агента, чтобы напоминание не превратилось в шум.
//
// Канал доставки проверен живьём: `additionalContext` на PreToolUse доходит до
// модели (наблюдалось в сессии 2026-08-21), `deny` с текстом — тем более, он
// возвращается моделью как ошибка инструмента. Внешние репорты об обратном
// (anthropics/claude-code#55889, #19432) относятся к 2.1.12/2.1.123; на 2.1.235
// канал работает.
//
// ESCAPE HATCH СНИМАЕТ ПОЛЬЗОВАТЕЛЬ, НЕ АГЕНТ. Переменные читаются из окружения
// процесса хука, поэтому inline-префикс в самой команде (`CLAUDE_ALLOW_CODE_GREP=1
// grep …`) на вердикт не влияет — он вообще не доходит до хука. Тексты отказов
// обязаны говорить это прямо: иначе агент повторяет команду с префиксом и
// получает тот же отказ, то есть правило порождает fail-loop вместо замены
// (поймано ревью 2026-08-21).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Долгий сон блокируется, короткий (ретрай, дребезг устройства) — нет.
const SLEEP_DENY_THRESHOLD_S = 30;
// Пауза перед разовой проверкой — это ожидание по таймеру вместо ожидания по
// условию, и порог у неё ниже. Замер после фикса шелл-налога (2026-08-20…21):
// 96 вызовов со `sleep`, из них 33 внутри until/while — законный шаг опроса, а
// 23 standalone дольше 10 с (`sleep 25; gh pr checks`, `sleep 20 && gh run list`)
// — ровно тот класс, который Monitor закрывает без простоя.
const SLEEP_POLL_THRESHOLD_S = 10;
// Одна подсказка на тему в этот интервал; состояние — по сессии.
const COOLDOWN_MS = 10 * 60 * 1000;
// Файлы состояния живут в tmp и никем не читаются после сессии.
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

const STATE_DIR = path.join(os.tmpdir(), 'claude-bash-discipline');

// Команда, целиком состоящая из безопасной обвязки, — не повод для подсказки:
// префикс `cd <path> &&` стоит почти в каждом вызове субагента.
function stripPrefix(cmd) {
    const withoutCd = cmd
        .replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, '')
        .trim();
    // `bash -c '<команда>'` — та же команда шелла, только в обёртке. Без её
    // снятия правило обходится одним префиксом: и `bash -c 'sleep 600'`, и
    // `bash -c 'grep -rn Foo --include=*.kt .'` проходили мимо запрета, потому
    // что внутри кавычки команда не стоит в начале сегмента. Разворачивается
    // только явная форма с кавычками — `echo "sleep 600"` при этом остаётся
    // текстом и вердикта не получает.
    const wrapped = withoutCd.match(/^(?:bash|sh|zsh)\s+-[a-z]*c\s+(?:"([^"]*)"|'([^']*)')\s*$/i);
    return wrapped ? (wrapped[1] || wrapped[2] || '').trim() : withoutCd;
}

// `sleep 300`, `sleep 5m` — в любом сегменте команды, включая многострочные:
// `\n` в разделителях, иначе `sleep` со второй строки heredoc-скрипта не виден.
// Позиция нужна, чтобы отличить паузу внутри тела цикла от голой паузы.
function sleepOccurrences(cmd) {
    // Дробная часть учитывается, а не отбрасывается: `sleep 0.5m` — это 30 с, а
    // на `parseInt` оно давало 0 и проходило мимо порога (ревью 2026-08-21).
    // Префиксы `time`/`env`/`VAR=` разрешены — иначе `time sleep 600` не виден.
    const re = /(^|[;&|\n]|\bthen\b|\bdo\b)\s*(?:(?:[A-Z_][A-Z0-9_]*=\S*|env|time|nice|sudo|timeout\s+\d+[smh]?)\s+)*sleep\s+(\d+(?:\.\d+)?)([smh]?)\b/gi;
    const found = [];
    let m;
    while ((m = re.exec(cmd)) !== null) {
        const mult = m[3] === 'h' ? 3600 : m[3] === 'm' ? 60 : 1;
        // Округление обязательно: `sleep 0.07h` давало 252.00000000000003 с,
        // и это число уезжало в текст отказа.
        //
        // Индекс — позиция самого слова, а не начала матча: матч начинается с
        // РАЗДЕЛИТЕЛЯ (`;`, `&&`), который принадлежит предыдущему сегменту, и
        // на нём пауза из `python -c "…"; sleep 600` считалась прикрытой чужим
        // интерпретатором (ревью 2026-08-21, второй раунд).
        const at = m.index + m[0].search(/sleep/i);
        found.push({ seconds: Math.round(parseFloat(m[2]) * mult * 100) / 100, index: at });
    }
    return found;
}

function longSleepSeconds(cmd) {
    return sleepOccurrences(cmd).reduce((worst, s) => Math.max(worst, s.seconds), 0);
}

// Расширение обязано ЗАКАНЧИВАТЬ токен: `crash.kt.txt` и `run.ts.jsonl` — это
// логи, а не исходники, и на `\b` они проходили как код (ревью 2026-08-21).
const CODE_EXT = /\.(kt|kts|java|swift|ts|tsx|js|jsx|py|rs|go|rb|cs|c|cc|cpp|h|hpp|php|scala|dart)(?=$|["'\s;|&)])/i;
const DOC_EXT = /\.(md|json|ya?ml|toml|gradle|properties|xml)(?=$|["'\s;|&)])/i;
// Каталоги, поиск по которым — законная работа для grep: там нет символов,
// которые знает индекс. Логи и отчёты сборки открываются именно так.
const NON_CODE_DIR = /(^|[\\/])(logs?|build|dist|out|reports?|coverage|node_modules|\.gradle|tmp)([\\/]|$)/i;

// Проверять по ВСЕЙ команде нельзя: `grep -rn "build" --include=*.kt .` глушил
// правило словом в ПАТТЕРНЕ, а `… && ./gradlew build` — словом в соседнем
// звене цепочки; дописать `# build` хватало, чтобы обойти запрет целиком.
// Смотрим только на токены, похожие на пути.
// Токены-ПУТИ сегмента поиска: всё неопционное, кроме самого паттерна. Развести
// их обязательно, и обе стороны этой границы уже ломались: проверка по всей
// строке глушила правило словом в паттерне (`grep -rn "build" --include=*.kt .`
// проходил мимо), а проверка «токен с чужим именем каталога» вернула ту же дыру
// на уровне токенов. Паттерн у grep — первый неопционный токен; у find первый
// неопционный — это путь, паттерн живёт в `-name`.
function searchPaths(cmd) {
    const seg = stripComment(searchSegment(cmd));
    const head = seg.match(/\b(grep|rg|ack|find)\b/i);
    if (!head) return [];
    const after = seg.slice(seg.indexOf(head[0]) + head[0].length);
    const tokens = after.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    const paths = [];
    let patternSeen = /find/i.test(head[1]);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (/^--?[\w-]+=/.test(t)) continue;
        if (FLAG_WITH_VALUE.test(t)) { i++; continue; }
        if (/^-/.test(t)) continue;
        if (!patternSeen) { patternSeen = true; continue; }
        paths.push(t.replace(/^(["'])([\s\S]*)\1$/, '$2'));
    }
    return paths;
}

function touchesNonCodePath(cmd) {
    // Каталог пишут и со слэшем (`build/reports/`), и голым именем
    // (`grep -rn ERROR build`) — узнаём обе формы, но только среди путей.
    return searchPaths(cmd).some((t) => (
        /[\\/]/.test(t) ? NON_CODE_DIR.test(t) : NON_CODE_DIR.test(`/${t}/`)
    ));
}
// `rg --type kt` / `rg -t py` — тот же фильтр по коду, только языком.
const RG_TYPE = /(?:--type[= ]|\s-t\s*)(kt|kotlin|java|ts|typescript|js|javascript|py|python|swift|go|rust|rs|cs|csharp|dart|vue|cpp|c)\b/i;

// grep ПОСЛЕ пайпа фильтрует чужой вывод, а не ищет по файлам: `node tests.js |
// grep FAIL` — не поиск по коду, хотя в команде и `grep`, и путь с кодовым
// расширением. Прежняя регулярка ловила `grep` в любой позиции, включая пробел
// перед ним, и выдавала подсказку на такие команды (поймано живьём на прогоне
// собственных тестов; в замере 2026-08-20…21 это 106 команд из 498 — пятая
// часть срабатываний была шумом). Поэтому сегмент обязан НАЧИНАТЬСЯ с поиска;
// одиночный `|` разделителем сегмента не считается, `||` — считается.
// Обёртки, за которыми идёт настоящий поиск, разрешены явным списком.
// `git grep` и обёртки `env`/`command`/`nice`/`time` — тот же поиск по коду.
// Прежняя редакция ловила `git grep` пробелом перед `grep`, новая потеряла его
// вместе с шумом (ревью 2026-08-21), поэтому обёртки перечислены явно.
const SEARCH_AT_SEGMENT_START =
    /(?:^|[;\n]|&&|\|\|)\s*(?:(?:[A-Z_][A-Z0-9_]*=\S*|sudo|env|command|nice(?:\s+-n\s*-?\d+)?|time|timeout\s+\d+[smh]?|xargs(?:\s+-\S+)*|git)\s+)*(?:grep|rg|ack)\b/i;

// Поиск ФАЙЛОВ по имени — не текстовый поиск: замена ему тул Glob, а не Grep.
// Отдельная ветка нужна, чтобы отказ не предлагал `pattern: "find"` и
// `ast-index usages find` (ревью 2026-08-21: обе оси, high).
// `rg --files -g "*.kt"` — тот же листинг файлов, что и `find -name`: без него
// он получал отказ с `pattern: "*.kt"` и советом искать этот glob как текст.
const FIND_BY_NAME = /(?:^|[;\n]|&&|\|\|)\s*(?:sudo\s+)?find\b[^|]*-(?:i)?name\b/i;
const RG_FILES = /(?:^|[;\n]|&&|\|\|)\s*(?:sudo\s+)?rg\b[^|]*\s--files\b/i;
// `find … -exec/-delete` — пакетная операция над файлами, а не листинг: у неё
// замены нет вовсе, и трогать её нельзя даже подсказкой.
const FIND_MUTATES = /\s-(?:exec|execdir|delete|ok|okdir)\b/i;

// Текстовый поиск по ИСХОДНИКАМ: grep/rg/ack/find. Поиск по логам, отчётам и
// произвольному тексту не трогаем — подсказка, которая срабатывает не по делу,
// перестаёт читаться, и это дороже пропущенного случая.
function isCodeSearch(cmd) {
    const isSearch = SEARCH_AT_SEGMENT_START.test(cmd)
        || (FIND_BY_NAME.test(cmd) && !FIND_MUTATES.test(cmd));
    if (!isSearch) return false;
    if (touchesNonCodePath(cmd)) return false;
    // Явный фильтр по кодовому расширению — самый надёжный признак.
    if (CODE_EXT.test(cmd)) return true;
    // У rg тот же фильтр пишется языком, а не расширением: `rg --type kt`.
    if (RG_TYPE.test(cmd)) return true;
    // Рекурсивный обход без фильтра по расширению: `grep -rn Foo .`, а у `rg` и
    // `ack` рекурсия включена по умолчанию (у `rg` флаг `-r` вообще значит
    // `--replace`, поэтому требовать его было ошибкой — самая идиоматичная
    // форма ripgrep не ловилась ни одним признаком).
    return /\b(grep|ack)\b[^|]*\s-[a-z]*r/i.test(cmd)
        || /(?:^|[;\n]|&&|\|\|)\s*(?:\S+=\S*\s+|sudo\s+|env\s+|command\s+|git\s+)*(?:rg|ack)\b/i.test(cmd);
}

// Явный фильтр по коду — единственное, что даёт право на ЗАПРЕТ. Рекурсивный
// поиск без такого фильтра может идти по чему угодно (`grep -rn TODO docs`,
// заметки, конфиги), и запрет там был бы ложным: остаётся подсказка.
// Разделение введено после того, как ревью показало deny на `grep -rn TODO docs`
// при тексте отказа, который сам же разрешает поиск по не-исходникам.
function hasExplicitCodeFilter(cmd) {
    return CODE_EXT.test(cmd) || RG_TYPE.test(cmd);
}

// `grep -q` не отдаёт вывод — он даёт код возврата, на котором висит `&&`.
// Тул Grep такой семантики не имеет, заменить нечем.
function isPredicateSearch(cmd) {
    return /\b(?:grep|rg|ack)\b[^|]*\s-(?:[a-z]*q|-quiet|-silent)\b/i.test(cmd);
}

// Чтение конкретного файла: cat/head/tail/sed -n по пути. Якорь `^` здесь
// несёт смысл — он отделяет чтение файла от обрезки чужого вывода
// (`./gradlew test | head -50`), где head не читает файл и Read неприменим.
// Поэтому cd-префикс обязан быть срезан ДО этой проверки (см. stripPrefix).
function isFileRead(cmd) {
    if (!/^\s*(cat|head|tail|sed\s+-n)\b/i.test(cmd)) return false;
    // `cat > file` и `cat <<EOF` — это ЗАПИСЬ, а не чтение: Read тут не при чём,
    // а слот кулдауна был бы потрачен впустую.
    const beforePipe = cmd.split('|')[0];
    if (/[<>]/.test(beforePipe)) return false;
    return CODE_EXT.test(cmd) || DOC_EXT.test(cmd);
}

// Ключ состояния приходит из полезной нагрузки хука и попадает в имя файла:
// без нормализации `../..` увёл бы запись за пределы каталога состояния.
function stateFile(key) {
    const safe = String(key || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    return path.join(STATE_DIR, `${safe}.json`);
}

function readState(sessionId) {
    try {
        return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
    } catch (e) {
        return {};
    }
}

// Подметает чужие протухшие файлы состояния. Вызывается только при первой
// записи в сессии (state пуст), поэтому readdir не платится на каждом вызове.
function sweepStale() {
    try {
        const now = Date.now();
        for (const name of fs.readdirSync(STATE_DIR)) {
            const p = path.join(STATE_DIR, name);
            try {
                if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.unlinkSync(p);
            } catch (e) { /* файл уже унесли — не наша забота */ }
        }
    } catch (e) { /* каталога нет — подметать нечего */ }
}

function writeState(sessionId, state, firstWrite) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        if (firstWrite) sweepStale();
        fs.writeFileSync(stateFile(sessionId), JSON.stringify(state));
    } catch (e) {
        // Подсказка — не то, ради чего стоит ронять хук.
    }
}

const HINTS = {
    // Сюда доходит только то, что запрет пропустил: поиск с выводом в обработку,
    // редирект, heredoc. Тул Grep там как раз НЕ применим, поэтому подсказка
    // ведёт в ast-index и не повторяет «ищи тулом Grep» (ревью 2026-08-21).
    search:
        'Ищешь символ — `ast-index` дешевле и точнее пайплайна на grep: '
        + '`ast-index usages <Symbol>` (кто использует), `ast-index refs <Symbol>` (определения+импорты+использования), '
        + '`ast-index symbol|class <Name>` (определение), `ast-index explore <Symbol>` (исходник+вызывающие+тесты одним вызовом). '
        + 'Индекс держит хук плагина, `rebuild`/`update` не запускай. '
        + 'Здесь Bash уместен — вывод уходит дальше по команде; для поиска, результат которого читаешь сам, есть тул Grep.',
    read:
        'Файл читай тулом Read, а не через cat/head/sed. Вызов Bash-тула дороже нативного и после снятия '
        + 'шелл-налога (замер 2026-08-21: медиана 1.1 с против 0.9 с), а главное — Read отдаёт файл с номерами '
        + 'строк и без ручной нарезки. Bash оставь тому, что без процесса не сделать: сборка, тесты, git, ast-index.',
};

// Чистая проверка на долгий sleep — без чтения и записи состояния. Отделена от
// judge намеренно: вызывающая сторона проверяет sleep раньше credentials-guard,
// и второй вызов judge впустую потратил бы слот кулдауна подсказок.
// Внутри until/while-цикла sleep играет ОБРАТНУЮ роль: он держит шаг опроса, и
// пауза там — правильная форма ожидания, а не простой. Поэтому цикл судится
// прежним порогом, а голая пауза перед разовой проверкой — низким.
//
// Границы тела цикла считаются позиционно, а не наличием слов: `sleep 25; echo
// "while true do"` содержит и `while`, и `do`, но циклом не является — на
// проверке словами такая команда получала бы порог 30 с и проходила мимо
// запрета. Поэтому нужны обе границы (`do` … `done`) и попадание паузы между ними.
function loopBodies(cmd) {
    // Ранний выход: без `done` тела цикла нет вовсе, а перебор всех `do` со
    // срезом строки на каждом — единственный суперлинейный путь в модуле
    // (46 мс на команде 72 КБ с 8000 `do`; хук висит на каждом вызове Bash).
    if (!/\bdone\b/i.test(cmd)) return [];
    const ranges = [];
    const re = /\bdo\b/gi;
    let m;
    while ((m = re.exec(cmd)) !== null) {
        const done = cmd.slice(m.index).search(/\bdone\b/i);
        if (done === -1) continue;
        const head = cmd.slice(0, m.index);
        // Тело маскируется: слово `break` в строке (`echo "break"`) — не выход
        // из цикла, а текст, и на нём перебор списка выдавал себя за поллинг.
        const body = maskQuoted(cmd.slice(m.index, m.index + done));
        // `until`/`while` — ожидание по условию по определению. `for` — только
        // когда в теле есть `break`: `for i in $(seq 1 20); … break; sleep 15`
        // это ограниченный поллинг (ровно та форма, которую рекомендует
        // mr-merge.md), а `for f in a b; do sleep 20; done` — перебор списка, и
        // пауза там такой же простой, как голая.
        // `while read` — перебор строк файла, а не ожидание события: пауза в нём
        // такой же простой, как в `for` без `break`.
        const isWait = (/\b(until|while)\b/i.test(head) && !/\bwhile\s+read\b/i.test(head))
            || (/\b(for|while\s+read)\b/i.test(head) && /\bbreak\b/.test(body));
        if (!isWait) continue;
        ranges.push([m.index, m.index + done]);
    }
    return ranges;
}

function insideLoop(cmd, index) {
    const bodies = loopBodies(cmd);
    if (typeof index !== 'number') return bodies.length > 0;
    return bodies.some(([from, to]) => index >= from && index <= to);
}

function sleepVerdict(command) {
    if (!command || typeof command !== 'string') return null;
    if (process.env.CLAUDE_ALLOW_SLEEP === '1') return null;
    const cmd = stripPrefix(command);
    // Пауза внутри программы на чужом языке — не ожидание шелла, а её текст.
    // Проверка ПОСЕГМЕНТНАЯ: `python -c "print(1)"; sleep 600` — пауза стоит в
    // соседнем сегменте и интерпретатором не прикрыта (ревью, второй раунд).
    const foreign = segments(cmd).filter((s) => insideInterpreter(s.text));
    const shielded = (i) => foreign.some((s) => i >= s.from && i <= s.to);
    // Каждая пауза судится своим порогом: одна и та же команда может держать и
    // законный шаг опроса в цикле, и голую паузу перед ним.
    let slept = 0;
    let limit = SLEEP_POLL_THRESHOLD_S;
    for (const s of sleepOccurrences(cmd)) {
        if (shielded(s.index)) continue;
        const own = insideLoop(cmd, s.index) ? SLEEP_DENY_THRESHOLD_S : SLEEP_POLL_THRESHOLD_S;
        if (s.seconds > own && s.seconds > slept) {
            slept = s.seconds;
            limit = own;
        }
    }
    if (slept <= limit) return null;
    if (slept > SLEEP_DENY_THRESHOLD_S) {
        return {
            decision: 'deny',
            reason:
                `Команда простаивает ${slept} с в \`sleep\`. Так ждать нельзя: `
                + 'долгую команду запускай через `run_in_background` и получай уведомление о завершении, '
                + 'а на внешнее событие (CI, деплой, эмулятор) ставь Monitor с условием. '
                + `Короткий sleep (≤${SLEEP_DENY_THRESHOLD_S} с) разрешён как шаг опроса внутри `
                + '`until`/`while`-цикла и внутри `for` с `break`; '
                + 'если ожидание действительно неизбежно — попроси пользователя выставить CLAUDE_ALLOW_SLEEP=1.',
        };
    }
    return {
        decision: 'deny',
        reason:
            `Пауза ${slept} с перед разовой проверкой — это ожидание по таймеру вместо ожидания по условию: `
            + 'угадал мало — проверяешь ещё раз, угадал много — простаиваешь. '
            + 'Жди условие: `until <проверка>; do sleep 15; done` — и запускай этот цикл '
            + 'через `run_in_background`, тогда завершение придёт уведомлением, а таймаут вызова его не срежет. '
            + `Внутри \`until\`/\`while\` и внутри \`for\` с \`break\` пауза — правильный шаг опроса, до ${SLEEP_DENY_THRESHOLD_S} с; `
            + 'неизбежное ожидание — попроси пользователя выставить CLAUDE_ALLOW_SLEEP=1.',
    };
}

// Приёмники, которые ничего не обрабатывают: они лишь показывают или считают
// то же, что вернул бы сам поиск, а у тула Grep для этого есть свои режимы
// (`head_limit`, count). Иначе `| cat` в конце снимал бы запрет одним символом —
// то есть правило обходилось бы, не переставая быть правилом.
// Флаг со значением пишут и через пробел (`head -n 50`), и слитно (`head -50`) —
// граница «показывает vs обрабатывает» не должна зависеть от формы записи.
const PASSTHROUGH_SINK = /^\s*(?:cat|head|tail|more|less|wc|sort|uniq|nl)\b(?:\s+(?:-\S+|\+?\d+))*\s*$/i;

// Кавычки скрывают спецсимволы: `grep -rEn "foo|bar"` — это альтернация, а не
// пайп, и на наивном split запрет снимался самой частой формой regex. Маска
// сохраняет длину, поэтому позиции в исходной строке не съезжают.
// Посимвольный сканер вместо регулярки: правила цитирования bash регуляркой не
// выражаются. `\"` внутри двойных кавычек строку не закрывает, `\'` ВНЕ кавычек
// не открывает её, а внутри одинарных экранирования нет вовсе. На regex-версии
// обе формы ломались в разные стороны — ложный deny на
// `grep -rn It\'s … | xargs sed` (маска глотала пайп) и обход на
// `grep -rnE "foo\"|bar"` (маска раскрывала кавычку, и `|` становился пайпом).
// Маска сохраняет длину строки, поэтому позиции разделителей остаются годными.
function maskQuoted(cmd) {
    const out = cmd.split('');
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote !== "'" && ch === '\\' && i + 1 < cmd.length) {
            if (quote === '"') out[i + 1] = ' ';
            i++;
            continue;
        }
        if (quote === null && (ch === '"' || ch === "'")) { quote = ch; continue; }
        if (quote !== null && ch === quote) { quote = null; continue; }
        if (quote !== null) out[i] = ' ';
    }
    return out.join('');
}

// Вывод поиска уходит дальше — в обработку другой командой или в файл. Тул Grep
// так не умеет: он отдаёт результат агенту, а не в пайп, поэтому там Bash
// остаётся единственным способом и запрет был бы ложным.
function feedsAnotherCommand(cmd) {
    const masked = maskQuoted(cmd);
    // Листинг, чей вывод уходит в другую команду (`find … | xargs grep Foo`), —
    // не листинг: это поиск по содержимому, и заменить его тулом Glob нельзя.
    // Прежде такая цепочка получала отказ с текстом про Glob, терявшим grep-часть.
    if (/\bfind\b[^|]*\|/i.test(masked) || /\brg\b[^|]*--files[^|]*\|/i.test(masked)) return true;
    // Редирект вывода в файл — да, включая `&>` (он уводит в файл и stdout, и
    // stderr, то есть результат поиска действительно уходит из чата). Редирект
    // ОДНОГО stderr (`2>/dev/null`, `2>&1`) — нет: результат по-прежнему
    // читает агент, и запрет снимался бы хвостом в три символа.
    // `&>` и `1>` уводят вывод в файл — это исключение из запрета. Исключается
    // только редирект ОДНОГО stderr: `2>`, `2>&1`, `>&2`.
    if (/(?:&>|\b1>)/.test(masked)) return true;
    if (/\b(?:grep|rg|ack)\b[^|>]*(?<![0-9&])>(?!&\s*2)/i.test(masked)) return true;
    // Режем ИСХОДНУЮ строку по позициям пайпов, найденным в маске: так кавычки
    // не делят команду, а куски остаются настоящими для дальнейшего разбора.
    const cuts = [];
    for (let i = 0; i < masked.length; i++) if (masked[i] === '|') cuts.push(i);
    const parts = [];
    let from = 0;
    for (const at of cuts) { parts.push(cmd.slice(from, at)); from = at + 1; }
    parts.push(cmd.slice(from));
    for (let i = 0; i < parts.length - 1; i++) {
        if (!/\b(?:grep|rg|ack)\b/i.test(parts[i])) continue;
        // Всё, что стоит за поиском, должно быть безобидным — иначе это обработка.
        return parts.slice(i + 1).some((p) => !PASSTHROUGH_SINK.test(p));
    }
    return false;
}

// Код на ЧУЖОМ языке (heredoc, `python -c`, `node -e`) — не команды шелла:
// слова `grep` и `sleep` внутри него это текст программы, а не вызов. Поймано
// живьём: проверочный `node -e "... sleep 120 ..."` получил deny как ожидание.
// `bash -c` сюда НЕ входит намеренно — внутри него шелл, и обёртка не должна
// служить способом обойти правило.
function insideInterpreter(cmd) {
    // По МАСКЕ: маркер heredoc внутри поискового паттерна (`grep -rn "a<<EOF"`)
    // выключал оба запрета целиком.
    const masked = maskQuoted(cmd);
    // Heredoc, скормленный `bash`/`sh`, — это шелл, а не чужой язык: `bash <<EOF
    // sleep 600 EOF` снимал оба запрета одной строкой, ровно как обёртка
    // `bash -c`, которая под запретом оставлена намеренно (ревью 2026-08-21).
    if (/(?:^|[;&|]\s*)(?:bash|sh|zsh)\b[^;|&]*<<-?\s*['"]?\w+/i.test(masked)) return false;
    return /<<-?\s*['"]?\w+/.test(masked)
        // `[^;&|]*`, а не `[^;]*`: иначе `node build.js && grep -c Foo src/Foo.kt`
        // засчитывал `-c` от grep как флаг интерпретатора и снимал запрет с
        // остатка цепочки (ревью 2026-08-21, второй раунд).
        || /(?:^|[;&|]\s*)(?:python\d?|node|perl|ruby|osascript)\b[^;&|]*\s-(?:c|e)\b/i.test(masked);
}

// Прикрыт ли ПОИСК чужим интерпретатором. Две половины судятся по-разному, и это
// не симметрия ради симметрии:
//   * heredoc — по всей команде: его тело физически продолжается за `;` и `&&`,
//     и сужение до сегмента разорвало бы разметку (`cat <<EOF … grep … EOF`);
//   * однострочка `python -c` / `node -e` — по сегменту поиска: она кончается
//     на своём разделителе. На всей команде `python -c "import sys" ; grep -rn
//     Foo --include=*.py .` снимал запрет соседним сегментом — тот же обход
//     склейкой, который закрыт для feedsAnotherCommand (ревью 2026-08-31).
function interpreterShieldsSearch(cmd) {
    const masked = maskQuoted(cmd);
    const heredocToShell = /(?:^|[;&|]\s*)(?:bash|sh|zsh)\b[^;|&]*<<-?\s*['"]?\w+/i.test(masked);
    if (!heredocToShell && /<<-?\s*['"]?\w+/.test(masked)) return true;
    return /(?:^|[;&|]\s*)(?:python\d?|node|perl|ruby|osascript)\b[^;&|]*\s-(?:c|e)\b/i
        .test(maskQuoted(searchSegment(cmd)));
}

// Из команды достаётся то, что нужно для готовой замены в тексте отказа:
// сам паттерн и фильтр по расширению. Без них отказ звучит как «нельзя», а
// должен звучать как «вот та же работа другим инструментом».
// Флаги, забирающие следующее слово как значение: без их списка `-rn` съедает
// сам паттерн, и в тексте отказа оказывается мусор вместо готовой замены.
const FLAG_WITH_VALUE = /^(?:--(?:include|exclude|type|glob|max-count|after-context|before-context|context)|-[tmABCg])$/;
// Регистр в списке выше значим: с флагом `/i` класс `[egtmABC]` ловил ещё и
// `-c` (`--count`, значения не берёт) и `-e` (его значение и ЕСТЬ паттерн) —
// в обоих случаях паттерн уезжал в имя файла, и отказ предлагал искать путь.

// Сегмент, в котором стоит сам поиск. Разбирать всю команду нельзя: в цепочке
// `python fix_market.py apps/i18n.js && node --check … && grep -n key apps/i18n.js`
// фильтр по расширению вычислялся из ЧУЖОГО сегмента и в текст отказа уезжал
// `glob: "*.py"` при поиске по `.js` — то есть готовая замена вела в никуда
// (поймано прогоном вердикта по реальным командам из транскриптов).
// Комментарий отрезается по маске: `grep … . # see build/x` глушил правило
// путём из комментария — обход в два токена (ревью 2026-08-21, второй раунд).
function stripComment(cmd) {
    const masked = maskQuoted(cmd);
    const at = masked.search(/(?:^|\s)#/);
    return at === -1 ? cmd : cmd.slice(0, at);
}

// Сегменты команды с их границами. Разделители ищутся по маске, чтобы `;` и
// `&&` внутри кавычек команду не разваливали.
function segments(cmd) {
    const masked = maskQuoted(cmd);
    const out = [];
    const re = /;|&&|\|\||\n/g;
    let m;
    let from = 0;
    while ((m = re.exec(masked)) !== null) {
        out.push({ text: cmd.slice(from, m.index), from, to: m.index });
        from = m.index + m[0].length;
    }
    out.push({ text: cmd.slice(from), from, to: cmd.length });
    return out;
}

function searchSegment(cmd) {
    // Резать по СЫРОЙ строке нельзя: `grep -rn "a && b" --include=*.kt .`
    // разваливался по разделителю внутри кавычек, и в отказ уезжал обрывок
    // паттерна плюс ложная приписка про цепочку (ревью 2026-08-21, второй раунд).
    // Техника та же, что в feedsAnotherCommand: ищем разделители по маске,
    // режем исходную строку по найденным позициям.
    const masked = maskQuoted(cmd);
    const bounds = [];
    const re = /;|&&|\|\||\n/g;
    let m;
    while ((m = re.exec(masked)) !== null) bounds.push([m.index, m.index + m[0].length]);
    const parts = [];
    let from = 0;
    for (const [at, to] of bounds) { parts.push(cmd.slice(from, at)); from = to; }
    parts.push(cmd.slice(from));
    for (const part of parts) {
        if (SEARCH_AT_SEGMENT_START.test(part.trim() ? `;${part}` : part)) return part.trim();
    }
    return cmd;
}

function searchPattern(cmd) {
    const after = cmd.replace(/^[\s\S]*?\b(grep|rg|ack)\b/i, '');
    const tokens = after.match(/(?:"[^"]*"|'[^']*'|\S)+/g) || [];
    const unquote = (t) => t.replace(/^(["'])([\s\S]*)\1$/, '$2');
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        // `--regexp=Foo` — единственная форма, требующая отдельной ветки: общее
        // правило «флаг со значением через `=` пропускаем» съело бы и паттерн.
        // Форма `-e Foo` отдельной ветки НЕ требует — `-e` уходит в общий
        // пропуск флагов, и паттерном становится следующий токен. Мутационная
        // матрица показала это прямо: удаление такой ветки не роняло ни одного
        // теста, то есть она была мёртвым кодом.
        const eq = t.match(/^(?:--regexp|--file)=([\s\S]+)$/);
        if (eq) return unquote(eq[1]);
        if (/^--?[\w-]+=/.test(t)) continue;
        if (FLAG_WITH_VALUE.test(t)) { i++; continue; }
        if (/^-/.test(t)) continue;
        return unquote(t);
    }
    return null;
}

function searchGlob(cmd) {
    const inc = cmd.match(/--include[= ](["']?)([^"'\s]+)\1/i);
    if (inc) return inc[2];
    const type = cmd.match(/(?:--type[= ]|\s-t\s*)([a-z]+)\b/i);
    if (type) return `*.${type[1]}`;
    const ext = cmd.match(CODE_EXT);
    return ext ? `*${ext[0]}` : null;
}

// Текстовый поиск по исходникам через Bash — единственный класс, доросший до
// запрета. Основание: подсказка про ast-index висела месяц и сдвинула долю с
// 1 вызова на 2 230 grep до 19 на 463 — то есть работает, но текстовый grep
// по-прежнему кратно преобладает (замер 2026-08-20). Запрет мягкий по сути:
// он не отнимает возможность искать, а переводит тот же поиск в нативный тул
// Grep, который есть в любом проекте и не требует индекса — поэтому deny не
// зависит от того, проиндексирован ли репозиторий (проверено: у части проектов
// индекса нет вовсе, `ast-index` там отвечает «Index not found»).
function codeSearchVerdict(command) {
    if (!command || typeof command !== 'string') return null;
    if (process.env.CLAUDE_ALLOW_CODE_GREP === '1') return null;
    const cmd = stripPrefix(command);
    if (!isCodeSearch(cmd)) return null;
    // Обработка вывода судится по СЕГМЕНТУ поиска, а не по всей команде. Иначе
    // запрет снимается склейкой: `grep … --include=*.js . | head -20; echo "==="`
    // — `head` тут безобидный приёмник, но кусок после пайпа содержал ещё и
    // `; echo`, не проходил PASSTHROUGH_SINK, и вся команда объявлялась
    // «обработкой». Замер 2026-08-31: так уходило от запрета большинство
    // оставшихся поисков — агенты склеивают вызовы через `;`/`&&` по правилу
    // «несколько команд одним вызовом», и оно же глушило дисциплину.
    if (feedsAnotherCommand(searchSegment(cmd)) || interpreterShieldsSearch(cmd)) return null;
    if (isPredicateSearch(cmd)) return null;
    // Листинг файлов судится своей веткой ниже, у него фильтр по коду не нужен.
    if (!hasExplicitCodeFilter(cmd) && !RG_FILES.test(cmd) && !FIND_BY_NAME.test(cmd)) return null;

    const segment = searchSegment(cmd);
    // Поиск как звено цепочки: запрет останавливает всю команду, поэтому отказ
    // обязан сказать, что делать с остальными звеньями, иначе агент упрётся.
    const chained = segment !== cmd.trim()
        ? ' Остальные звенья команды выполни отдельным вызовом — запрет останавливает всю цепочку.'
        : '';
    // Снять запрет может только пользователь: переменная читается из окружения
    // процесса хука, а inline-префикс в команде до него не доходит. Обещать
    // агенту хатч, которого у него нет, — это гарантированный fail-loop
    // «отказ → та же команда с префиксом → тот же отказ» (ревью 2026-08-21).
    const hatch = ' Запрет снимает пользователь — переменной `CLAUDE_ALLOW_CODE_GREP=1`'
        + ' в окружении сессии; префикс в самой команде до хука не доходит и не поможет.';

    // Поиск ФАЙЛОВ по имени заменяется тулом Glob, а не Grep: у него нет ни
    // паттерна текста, ни символа, и прежний общий текст выдавал `pattern: "find"`.
    const listsFiles = RG_FILES.test(cmd)
        || (!SEARCH_AT_SEGMENT_START.test(cmd) && FIND_BY_NAME.test(cmd));
    // Листинг, чей результат уходит в поиск по содержимому (`find … | xargs grep`),
    // Glob'ом не заменяется — там работа совсем другая, и щадится он выше, в
    // feedsAnotherCommand. Здесь остаётся чистый листинг.
    if (listsFiles) {
        const name = cmd.match(/-(?:i)?name\s+(["']?)([^"'\s]+)\1/i)
            || cmd.match(/\s-g\s+(["']?)([^"'\s]+)\1/i);
        const globCall = name ? `тул Glob (pattern: "**/${name[2]}")` : 'тул Glob';
        return {
            decision: 'deny',
            reason:
                `Поиск файлов по имени через Bash. Ту же работу делает ${globCall} — `
                + 'нативный тул, без старта шелла.' + chained + hatch,
        };
    }

    const pat = searchPattern(segment);
    const glob = searchGlob(segment);
    // Паттерн уходит в текст как готовый аргумент, поэтому кавычки внутри него
    // обязаны быть экранированы: `grep -rn 'val "x"'` иначе даёт неразбираемое
    // `pattern: "val "x""`, и агент копирует сломанную строку.
    const grepCall = pat
        ? `тул Grep (pattern: ${JSON.stringify(pat)}${glob ? `, glob: ${JSON.stringify(glob)}` : ''})`
        : 'тул Grep';
    // ast-index предлагается только когда ищут по КОДУ: на `--include=*.md`
    // индекс не распространяется, и совет `ast-index usages TODO` был бы
    // отправкой в инструмент, который этих файлов не видит (ревью 2026-08-21).
    const looksLikeCode = CODE_EXT.test(segment) || RG_TYPE.test(segment)
        || !/--include|--type|-g\s/i.test(segment);
    const astCall = pat && looksLikeCode && /^[A-Za-z_][A-Za-z0-9_]*$/.test(pat)
        ? ` Ищешь символ, а не текст — \`ast-index usages ${pat}\` (или \`refs\`/\`explore\`) даёт использования без совпадений в комментариях и импортах.`
        : '';
    return {
        decision: 'deny',
        reason:
            `Поиск по исходникам через Bash. Ту же работу делает ${grepCall} — нативный тул, `
            + 'без старта шелла и без ручной фильтрации вывода.'
            + astCall
            + chained
            + ' Bash остаётся правильным, когда вывод уходит в обработку (`| xargs sed`, редирект в файл),'
            + ' когда поиск идёт по логам, отчётам сборки или бинарям, и внутри heredoc или `python -c`.'
            + hatch,
    };
}

// --- тул Grep -------------------------------------------------------------
// Плагинная напоминалка ast-index висит на PreToolUse(Grep) с рождения и НЕ
// блокирует. Замер 2026-08-31 за неделю: 3 374 вызова Grep против 82 вызовов
// ast-index — подсказку читают и не исполняют, ровно как читали подсказку про
// grep в Bash до запрета.
//
// Запрет здесь устроен иначе, чем в Bash, и причина — отсутствие дешёвой
// проверки «есть ли индекс у этого проекта»: индекс лежит в
// %LOCALAPPDATA%/ast-index/<hash>/index.db без обратного маппинга на путь, а
// спавн `ast-index stats` на КАЖДЫЙ Grep стоил бы дороже самой экономии.
// Поэтому запрет ОДНОРАЗОВЫЙ на паттерн: первый Grep по символу отклоняется с
// готовой командой ast-index, повтор того же паттерна проходит. Индекса нет,
// ast-index ответил пусто — агент повторяет Grep и работает дальше; тупика,
// в котором нечем искать, не возникает.
const GREP_RETRY_WINDOW_MS = 30 * 60 * 1000;
// Паттерн-символ: голый идентификатор без regex-метасимволов. Одного этого мало —
// под него попадает половина обычных текстовых поисков, а `ast-index` по
// построению не отвечает на литералы и комментарии, и отказ на них стоил бы
// агенту трёх turn'ов вместо одного (Grep → ast-index пусто → Grep снова).
// Поэтому дополнительно требуется признак ИМЕНИ: заглавная не в первой позиции
// (`PurchaseGate`, `getUser`) либо явный кодовый фильтр при PascalCase-имени
// (`Paywall` + `glob: *.kt`). Отсекается ровно то, на чём индекс молчит:
// `TODO`, `FIXME` (нет строчных), `premium_purchase`, `onboarding` (нет
// заглавных) — ревью 2026-08-31 прогнало эти случаи живьём.
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;
const NON_CODE_GLOB = /\.(md|json|ya?ml|toml|txt|csv|lock|log|xml|properties|gradle)(?=$|["'\s,}])/i;
const CODE_GLOB = /\.(kt|kts|java|swift|ts|tsx|js|jsx|py|rs|go|rb|cs|c|cc|cpp|h|hpp|php|scala|dart)(?=$|["'\s,}])/i;
// `*.gradle.kts` формально кончается на `.kts`, но индекса по build-скриптам нет —
// и инструкции агентов прямо велят искать в них тулом `Grep`. Без этой проверки
// `Grep(pattern:"Paywall", glob:"**/*.gradle.kts")` получал отказ с советом
// `ast-index usages Paywall`, индекс отвечал пусто, агент повторял тот же Grep:
// два turn'а на пустом месте (ревью 2026-08-31, второй проход).
const BUILD_SCRIPT_GLOB = /\.gradle(\.kts)?(?=$|["'\s,}])/i;
const CODE_TYPE = /^(kt|kotlin|java|ts|typescript|js|javascript|py|python|swift|go|rust|rs|cs|csharp|dart|cpp|c)$/i;

function looksLikeSymbolName(pattern, scopedToCode) {
    if (!IDENTIFIER_PATTERN.test(pattern)) return false;
    if (!/[a-z]/.test(pattern)) return false;           // TODO, FIXME, HTTP_OK
    if (/[A-Z]/.test(pattern.slice(1))) return true;    // PurchaseGate, getUser
    return scopedToCode && /^[A-Z]/.test(pattern);      // Paywall + glob: *.kt
}

function grepVerdict(toolInput, key) {
    if (process.env.CLAUDE_ALLOW_CODE_GREP === '1') return null;
    const input = toolInput || {};
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    // Регистронезависимый и многострочный поиск — не то, что делает ast-index:
    // он ищет символ как символ, точным именем.
    if (input['-i'] === true || input.multiline === true) return null;
    // Фильтр указывает на не-код — индекс этих файлов не видит.
    if (input.glob && NON_CODE_GLOB.test(String(input.glob))) return null;
    if (input.glob && BUILD_SCRIPT_GLOB.test(String(input.glob))) return null;
    if (input.type && /^(md|markdown|json|yaml|yml|toml|txt|csv|xml)$/i.test(String(input.type))) return null;
    if (input.path && NON_CODE_DIR.test(String(input.path).replace(/\\/g, '/'))) return null;

    const scopedToCode = (input.glob && CODE_GLOB.test(String(input.glob)))
        || (input.type && CODE_TYPE.test(String(input.type)));
    if (!looksLikeSymbolName(pattern, scopedToCode)) return null;

    const state = readState(key);
    const seen = state.greps || {};
    const now = Date.now();
    if (seen[pattern] && now - seen[pattern] < GREP_RETRY_WINDOW_MS) return null;
    const firstWrite = Object.keys(state).length === 0;
    seen[pattern] = now;
    state.greps = seen;
    writeState(key, state, firstWrite);

    return {
        decision: 'deny',
        reason:
            `\`${pattern}\` — это имя символа, а не текст. Тем же одним вызовом: `
            + `\`ast-index usages ${pattern}\` (кто использует), \`ast-index refs ${pattern}\` `
            + `(определения + импорты + использования), \`ast-index symbol|class ${pattern}\` (определение), `
            + `\`ast-index explore ${pattern}\` (исходник + вызывающие + тесты сразу). `
            + 'Индекс не даёт совпадений в комментариях, строках и импортах, поэтому результат не нужно фильтровать глазами. '
            + '`rebuild`/`update` не запускай — индекс держит хук плагина. '
            + `Индекса у проекта нет или ответ пуст — **повтори этот же Grep**, второй раз он пройдёт (запрет одноразовый на паттерн).`,
    };
}

// Возвращает вердикт для харнесса либо null, если сказать нечего.
// `key` нужен только для дедупликации подсказок и должен различать АГЕНТОВ, а не
// сессии: субагенты фан-аута получают session_id родителя, и на ключе по сессии
// подсказку увидел бы первый агент из двенадцати, а остальные — никогда.
// Поэтому вызывающая сторона передаёт transcript_path (у каждого агента свой),
// с откатом на session_id.
function judge(command, key) {
    const denial = sleepVerdict(command) || codeSearchVerdict(command);
    if (denial) return denial;

    if (!command || typeof command !== 'string') return null;
    const cmd = stripPrefix(command);
    if (!cmd) return null;

    // Сюда поиск доходит только тем, что запрет пропустил (пайп, редирект,
    // heredoc, снятый escape hatch) — там подсказка по-прежнему уместна.
    let topic = null;
    if (isCodeSearch(cmd)) topic = 'search';
    else if (isFileRead(cmd)) topic = 'read';
    if (!topic) return null;

    const state = readState(key);
    const now = Date.now();
    if (state[topic] && now - state[topic] < COOLDOWN_MS) return null;
    const firstWrite = Object.keys(state).length === 0;
    state[topic] = now;
    writeState(key, state, firstWrite);

    return { decision: 'allow', context: HINTS[topic] };
}

module.exports = {
    judge,
    sleepVerdict,
    codeSearchVerdict,
    grepVerdict,
    longSleepSeconds,
    insideLoop,
    feedsAnotherCommand,
    insideInterpreter,
    isCodeSearch,
    isFileRead,
    stripPrefix,
    SLEEP_DENY_THRESHOLD_S,
    SLEEP_POLL_THRESHOLD_S,
};
