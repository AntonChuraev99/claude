---
name: task-gate
description: Definition of Done gate завершённой ЗАДАЧИ (фича/фикс/рефакторинг) — не «конец сессии». Запускается на каждую завершённую задачу; несколько прогонов за сессию — норма (каждый прогон скоупится диффом с прошлого gate). Прогоняет полный DoD gate из глобального CLAUDE.md (документация, коммит, поверхностная проверка субагентов), извлекает рекомендации от @doc-writer и ставит их в очередь. Если единственный оставшийся блокер — несделанный коммит, а все остальные пункты зелёные или warning, скилл сам вызывает /commit и закрывает gate без участия пользователя. Используй когда задача завершена и пора отчитаться: "готово", "готово?", "задача готова", "фича готова", "фикс готов", "финализируй", "проверь всё перед завершением", а также на завершении сессии: "заканчиваем", "завершаем сессию", "end session", "можно закрывать?", "wrap up", "финал" — или когда главный агент сам считает задачу выполненной. Запускай этот скилл ДО того, как сообщить пользователю об окончательной готовности — gate без скилла не считается пройденным. Ранее назывался end-session (переименован 2026-07-24).
---

# Task Gate — Definition of Done

Скилл-чеклист, проверяет, что завершённую задачу можно безопасно закрыть. Источник правил — Definition of Done в глобальном `~/.claude/CLAUDE.md`. Единица работы — **задача** (фича/фикс), не сессия: за сессию с несколькими задачами скилл запускается несколько раз, по разу на задачу.

## Зачем это нужно

После сложной задачи легко забыть обязательный пункт: `@doc-writer COMPLETE`, обновить `~/.claude/stats/doc-writer.md`, дописать `INDEX_ROW` в `docs/solutions/INDEX.md`, сделать коммит через `/commit`. Каждый пропуск ломает compound effect. Запускай **до** финального ответа «всё готово».

**Императив (CLAUDE.md → Definition of Done):** на любой задаче, где менялся код или конфигурация, скилл **обязан** быть запущен перед финальным ответом. Без него `STATS_ROW` не пишется, `INDEX_ROW` не дописывается — следующая сессия не найдёт решение, `## Deferred Work` не сверяется. Вопрос-ответ и read-only анализ — без gate. Аудит 2026-05-27 (ещё под именем end-session): запускался в 14% подходящих сессий — имя «конец сессии» мешало запускам mid-session, отсюда переименование. Запуск ~10 сек, цена пропуска — недели потерянной памяти.

## Когда скилл активируется

**Триггеры:** задача завершена — «готово», «фича готова», «фикс готов», «финализируй»; конец сессии — «заканчиваем», «end session», «можно закрывать?», «wrap up»; главный агент считает задачу завершённой; после последней правки + валидации. **Не активируется:** посреди отладки/рефакторинга/открытых TODO; пользователь сказал «продолжим завтра» без просьбы зачехлить.

## Re-entrancy — несколько прогонов за сессию

Каждый прогон gate скоупится **диффом текущей задачи**, не всей сессии. Состояние между прогонами — файл `task-gate-state.json` в session-scratchpad (директория из системного промпта):

```json
{ "lastGateSha": "<HEAD на момент прошлого пройденного gate>",
  "onceChecks": { "hookSetup": true, "activeHygiene": true } }
```

**BASE_SHA** для diff-скоупа (2.2 impact, 2.8 TODO-scan, 2.9 L1, `Шагов: N` для doc-writer) — первый доступный: (1) `lastGateSha` из state-файла; (2) START_SHA начала сессии, если известен; (3) нет ни того ни другого → рабочее дерево без `--base`.

**После пройденного gate** (вердикт READY / READY WITH WARNINGS, включая auto-commit): записать `lastGateSha = HEAD` в state-файл. **Once-per-session проверки** (помечены `[once]` ниже) — на повторном прогоне скипаются со статусом `✅ once (done earlier)`: hook setup (2.9), active hygiene (2.4).

