---
name: end-session
description: Финальная проверка перед завершением сессии Claude Code. Прогоняет полный Definition of Done gate из глобального CLAUDE.md (документация, коммит, поверхностная проверка субагентов), извлекает рекомендации от @doc-writer и предлагает применить их. Если единственный оставшийся блокер — несделанный коммит, а все остальные пункты зелёные или warning, скилл сам вызывает /commit и закрывает gate без участия пользователя. Используй когда пользователь говорит "заканчиваем", "завершаем сессию", "end session", "финализируй", "готово", "готово?", "можно закрывать?", "проверь всё перед завершением", "сессия закрыта", "wrap up", "финал", или когда главный агент сам считает что задача выполнена и пора подводить итоги. Запускай этот скилл ДО того, как сообщить пользователю об окончательной готовности — gate без скилла не считается пройденным.
---

# End Session — Definition of Done Gate

Скилл-чеклист, проверяет, что текущую сессию можно безопасно завершить. Источник правил — Definition of Done в глобальном `~/.claude/CLAUDE.md`.

## Зачем это нужно

После сложной сессии легко забыть обязательный пункт: `@doc-writer COMPLETE`, обновить `~/.claude/stats/doc-writer.md`, дописать `INDEX_ROW` в `docs/solutions/INDEX.md`, сделать коммит через `/commit`. Каждый пропуск ломает compound effect. Запускай **до** финального ответа «всё готово».

**Императив для Standard+ задач (CLAUDE.md → Definition of Done):** на любой Standard/Complex задаче скилл **обязан** быть запущен. Без него `STATS_ROW` не пишется → калибровка ломается; `INDEX_ROW` не дописывается → следующая сессия не найдёт решение; `## Deferred Work` не сверяется. Аудит 2026-05-27: запускался в **14% Standard+ сессий**. Запуск ~10 сек, цена пропуска — недели потерянной памяти.

## Когда скилл активируется

**Триггеры:** «заканчиваем», «end session», «готово?», «можно закрывать?», «финализируй», «wrap up»; главный агент считает задачу завершённой; после последней правки + валидации. **Не активируется:** посреди отладки/рефакторинга/открытых TODO; пользователь сказал «продолжим завтра» без просьбы зачехлить.

## Workflow

5 шагов **последовательно**, статус (`✅`/`⚠️`/`❌`) после каждой проверки, финальный отчёт в конце: Step 1 — Session Snapshot; Step 2 — Definition of Done Checks (10 пунктов gate); Step 3 — Sub-agent Sanity Check; Step 4 — Recommendations Pull; Step 5 — Final Report.

---

## Step 1 — Session Snapshot

Собрать: изменённые файлы (`git status` + `git diff --stat`); вызванные специалисты; Complexity/Impact из Prompt Contract (не помнишь → переоценка); путь к активному документу в `docs/active/` (Trivial/Low — может отсутствовать).

Печатать `📋 Session snapshot:` + строки `Files changed`, `Agents used`, `Complexity`, `Impact`, `Active doc`.

---

## Step 2 — Definition of Done Checks

9 пунктов CLAUDE.md → «Definition of Done» + п. 2.9 (bug-pattern review). Прогоняй по порядку, статус одной строкой.

### 2.1 Validation

Сборка/тесты прошли. Не была сборка → `⚠️ unverified` + рекомендация запустить. Тесты — аналогично.

### 2.2 Impact Scan

Все зависимости обновлены: импорты, использования, тесты. `Grep` по именам ключевых изменённых сущностей. Trivial — отметка о scan по правилу из памяти.

### 2.3 Self-check vs FAILURE

Результат соответствует FAILURE-критериям Prompt Contract (архитектура, хардкод, error handling). Контракт не озвучивался → `⚠️ no Prompt Contract` + попросить подтвердить.

### 2.4 `@doc-writer` COMPLETE

Запущен ли COMPLETE и **получен ли результат**?

**Матрица обязательности** (CLAUDE.md → «Когда звать doc-writer»): Complex × любой / Standard × Medium-High / Trivial × Medium-High → **обязательно**; Trivial × Low → нет, **кроме спец-условий** (2+ итерации, 5+ файлов, новый модуль, миграция, recurring bug, performance fix, нетривиальный инфраструктурный фикс).