## Workflow

5 шагов **последовательно**, статус (`✅`/`⚠️`/`❌`) после каждой проверки, финальный отчёт в конце: Step 1 — Task Snapshot; Step 2 — Definition of Done Checks (11 пунктов gate); Step 3 — Sub-agent Sanity Check; Step 4 — Recommendations Pull; Step 5 — Final Report.

---

## Step 1 — Task Snapshot

Собрать: BASE_SHA (см. Re-entrancy) и изменённые файлы задачи (`git status` + `git diff --stat <BASE_SHA>`); вызванные специалисты; путь к активному документу в `docs/active/` (может отсутствовать — документ создаётся не на каждую задачу).

Печатать `📋 Task snapshot:` + строки `Base`, `Files changed`, `Agents used`, `Active doc`. Повторный прогон за сессию → добавить строку `Gate run: #N in session`.

---

## Step 2 — Definition of Done Checks

9 пунктов CLAUDE.md → «Definition of Done» + п. 2.3b (diff review двумя осями) + п. 2.9 (bug-pattern review). Прогоняй по порядку, статус одной строкой.

### 2.1 Validation

Сборка/тесты прошли. Не была сборка → `⚠️ unverified` + рекомендация запустить. Тесты — аналогично.

### 2.2 Impact Scan

Все зависимости обновлены: импорты, использования, тесты. Проверять через `ast-index` по именам ключевых сущностей, изменённых **в этой задаче** (дифф от BASE_SHA): `ast-index changed --base <BASE_SHA>` даёт список изменённых символов, дальше `usages` / `refs` / `implementations` по каждому. `Grep` — fallback на regex, строковые литералы и файлы вне индекса; `rebuild`/`update` не запускать. Правка в одном файле без новых или переименованных символов — отметить, что сканировать нечего.

### 2.3 Self-check vs FAILURE

Результат соответствует FAILURE-критериям Prompt Contract (архитектура, хардкод, error handling). Контракт не озвучивался → `⚠️ no Prompt Contract` + попросить подтвердить.

### 2.3b Diff review свежим агентом (Standards + Spec)

Инвариант CLAUDE.md → «Роль главного агента»: перед «готово» дифф ревьюит **свежий субагент** — он видит только дифф и критерий, не видит рассуждений, которые к нему привели. Метод — две независимые оси (скилл `code-review`):

- **Standards** — соответствует ли код документированным правилам проекта + smell baseline (12 смелов Фаулера).
- **Spec** — реализует ли дифф то, о чём просили (активный документ задачи / Prompt Contract): пропущенные требования, scope creep, неверно понятые требования.

**Когда запускать:** дифф от BASE_SHA непуст и трогает код или конфигурацию. Правка только в `docs/`, только в `~/.claude/*.md`, либо `/code-review` уже прогонялся по этой задаче → `✅ N/A` / `✅ verified by /code-review`.

**Как:** fail fast (`git rev-parse <BASE_SHA>`, непустой `git diff --stat <BASE_SHA>...HEAD`) → два вызова `Agent(subagent_type="general-purpose")` **одним сообщением**, параллельно. Отчёты печатать **раздельно**, не сливая и не переранжируя между осями.

Полные промпты, smell baseline, порядок поиска Spec-источника, правила «проект перекрывает baseline» и «пропускать то, что ловит линтер» → [`references/diff-review-axes.md`](references/diff-review-axes.md).

Статус: `✅ clean (2 axes)` / `⚠️ N standards + M spec findings` / `❌ spec: требование не реализовано` (блокер — задача не делает того, о чём просили). Standards-находки уровня суждения gate не блокируют; их место — в отчёт.

### 2.4 `@doc-writer` COMPLETE

Запущен ли COMPLETE и **получен ли результат**?

**Критерий обязательности** (`~/.claude/CLAUDE.md` → «Документирование»). Документ обязателен, если задача набрала **хотя бы один** признак — проверяются по факту диффа и хода работы, не по предварительной оценке:

- понадобилось 2+ итерации либо начальный план оказался неверен;
- тронуто 5+ файлов, появился новый модуль или выполнена миграция;
- recurring bug либо исправление, влияющее на всё приложение (перф, архитектура, security);
- инфраструктурный фикс с нетривиальной причиной (CSP, конфиг Firebase, DI, регионы, сериализация);
- пользователь попросил задокументировать.

Ни одного признака → `✅ skipped (rule)`.

**Запустить** при необходимости: `Agent(subagent_type="doc-writer", run_in_background=true)`. **В prompt передать:** GOAL; путь к активному документу; путь к project memory; hard scope guard; **`Шагов: N`** (правила подсчёта — `references/calibration.md` → «Источник `iterations`»; считать шаги **этой задачи**, от BASE_SHA, не всей сессии); готовый `git diff --name-only <BASE_SHA>..HEAD -- ':(exclude)docs/*'`; 3–5 строк key-findings; **инструкцию финальной архивации (Шаг 7):** «после сбора метрик перемести активный документ в `docs/archive/` и верни `ARCHIVED:` путь» — только при статусе `Done` (Partially Done / Deferred → остаётся в `docs/active/`). Скилл оценивает `N` по transcript: code-edit + build/test + делегации, исключая `/commit`, `/task-gate`, `@knowledge-scout`, `@doc-writer` фазы, todo updates, чтение файлов. Не нужен → `✅ skipped (rule)`.

**Why `Шагов: N`:** без поля counter падает на fallback `grep -c "### Итерация "`, а он измеряет частоту делегирования, а не реальный объём работы. Аудит 2026-05-11 показал занижение до −90% на коротких задачах.

**Active hygiene `[once]` (анти-свалка `docs/active/`).** Раз за сессию, на первом прогоне gate. Быстрый scan: (а) файлы со `**Статус:** Done` в шапке, всё ещё лежащие в `docs/active/` → доархивируй `mv docs/active/<f> docs/archive/<f>`; (б) файлы с `In Progress` в шапке, но заполненными `## Выводы` / `Done` в теле → выровняй шапку на `**Статус:** Done` и перенеси в `docs/archive/`. Ловит COMPLETE прошлых сессий, не довёдшие Шаг 7. Документ остаётся в `docs/active/` только при `In Progress` / `Partially Done` / `Deferred` / `Planned`. Прецедент 2026-06-11: 149 готовых задач застряли в `docs/active/` (154 файла), дайджест показывал ложный фронт работ.

### 2.5 INIT phase warning

Был ли `@doc-writer INIT` запущен в начале задачи (если задача подпадала под триггер)? Триггер был, INIT нет → `⚠️ INIT skipped` + точная строка в финальный отчёт: `⚠️ INIT фаза doc-writer пропущена — активный документ не создавался, compound effect на этой задаче может быть неточным`. Триггер не подпадал → `✅ N/A`.

### 2.6 Stats update (`STATS_ROW`)

После COMPLETE извлечь `STATS_ROW: ...` и дописать в **конец** `## Session Log` файла `~/.claude/stats/doc-writer.md`. Обновить `_Last updated:_`. Несколько задач за сессию → несколько строк, по одной на прогон gate — это корректно.

Колонок `complexity` и `impact` в строке больше нет (классификация задач упразднена 2026-08-03) — остаются измеримые по факту: `iterations`, `solutions_read`, `memory_hits`, `errors_avoided`, `files_edited`. Baseline-калибровка по перцентилю сложности отключена вместе с осями; старые строки в файле остаются как есть, их не переписывать.

Суффикс `(approximate)` → counter использовал fallback (главный забыл `Шагов: N`) — записи помечать. `STATS_ROW:` отсутствует → `⚠️ STATS_ROW missing`, попросить подтвердить.

### 2.7 Solutions INDEX update (`INDEX_ROW`)