**Запустить** при необходимости: `Agent(subagent_type="doc-writer", run_in_background=true)`. **В prompt передать:** GOAL; путь к активному документу; путь к project memory; hard scope guard; **`Шагов: N`** (правила — CLAUDE.md → «Подсчёт реальных шагов задачи»); готовый `git diff --name-only <START_SHA>..HEAD -- ':(exclude)docs/*'`; 3–5 строк key-findings; **инструкцию финальной архивации (Шаг 7):** «после сбора метрик перемести активный документ в `docs/completed/` и верни `ARCHIVED:` путь» — только при статусе `Done` (Partially Done / Deferred → остаётся в `docs/active/`). Скилл оценивает `N` по transcript: code-edit + build/test + делегации, исключая `/commit`, `/end-session`, `@knowledge-scout`, `@doc-writer` фазы, todo updates, чтение файлов. Не нужен → `✅ skipped (rule)`.

**Why `Шагов: N`:** без поля counter падает на fallback `grep -c "### Итерация "` (частота делегирования, не сложность). Аудит 2026-05-11 → Trivial compound effect = −90%.

**Active hygiene (анти-свалка `docs/active/`).** Быстрый scan перед закрытием gate: (а) файлы со `**Статус:** Done` в шапке, всё ещё лежащие в `docs/active/` → доархивируй `mv docs/active/<f> docs/completed/<f>`; (б) файлы с `In Progress` в шапке, но заполненными `## Выводы` / `Done` в теле → выровняй шапку на `**Статус:** Done` и перенеси в `docs/completed/`. Ловит COMPLETE прошлых сессий, не довёдшие Шаг 7. Документ остаётся в `docs/active/` только при `In Progress` / `Partially Done` / `Deferred` / `Planned`. Прецедент 2026-06-11: 149 готовых задач застряли в `docs/active/` (154 файла), дайджест показывал ложный фронт работ.

### 2.5 INIT phase warning

Был ли `@doc-writer INIT` запущен в начале сессии (если задача подпадала под триггер)? Триггер был, INIT нет → `⚠️ INIT skipped` + точная строка в финальный отчёт: `⚠️ INIT фаза doc-writer пропущена — активный документ не создавался, compound effect на этой задаче может быть неточным`. Триггер не подпадал → `✅ N/A`.

### 2.6 Stats update (`STATS_ROW`)

После COMPLETE извлечь `STATS_ROW: ...` и дописать в **конец** `## Session Log` файла `~/.claude/stats/doc-writer.md`. Обновить `_Last updated:_`.

**Baseline calibration** срабатывает при ≥ 50 задач всего ИЛИ ≥ 20 в одном complexity (по записям **без** `(approximate)`). Новый baseline = p75 iterations. Полный алгоритм → `references/calibration.md`.

Суффикс `(approximate)` → counter использовал fallback (главный забыл `Шагов: N`) — записи помечать и **не учитывать в калибровке**. `STATS_ROW:` отсутствует → `⚠️ STATS_ROW missing`, попросить подтвердить.

### 2.7 Solutions INDEX update (`INDEX_ROW`)

Если COMPLETE написал постоянный документ (`docs/solutions/...` или `docs/decisions/...`), он возвращает префикс `INDEX_ROW:` со строкой.

Действие: извлечь `INDEX_ROW: ...`; открыть `docs/solutions/INDEX.md` (создать с шапкой если нет — формат в CLAUDE.md пункт 7 gate); дописать строку **наверх** таблицы (после `|---|---|---|---|`); обновить `_Last updated:_`.

`INDEX_ROW:` нет → постоянный документ не создавался, `✅ N/A`.

### 2.8 Deferred-work integrity (TODO / FIXME / docs/todos/)

Проверить, что в коде нет «потерянных» TODO/FIXME, отложенный функционал имеет `docs/todos/<...>.md`. Источник — `~/.claude/CLAUDE.md` → «Отложенный функционал».

Кратко:
1. `git diff -U0 HEAD` по code-расширениям → grep `\b(TODO|FIXME|STOPSHIP):` в `^+` строках (test-файлы исключены).
2. Категории: 0 совпадений → `✅ no unbacked TODO`; с `// Pending: docs/todos/<file>` anchor + файл существует → `✅ TODO anchors valid`; без anchor или файл отсутствует → `⚠️ unbacked TODO` / `⚠️ broken Pending anchor`.
3. Unbacked TODO — gate не блокируется (warning), но 5.1.1 Auto-commit **не запускать** до `AskUserQuestion` (Create docs/todos / Delete TODO / Override / Defer).
4. `docs/todos/INDEX.md` есть → проверить `## Open` ссылки + memory desync.
5. `/commit` уже был в сессии со своим scan → `✅ verified by /commit at <sha>`.