Если COMPLETE написал постоянный документ (`docs/solutions/...` или `docs/decisions/...`), он возвращает префикс `INDEX_ROW:` со строкой.

Действие: извлечь `INDEX_ROW: ...`; открыть `docs/solutions/INDEX.md` (нет — создать с шапкой: заголовок `# Solutions INDEX`, `_Last updated:_`, таблица `| Дата | Задача | Документ | Кратко |`); дописать строку **наверх** таблицы (после `|---|---|---|---|`); обновить `_Last updated:_`.

`INDEX_ROW:` нет → постоянный документ не создавался, `✅ N/A`.

### 2.7b Документация уезжает вместе с кодом (`DOCS_WRITTEN`)

Документы, написанные субагентами, обязаны попасть в тот же коммит и merge request, что и код задачи. Субагенты git не трогают — стейджит и коммитит главный, поэтому без явной проверки документ остаётся в рабочем дереве и расходится с веткой.

**Действие:**

1. Собрать пути из строк `DOCS_WRITTEN:` всех вызовов `@doc-writer` за эту задачу (фазы INIT / UPDATE / COMPLETE — у каждой своя строка). Плюс `ARCHIVED:` — путь после переезда в `docs/archive/`, старого пути в `docs/active/` в дереве уже нет.
2. Для каждого пути: `git status --porcelain -- <path>`. Пусто и файл существует → уже в коммите или не изменён. Непусто → файл не в индексе, к коммиту его добавляет Step 5.
3. **Файл не существует ни на диске, ни в git** → `❌` и не закрывать gate: `@doc-writer` отрапортовал о записи, которой не было. Класс известный (прецедент 2026-07-14), поэтому это блокер, а не warning.
4. **`docs/` под gitignore** (проверка: `git check-ignore -q docs` — код 0) → `⚠️ docs/ gitignored — документация физически не может уехать в MR`. Не блокер: в части проектов так и задумано. Строкой в финальный отчёт, чтобы расхождение было видно.

**Фоновый `@doc-writer` может закончить после коммита.** COMPLETE запускается с `run_in_background: true`, и Step 5 способен закоммитить раньше, чем придёт `DOCS_WRITTEN`. Поэтому: результат COMPLETE **дождаться до** Step 5. Уже закоммитили, а файлы пришли позже → `git add` этих файлов и `--amend` последнего коммита, если он ещё не запушен; запушен — отдельный коммит `docs: <slug>` в ту же ветку. Молча оставить документ вне MR нельзя.

`@doc-writer` не вызывался за задачу → `✅ N/A`.

### 2.8 Deferred-work integrity (TODO / FIXME / docs/todos/)

Проверить, что в коде нет «потерянных» TODO/FIXME, отложенный функционал имеет `docs/todos/<...>.md`. Источник — `~/.claude/CLAUDE.md` → «Отложенный функционал».

Кратко:
1. `git diff -U0 <BASE_SHA>` (нет BASE_SHA → `HEAD`) по code-расширениям → grep `\b(TODO|FIXME|STOPSHIP):` в `^+` строках (test-файлы исключены).
2. Категории: 0 совпадений → `✅ no unbacked TODO`; с `// Pending: docs/todos/<file>` anchor + файл существует → `✅ TODO anchors valid`; без anchor или файл отсутствует → `⚠️ unbacked TODO` / `⚠️ broken Pending anchor`.
3. Unbacked TODO — gate не блокируется (warning), но 5.1.1 Auto-commit **не запускать** до `AskUserQuestion` (Create docs/todos / Delete TODO / Override / Defer).
4. `docs/todos/INDEX.md` есть → проверить `## Open` ссылки + memory desync.
5. `/commit` уже был в рамках этой задачи со своим scan → `✅ verified by /commit at <sha>`.

Полные Bash-команды, exclude-паттерны, шаблон `docs/todos/<...>.md`, опции `AskUserQuestion` → `references/deferred-work-scan.md`.

### 2.9 Bug-pattern review (L1 static + L2 reviewer + L3 process gate)

Сверка diff с реестром повторяющихся багов `~/.claude/review-rules/` — система против «тех же багов каждую сессию» (system bar не покрашен, анимация, отступы, регион деплоя, субагент выпилил фичу). Источник — `~/.claude/review-rules/README.md`.

- **L1 (всегда, дёшево, без LLM):** Stop-хук уже прогнал L1 по ходу сессии и залогировал. Здесь — полный прогон по задаче: `python ~/.claude/review-rules/run.py --base <BASE_SHA> --changed-only --log ~/.claude/stats/review-rules-events.jsonl --entry endsession` (нет BASE_SHA → без `--base` = рабочее дерево). Лейбл `--entry endsession` — **исторический, не менять**: на нём агрегация `stats.py` и вся история `events.jsonl`. `static` HIGH → **❌ blocker** (как pre-commit): выровнять до закрытия gate, auto-commit 5.1.1 **не запускать**. `runtime` WARN → в отчёт.
- **L2 (триггер — L1 дал находки):** вывод L1 непуст → `Agent(subagent_type="bug-pattern-reviewer", run_in_background=false)` с base ref в брифе. Триггер именно факт находок L1, не список областей (новое правило подхватывается само). Возвращает BLOCKERS / RUNTIME RED-FLAGS (confidence) / PROCESS GATE ARMED / NEW_RULE_CANDIDATE / `LOG_ROW:`. L1 чист → L2 пропустить (`✅ skipped (L1 clean)`). Агент сам пишет своё L2-событие в лог.
- **L3 process-gate (всегда, дёшево):** пройти armed process-вопросы (из L2 либо прочитать `process-gate.yaml` сам): молча ли удалена user-facing функция? тронут деплой → регион/аккаунт/smoke сверены? субагент в scope, не коммитил? баг невоспроизведён, а патчишь? Любой неотвеченный armed-вопрос severity high → `⚠️` в отчёт (боль #5 — не отгружать молчком; при потере функции — `AskUserQuestion` ДО завершения).
- **Компаундинг (опц.):** L2 вернул NEW_RULE_CANDIDATE для recurring-бага без правила → допиши строку в нужный area-файл (README → «Компаундинг»). Не блокирует.
- **Rollup (всегда, дёшево):** в конце пункта — `python ~/.claude/review-rules/stats.py` (читает `events.jsonl` + git-корреляцию → обновляет `~/.claude/stats/review-rules.md`: Counters / Per-rule / Выводы). Это база для будущей оценки полезности системы — не «на глаз».
- **Hook setup `[once]` (self-config):** раз за сессию, на первом прогоне gate: `python ~/.claude/review-rules/run.py --check-hook`. SessionStart обычно уже поставил pre-commit автоматически; `NOT installed` → подсветить `⚠️` + строку `--ensure-hook`; `foreign` (чужой pre-commit) → подсветить + дать строку для ручной вставки (auto не клобберит чужой hook).

Статус: `✅ clean` / `❌ N static HIGH` / `⚠️ N runtime + M process armed` / `⚠️ pre-commit not set`.

### 2.10 Improvements log

Задача меняла `~/.claude/CLAUDE.md`, `~/.claude/agents/*`, `~/.claude/skills/*` или `~/.claude/settings.json` → должен существовать `~/.claude/improvements/<YYYY-MM-DD>-<slug>.md` + строка в index-таблице `improvements/README.md`. Нет → `⚠️ improvement log missing` (не блокер, но в отчёт). Правила и шаблон — `~/.claude/CLAUDE.md` → «Изменения глобальных правил» + `improvements/README.md`. Ничего из перечисленного не менялось → `✅ N/A`.

---

## Step 3 — Sub-agent Sanity Check

Поверхностная проверка результатов специалистов **этой задачи** (2-3 сигнала; не код-ревью):

- **`@compose-feature-expert`** — Compose/ViewModel/UiState/Navigation созданы, нет TODO, импорты корректны; Material 3 токены (нет `Color(0xFF...)`), design-system обёртки.
- **`@android-platform-expert`** — androidMain: Hilt/Room driver/Media3/Resources; нет утечки в commonMain; installDebug smoke на новых DI-биндингах через интерфейс.
- **`@kmp-expert`** — `commonMain` без Android-импортов, `expect`/`actual` спарены, без заглушек Route/Screen.
- **`@react-ui-expert`** — компонент создан, type-check, Tailwind вместо inline.
- **`@nextjs-expert`** — API route корректный тип + авторизация.
- **`@design-expert`** — отдал `DESIGN_SPEC` (описание дизайна, не прод-код); платформа + метод (native/claude-design) проставлены.
- **`@kotlin-expert`** — Flow/runCatching/Duration, нет блокирующих вызовов в корутинах.
- **`@wasmjs-expert`** — `init.js`/`index.html`/wasmJs стабы синхронны, нет `js("...")` в commonMain.
- **`@doc-writer`** — активный документ есть, COMPLETE выдал `STATS_ROW`/`INDEX_ROW`.

Метод: `Grep` (`import android.` в `commonMain`); `Glob` для файлов; чтение первых 30 строк. Флаг → `⚠️`, не блокируем. Печатать блок `🤖 Sub-agent sanity:` со строками `<agent> <status>`.

---

## Step 4 — Recommendations Pull

`@doc-writer COMPLETE` может включать секцию рекомендаций для специалистов (compound effect). **Не интерактив** (изменение 2026-05-27): не спрашивать `apply/defer/skip` — всё идёт в queue-файл, решение на еженедельном review.

**Критические инварианты (соблюдать всегда):**
- **Писать ВСЕ рекомендации** в `~/.claude/recommendations/<YYYY-MM-DD>-<task-slug>.md` (`status: pending-review`) — даже LOW. Slug — по **задаче**, не по сессии; вторая задача той же сессии → свой файл. Фильтр **классифицирует** (🟢 HIGH / 🟡 MEDIUM / 🔴 LOW), НЕ удаляет.
- **Рекомендаций ноль** → НЕ создавать пустой файл; строка `✅ no recommendations from @doc-writer this task`. **doc-writer не вызывался** → `✅ N/A (no doc-writer for this task)`.
- **Reject только** при ❌ всех 4 тестах + red flag (out-of-scope Anthropic-plugins / self-loop) → `⊘ X recs rejected`.
- **Inline-вывод** — короткий summary (не полный текст recs):

```
💡 Recommendations queued (N items):
   🟢 HIGH:    <H> recs
   🟡 MEDIUM:  <M> recs
   🔴 LOW:     <L> recs

   📁 Saved to: ~/.claude/recommendations/<YYYY-MM-DD>-<slug>.md
   📋 Review:   запроси «рассмотрим рекомендации» когда будешь готов
```
LOW ≥ 50% от total → добавить warning про ритуальные рекомендации doc-writer.

Детальная механика (извлечение 4.2, 4-тестовая классификация + red flags 4.3, task-slug + frontmatter + шаблон записи 4.4) — [`references/recommendations-pull.md`](references/recommendations-pull.md).

---

## Step 5 — Commit & Final Report

### 5.1 Commit Verification

`git status --porcelain` непустой → проверить, был ли `/commit` в рамках задачи. Был + новые правки или не был → 5.1.1 (auto-commit при выполнении условий), иначе предложить запустить `/commit`. Чисто + коммит был → `✅ commit ok`. Чисто + не было → `✅ no changes to commit`.

**Никогда** не вызывать `git commit` через Bash — только `/commit`.

### 5.1.1 Auto-commit (когда коммит — единственный блокер)

Скилл вызывает `/commit` автоматически, **если все 5 условий:** (1) gate без ❌; (2) `git status --porcelain` непустой; (3) пользователь не запрещал коммит; (4) нет подозрительных файлов в diff (`.env*`/`*.key`/`*.pem`/`id_rsa*`/`*credentials*`/`*secret*`, бинарники > 1 МБ, файлы вне scope); (5) 2.8 без unbacked TODO.

Выполнены → `Skill(skill="commit")`, перепроверить `git status`. Чисто → `✅ commit auto-created`, SHA в отчёт. Не чисто → `❌ auto-commit failed`, stderr в отчёт, передать пользователю.

**НЕ запускается:** ❌ блокер; явный отказ; подозрительные файлы (→ `AskUserQuestion`); промежуточное состояние (Partially Done, diagnostic-логи, mixed-scope diff). Полный список guard-условий, шаблоны, обработка pre-commit hook → `references/auto-commit-rules.md`.

### 5.2 Final Report

Табличка `TASK GATE` со всеми пунктами 2.1–2.10 (включая 2.3b) + 3 + 4 + 5.1 + статусами, завершить `VERDICT: <READY|READY WITH WARNINGS|NOT READY>`. После — обязательно секция Recommendations (5.2.1).

Маркеры: `4 Recommendations` → `✅ N queued (H/M/L)`. `5.1 Commit`: `✅` / `✅ auto` (SHA в ответ) / `⚠️ deferred` / `❌ uncommitted`.

Вердикт: **✅ READY**; **⚠️ READY WITH WARNINGS** (некритичные, упомянуть); **❌ NOT READY** (блокеры: uncommitted, обязательный COMPLETE не запущен, провален impact scan; не отвечать «готово»). Печатается **до** финального сообщения. Блокеры → главный возвращается в работу.

**READY / READY WITH WARNINGS →** обновить `task-gate-state.json` в scratchpad: `lastGateSha = HEAD`, once-флаги выполненных `[once]`-проверок (см. Re-entrancy).

#### 5.2.1 Recommendations summary (ОБЯЗАТЕЛЬНЫЙ блок)

Сразу после таблицы вердикта — summary очереди рекомендаций. **ВСЕГДА** — даже при нулевом списке (`✅ no recommendations from @doc-writer this task`). Шаблон inline-вывода — 4.4. Длинный текст НЕ дублируется (он в файле). Блок отсутствует → gate **не прошёл**.

---

## Output Style

Печатать промежуточные статусы (`✅`/`⚠️`/`❌`), не молчать на 5 шагов сразу. Не дублировать CLAUDE.md — только результаты и точные действия. Русский язык. **ОБЯЗАТЕЛЬНО** в финальном ответе блок `💡 Recommendations summary` (5.2.1) даже при нулевом списке — без него gate не прошёл.

## Что скилл НЕ делает

Не делает **глубокое** код-ревью (`/review`/`compound-engineering:ce-review`) — 2.3b это две узкие оси на диффе задачи, не полный аудит; не делает security-аудит (`/security-review`); не вызывает `git commit` через Bash (только `/commit` или auto через 5.1.1); не пишет документацию (проверяет `@doc-writer`); не оптимизирует субагентов (записывает рекомендации в queue, Step 4).

## Edge cases

Нестандартные ситуации (не git-репо, сессия без задачи, недописанная задача, упавший doc-writer, потерянный state-файл, фоновый task, malformed STATS_ROW, out-of-scope recommendations, auto-commit упал на pre-commit hook) → `references/edge-cases.md`.

## Связанные скиллы и файлы

- `/commit` — единственно допустимый способ создавать коммиты.
- `~/.claude/CLAUDE.md` — источник истины Definition of Done.
- `~/.claude/stats/doc-writer.md` — глобальная статистика (`STATS_ROW`).
- `docs/solutions/INDEX.md` — per-project индекс (`INDEX_ROW`).
- `@doc-writer` — субагент INIT/UPDATE/COMPLETE.
- `code-review` — скилл-источник метода двух осей (2.3b); отдельно от gate применим к произвольной базовой точке.
- `references/` — calibration, deferred-work-scan, auto-commit-rules, edge-cases, diff-review-axes.