Полные Bash-команды, exclude-патcerns, шаблон `docs/todos/<...>.md`, опции `AskUserQuestion` → `references/deferred-work-scan.md`.

### 2.9 Bug-pattern review (L1 static + L2 reviewer + L3 process gate)

Сверка diff с реестром повторяющихся багов `~/.claude/review-rules/` — система против «тех же багов каждую сессию» (system bar не покрашен, анимация, отступы, регион деплоя, субагент выпилил фичу). Источник — `~/.claude/review-rules/README.md`.

- **L1 (всегда, дёшево, без LLM):** Stop-хук уже прогнал L1 по ходу сессии и залогировал. Здесь — полный прогон по ветке: `python ~/.claude/review-rules/run.py --base <START_SHA> --changed-only --log ~/.claude/stats/review-rules-events.jsonl --entry endsession` (нет START_SHA → без `--base` = рабочее дерево). `static` HIGH → **❌ blocker** (как pre-commit): выровнять до закрытия gate, auto-commit 5.1.1 **не запускать**. `runtime` WARN → в отчёт.
- **L2 (триггер — L1 дал находки):** вывод L1 непуст → `Agent(subagent_type="bug-pattern-reviewer", run_in_background=false)` с base ref в брифе. Триггер именно факт находок L1, не список областей (новое правило подхватывается само). Возвращает BLOCKERS / RUNTIME RED-FLAGS (confidence) / PROCESS GATE ARMED / NEW_RULE_CANDIDATE / `LOG_ROW:`. L1 чист → L2 пропустить (`✅ skipped (L1 clean)`). Агент сам пишет своё L2-событие в лог.
- **L3 process-gate (всегда, дёшево):** пройти armed process-вопросы (из L2 либо прочитать `process-gate.yaml` сам): молча ли удалена user-facing функция? тронут деплой → регион/аккаунт/smoke сверены? субагент в scope, не коммитил? баг невоспроизведён, а патчишь? Любой неотвеченный armed-вопрос severity high → `⚠️` в отчёт (боль #5 — не отгружать молчком; при потере функции — `AskUserQuestion` ДО завершения).
- **Компаундинг (опц.):** L2 вернул NEW_RULE_CANDIDATE для recurring-бага без правила → допиши строку в нужный area-файл (README → «Компаундинг»). Не блокирует.
- **Rollup (всегда, дёшево):** в конце пункта — `python ~/.claude/review-rules/stats.py` (читает `events.jsonl` + git-корреляцию → обновляет `~/.claude/stats/review-rules.md`: Counters / Per-rule / Выводы). Это база для будущей оценки полезности системы — не «на глаз».
- **Hook setup (self-config):** `python ~/.claude/review-rules/run.py --check-hook`. SessionStart обычно уже поставил pre-commit автоматически; `NOT installed` → подсветить `⚠️` + строку `--ensure-hook`; `foreign` (чужой pre-commit) → подсветить + дать строку для ручной вставки (auto не клобберит чужой hook).

Статус: `✅ clean` / `❌ N static HIGH` / `⚠️ N runtime + M process armed` / `⚠️ pre-commit not set`.

---

## Step 3 — Sub-agent Sanity Check

Поверхностная проверка результатов специалистов (2-3 сигнала; не код-ревью):

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
- **Писать ВСЕ рекомендации** в `~/.claude/recommendations/<YYYY-MM-DD>-<session-slug>.md` (`status: pending-review`) — даже LOW. Фильтр **классифицирует** (🟢 HIGH / 🟡 MEDIUM / 🔴 LOW), НЕ удаляет.
- **Рекомендаций ноль** → НЕ создавать пустой файл; строка `✅ no recommendations from @doc-writer this session`. **doc-writer не вызывался** → `✅ N/A (no doc-writer in session)`.
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

Детальная механика (извлечение 4.2, 4-тестовая классификация + red flags 4.3, session-slug + frontmatter + шаблон записи 4.4) — [`references/recommendations-pull.md`](references/recommendations-pull.md).

---

## Step 5 — Commit & Final Report

### 5.1 Commit Verification

`git status --porcelain` непустой → проверить, был ли `/commit` в сессии. Был + новые правки или не был → 5.1.1 (auto-commit при выполнении условий), иначе предложить запустить `/commit`. Чисто + коммит был → `✅ commit ok`. Чисто + не было → `✅ no changes to commit`.

**Никогда** не вызывать `git commit` через Bash — только `/commit`.

### 5.1.1 Auto-commit (когда коммит — единственный блокер)

Скилл вызывает `/commit` автоматически, **если все 5 условий:** (1) gate без ❌; (2) `git status --porcelain` непустой; (3) пользователь не запрещал коммит; (4) нет подозрительных файлов в diff (`.env*`/`*.key`/`*.pem`/`id_rsa*`/`*credentials*`/`*secret*`, бинарники > 1 МБ, файлы вне scope); (5) 2.8 без unbacked TODO.

Выполнены → `Skill(skill="commit")`, перепроверить `git status`. Чисто → `✅ commit auto-created`, SHA в отчёт. Не чисто → `❌ auto-commit failed`, stderr в отчёт, передать пользователю.

**НЕ запускается:** ❌ блокер; явный отказ; подозрительные файлы (→ `AskUserQuestion`); промежуточное состояние (Partially Done, diagnostic-логи, mixed-scope diff). Полный список guard-условий, шаблоны, обработка pre-commit hook → `references/auto-commit-rules.md`.

### 5.2 Final Report

Табличка `END SESSION GATE` со всеми пунктами 2.1–2.9 + 3 + 4 + 5.1 + статусами, завершить `VERDICT: <READY|READY WITH WARNINGS|NOT READY>`. После — обязательно секция Recommendations (5.2.1).

Маркеры: `4 Recommendations` → `✅ N queued (H/M/L)`. `5.1 Commit`: `✅` / `✅ auto` (SHA в ответ) / `⚠️ deferred` / `❌ uncommitted`.

Вердикт: **✅ READY**; **⚠️ READY WITH WARNINGS** (некритичные, упомянуть); **❌ NOT READY** (блокеры: uncommitted, обязательный COMPLETE не запущен, провален impact scan; не отвечать «готово»). Печатается **до** финального сообщения. Блокеры → главный возвращается в работу.

#### 5.2.1 Recommendations summary (ОБЯЗАТЕЛЬНЫЙ блок)

Сразу после таблицы вердикта — summary очереди рекомендаций. **ВСЕГДА** — даже при нулевом списке (`✅ no recommendations from @doc-writer this session`). Шаблон inline-вывода — 4.4. Длинный текст НЕ дублируется (он в файле). Блок отсутствует → gate **не прошёл**.

---

## Output Style

Печатать промежуточные статусы (`✅`/`⚠️`/`❌`), не молчать на 5 шагов сразу. Не дублировать CLAUDE.md — только результаты и точные действия. Русский язык. **ОБЯЗАТЕЛЬНО** в финальном ответе блок `💡 Recommendations summary` (5.2.1) даже при нулевом списке — без него gate не прошёл.

## Что скилл НЕ делает

Не делает код-ревью (`/review`/`compound-engineering:ce-review`); security-аудит (`/security-review`); не вызывает `git commit` через Bash (только `/commit` или auto через 5.1.1); не пишет документацию (проверяет `@doc-writer`); не оптимизирует субагентов (записывает рекомендации в queue, Step 4).

## Edge cases

Нестандартные ситуации (не git-репо, сессия без задачи, недописанная задача, упавший doc-writer, несколько задач за сессию, фоновый task, malformed STATS_ROW, out-of-scope recommendations, auto-commit упал на pre-commit hook) → `references/edge-cases.md`.

## Связанные скиллы и файлы

- `/commit` — единственно допустимый способ создавать коммиты.
- `~/.claude/CLAUDE.md` — источник истины Definition of Done.
- `~/.claude/stats/doc-writer.md` — глобальная статистика (`STATS_ROW`).
- `docs/solutions/INDEX.md` — per-project индекс (`INDEX_ROW`).
- `@doc-writer` — субагент INIT/UPDATE/COMPLETE.
- `references/` — calibration, deferred-work-scan, auto-commit-rules, edge-cases.
