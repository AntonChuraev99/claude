---
name: task-gate
description: Гейт готовности задачи. Триггеры — «готово», «готово?», «задача готова», «фича готова», «фикс готов», «финализируй», «заканчиваем», «завершаем сессию», «можно закрывать?», wrap up, end session, или главный сам считает задачу сделанной. Запускать до сообщения о готовности, на каждую задачу с правками кода или конфигурации; без скилла gate не пройден. Режим lite (дефолт) или full: ревью диффа одним агентом, проверки Definition of Done, артефакт для проверки, авто-коммит. После подтверждения пользователя сам доводит до влитого MR — push, MR/PR, squash-merge, уборка worktree.
---

# Task Gate — Definition of Done

Проверяет, что задачу можно закрыть, и доводит её до влитого MR. Правила — Definition of Done в `~/.claude/CLAUDE.md`. Единица — **задача**: несколько прогонов за сессию — норма, каждый скоупится диффом с прошлого gate. Вопрос-ответ, read-only, середина отладки — без gate.

**Инварианты, режимом не снимаются:** одно ревью диффа на задачу (2.3b) · вёрстка проверяется картинкой (2.2b) · отложенное — в `docs/todos/` (2.8) · `static` HIGH — блокер (2.9) · артефакт для подтверждения (5.1b) · коммит только `/commit`, сам — когда он единственный блокер (5.1.1) · merge — после подтверждения пользователя, кроме docs-only (Step 6).

**Порядок:** Step 1 → 2.0 (ревью фоном) → 2.1–2.10 → Step 3 → Step 5 (отчёт) → ждать подтверждения → Step 6. Статус `✅`/`⚠️`/`❌` после каждой проверки. Скрипты — `~/.claude/skills/task-gate/scripts/`: ручные строки с `$(...)` и переменными worktree отклоняет.

---

## Step 1 — Task Snapshot

```bash
python ~/.claude/skills/task-gate/scripts/gate-prep.py --scratchpad <session-scratchpad>
```

`--start-sha <sha>` — START_SHA сессии, если известен; `--full "<причина>"` — триггер 1.1, которого скрипт не видит. JSON: `base` (BASE_SHA: `lastGateSha` → START_SHA → рабочее дерево; скоуп 2.2, 2.4, 2.8, L1), `task`, `mode`, `review` и `l1` (2.0), `todo` (2.8), `docs` (2.7b), `commit` (5.1), `merge` (5.1a, Step 6). State — `<scratchpad>/task-gate-state.json`: `lastGateSha`, `reviewedSha`, `onceChecks`, `artifactServer`; пишет `gate-log.py`.

Печатать `📋 Task snapshot:` — `Base`, `Files changed`, `Agents used`, `Active doc`, `Mode` + причины; повторный прогон — `Gate run: #N`.

### 1.1 Режим — `lite` (дефолт) или `full`

**`full`**, если хотя бы одно: 5+ изменённых файлов кода (без `docs/**`, `*.md`, тестов и `improvements/`) · новый модуль, миграция, новый публичный контракт (API, схема, событие аналитики) · тронут деплой, инфраструктура, конфигурация окружения · тронуты инструкции или исполняемые файлы `~/.claude` (`CLAUDE.md`, `agents`, `skills`, `rules`, `model-overlays`, `output-styles`, `commands`, `hooks`, `scripts`, `review-rules`, `settings.json`) · пользователь попросил. Файловые триггеры считает `gate-prep.py`, остальное — главный: `--full` при первом запуске; поднять режим после — `--mode full` в `gate-log.py`, `gate-prep.py` не перезапускать (второй прогон L1). «Последний прогон перед мержем» режим не поднимает.

**`full` добавляет** ([`references/full-mode.md`](references/full-mode.md), читать только в `full`): 2.6 строка статистики · Step 3 целиком · `[once]`-проверки · второй ревьюер 2.3b по порогу · строка `⏱`. В `lite` — `⏸ lite`, не переносится.

---

## Step 2 — Definition of Done Checks

### 2.0 Review fan-out — первым и фоном

Пакет диффа (`review.package`) и L1 (`l1.json`) уже готовы. **Все вызовы `Agent` — одним сообщением**, и сразу в 2.1:

1. Ревьюер 2.3b — `Agent(subagent_type="general-purpose")`, обе оси в одном брифе. `review.skip` не пуст → не спавнить, причина в 2.3b.
2. L2 — `Agent(subagent_type="bug-pattern-reviewer")`, при `l1.static > 0` или сбое L1 (`l1.error`): `base.sha`, `review.l2_package`, путь `l1.json`, строка «ничего не редактируй, не коммить, не запускай сборки и тесты; твой продукт — отчёт» (на tools во frontmatter не полагаться). Fail fast 2.3b его не отменяет.
3. Сторож `agent-watchdog.sh` — фоном сразу после.

Бриф (бюджет 25 вызовов, запрет записи, порог находки, convergence при `review.repeat`) и сторож — [`references/diff-review-flow.md`](references/diff-review-flow.md) § «Фан-аут (2.0)», **прочитать до спавна**. Статус: `✅ N agents dispatched` / `⚠️ not dispatched (<причина>)`.

### 2.1 Validation

Сборка и тесты прошли. Не запускались → `⚠️ unverified` + что запустить.

### 2.2 Impact Scan

`ast-index changed --base <base.sha>` → `usages`/`refs`/`implementations` по символам; `Grep` — для литералов и файлов вне индекса. Правка без новых символов → «сканировать нечего».

### 2.2b Скриншот-цикл (дифф трогал вёрстку)

Таблица: строка на экран или компонент, который задача изменила **или впервые сделала достижимым**, — путь к открытому кадру либо `не снят` + причина; соседний кадр чужую строку не закрывает. До таблицы — [`references/screenshot-gate.md`](references/screenshot-gate.md). `✅` · `⚠️ no screenshot infra: <модуль>` (`AskUserQuestion`) · `❌` строка без кадра и причины.

### 2.3 Self-check vs FAILURE

Результат не нарушает FAILURE Prompt Contract. Контракта не было → `⚠️ no Prompt Contract`.

### 2.3b Diff review (Standards + Spec)

**Единственное** ревью диффа на задачу, в любом режиме, если дифф непуст против базы (`reviewedSha` → `origin/<транк>` → `BASE_SHA`). Оси: Standards (правила проекта, smell baseline только на коде), Spec (сделано ли то, о чём просили). `/code-review` уже был → `✅ verified by /code-review`. Приём — раздельно по осям; **триаж `failure_scenario` по коду до починки**; подтверждённое чинит один агент пачкой. Механика — [`diff-review-flow.md`](references/diff-review-flow.md), промпты и порог — [`diff-review-axes.md`](references/diff-review-axes.md).

`✅ clean` / `⚠️ N standards + M spec findings (+K triaged out)` / `⚠️ diff review incomplete: <ось>` / `❌ spec: требование не реализовано`.

### 2.4 Документ задачи — `/doc-task` COMPLETE + проверка фактов

Признаки (`CLAUDE.md` → «Документирование», по факту): начальный план оказался неверен или был стоп по 3 fail-loop'ам · тронуто 5+ файлов кода (без docs/**, *.md и тестов), появился новый модуль или выполнена миграция · recurring bug или фикс на всё приложение · инфраструктурный фикс с нетривиальной причиной · просьба пользователя. Нет → `✅ skipped (rule)`. Есть → COMPLETE по `doc-task`, затем до Step 5:

```
node ~/.claude/hooks/docs-facts-guard.js <файлы DOCS_WRITTEN и ARCHIVED> --base <base.sha>
```

`LINK`/`PATH` > 0 → `❌`; `IDENT`/`NUMBER` → `⚠️`, закрыть до коммита (`references/edge-cases.md` § 4).

### 2.5 Стаб задачи

Признак был, стаба не было → `ℹ️ INIT skipped` в «Заметки», иначе `✅ N/A`.

### 2.6 Строка статистики — только `full`

`full-mode.md` § 2.6.

### 2.7 Solutions INDEX

Постоянный документ есть → строка наверху `docs/solutions/INDEX.md` (формат — `doc-task/references/templates.md`; шапку не трогать под `merge=union`). Нет → `✅ N/A`.

### 2.7b Документация уезжает вместе с кодом

`python ~/.claude/skills/task-gate/scripts/gate-prep.py --docs-only <пути DOCS_WRITTEN и ARCHIVED>` → `missing` — `❌` (рапорт о записи без записи) · `uncommitted` — добавит Step 5 · `docs.gitignored` — `ℹ️` в «Заметки». Документов нет → `✅ N/A`.

### 2.8 Deferred work

Поле `todo`: `clean` / `anchors_valid` → `✅`; `unbacked` / `broken_anchor` → `⚠️`, **5.1.1 не запускать** до ответа на `AskUserQuestion` ([`references/deferred-work-scan.md`](references/deferred-work-scan.md)). В харнессе валиден и якорь `// Issue: <url>`. `/commit` уже сканировал → `✅ verified by /commit at <sha>`.

### 2.9 Bug-pattern review (L1 + L2 + L3)

- **L1** — `l1.json` из `gate-prep.py`, второй раз не гнать. `static` HIGH → `❌`, 5.1.1 не запускать; `runtime` → «Заметки». `l1.error` непуст или `exit` ≥ 2 → `⚠️ L1 не отработал` + вывод; L2 по этому триггеру не снимается.
- **L2** — приём из 2.0; `l1.static` = 0 и L1 без сбоя → `✅ skipped (static clean)`; red flag высокой уверенности → `⚠️` + сценарий в VERIFY.
- **L3, всегда:** молча удалена user-facing функция? деплой — регион, аккаунт, smoke? субагент в scope и не коммитил? баг не воспроизведён? Неотвеченный `high` → `⚠️`; потеря функции → `AskUserQuestion` до завершения.
- NEW_RULE_CANDIDATE → строка в area-файл (`review-rules/README.md` → «Компаундинг»).

### 2.10 Improvements log и дефекты харнесса

Правка `~/.claude/{CLAUDE.md, rules, agents, skills, model-overlays, review-rules, settings.json}` → нужен `improvements/<YYYY-MM-DD>-<slug>.md` + строка индекса, иначе `⚠️`. Дефект агента или скилла, который в задаче не чинится, → GitHub issue по `harness-contributing`, ссылка в отчёт.

---

## Step 3 — Sub-agent Sanity Check

**В обоих режимах:** дифф несёт прод-код (`CLAUDE.md` → «Прод-код пишет специалист»), а доменного специалиста в `Agents used` нет → `⚠️ прод-код правил главный: <файлы>` + оправдывающий пункт; точечная правка — `1 файл ✓|✗ · без домена ✓|✗ · N правок, fail-loop нет ✓|✗`. Любой `✗`, файл сборки, первый фикс видимого бага → `⚠️ условия «главный пишет сам» нарушены: <какое>`. Сигналы по агентам — только `full` (`full-mode.md` § Step 3).

---

## Step 5 — Commit & Final Report

### 5.1 Commit

`commit.dirty` > 0 → 5.1.1 или предложить `/commit`; чисто → `✅`. `git commit` через Bash — никогда.

### 5.1a Готовность к merge (факты)

Поле `merge`: `protected` → `⚠️ committed to trunk`, Step 6 не запускать · `upstream: null` — норма · `open_mr` — переиспользовать · `deploy.signals` → `⚠️ merge в <транк> запускает деплой <куда>`. Статус `📦 Ready to merge: <branch> → <trunk>`. Согласованная работа в транке → `✅ N/A`, Step 6 только уборкой worktree.

### 5.1b Артефакт для подтверждения (обязательный)

- **Web** → живой `http://localhost:<port>/<экран>`: скилл `run` из worktree, `run_in_background`, ответ проверен, **живёт до подтверждения**; повторный gate → `TaskStop` и заново.
- **Android** → debug APK под физическое устройство. **Установка — только с согласия на сборку после последней правки** (`AskUserQuestion`: «Установить на <MODEL> сейчас (Recommended)» / «Сам поставлю» / «Не нужно»); без ответа `adb install`, `installDebug`, `/install-device` не вызывать.
- **Остальное** → вывод команды, `curl`, лог, PNG, путь + фрагмент, `Artifact`.

Недостижим первый приоритет → `⚠️ fallback: <вид> — <причина из вывода>`. Нет артефакта → `❌ no artifact`, `NOT READY`. Процедура — [`references/artifact-handoff.md`](references/artifact-handoff.md), до сборки.

### 5.1.1 Auto-commit

`Skill(skill="commit")` без вопроса, если все 6: нет `❌` · `git status` непуст · коммит не запрещён · `commit.suspicious` пуст · 2.8 без unbacked TODO · ветка не защищённая (иначе `⚠️ protected branch` + `AskUserQuestion`). Промежуточный дифф (Partially Done, диагностические логи, смесь задач) → сначала вопрос. Чисто → `✅ commit auto-created` + SHA, иначе `❌ auto-commit failed` + stderr. Гарды — [`references/auto-commit-rules.md`](references/auto-commit-rules.md).

### 5.2 Final Report

Таблица `TASK GATE`: `Mode: lite | full`, пункты 2.0–2.10, 3, 5.1, 5.1b; пропущенное — `⏸ lite`. Под ней — `Заметки:` и `VERDICT`:

- `❌ NOT READY` — любой `❌` (uncommitted, COMPLETE не пройден, impact scan, нет артефакта). «Готово» не отвечать.
- `⚠️ READY WITH WARNINGS` — есть `⚠️`, требующий решения пользователя или действия.
- `✅ READY` — иначе, **даже при заметках**. `ℹ️` в «Заметки»: `⏸ lite`, `N/A`, triaged out, optional, INIT skipped, `docs/ gitignored`, `runtime` без red flag, `reviewedSha not advanced`.

Затем **при любом вердикте**:

```bash
python ~/.claude/skills/task-gate/scripts/gate-log.py --scratchpad <session-scratchpad> --verdict "<READY|READY WITH WARNINGS|NOT READY>" --artifact <localhost|apk|other|fallback|none> --agents <ревьюеры 2.3b + L2> [--review-clean] [--review-sec <N>] [--once <ключи>] [--artifact-task <id> --artifact-url <url>]
```

Скрипт проверяет схему, пишет строку в `~/.claude/stats/task-gate-timings.jsonl`, на READY ставит `lastGateSha = HEAD`; `--review-clean` (2.3b вернулся по ВСЕМ осям и без `❌`; ось не вернулась — флаг не передавать) двигает `reviewedSha`, только если дифф не менялся после ревью.

READY / READY WITH WARNINGS → блоки `📦 Ready to merge` и `🎁 Artifact:` (URL, APK + устройство, снимки, вывод) и строка `Подтверди результат — дальше сам: push → MR → merge (squash, по зелёному CI) → уборка ветки.` Гарды 5.1a не пройдены → причина вместо строки. Docs-only → без строки, сразу Step 6. Android без согласия → `AskUserQuestion` 5.1b; ответ на него — не подтверждение.

---

## Step 6 — MR & Merge (после подтверждения)

Задача закрыта **влитым** MR/PR. `READY` сам merge не разрешает.

**Разрешение** — подтверждение после отчёта gate («да», «готово», «мержи», «подтверждаю», «всё верно») — на всю цепочку, по шагам не переспрашивать. Молчание, новая задача, пауза, названный недостаток → `⚠️ merge pending confirmation`.

**Без подтверждения — docs-only:** только `docs/**`, корневые `*.md` (кроме `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`), в харнессе ещё `improvements/**`; ни одной инструкции агента; без деплоя, включая сайт документации; без открытых находок 2.3b и `⚠️ diff review incomplete`. Подсказка — `merge.docs_only_files`, `merge.deploy.docs_site`; критерий — [`mr-merge.md`](references/mr-merge.md) § «Без подтверждения». Отчёт — после merge, `🔀 auto-merged: docs-only`.

**Гарды** (иначе стоп + строка): вердикт без `❌` · ветка не защищённая · `git status --porcelain` пуст · 2.1 не `❌` · merge не запрещён. `⚠️ diff review incomplete` — не гард.

0. **Обновить базу — до push, всегда.** `git fetch origin <trunk>`; `git merge-base --is-ancestor origin/<trunk> HEAD` не прошёл → `git merge origin/<trunk>` (rebase — на неопубликованной) и **перепрогнать 2.1**. Красная → `❌ base merge broke validation`, push не делать. Конфликт — в ветке, не в UI; merge-коммит базы — исключение из «только `/commit`». MR транк→транк — без обратного вливания.
1. **Push** — `git push -u origin <branch>` (апстрим есть → `git push`).
2. **MR/PR** — открыт → переиспользовать; нет → `glab mr create --fill --remove-source-branch --target-branch <trunk>` / `gh pr create --fill --base <trunk>`; документ задачи — ссылкой в тело.
3. **Merge — squash по зелёному pipeline.** `glab mr merge <iid> --squash --auto-merge --remove-source-branch --yes` / `gh pr merge <num> --squash --delete-branch`; `--auto` — только при обязательных проверках и включённом auto-merge (`mr-merge.md` § «Merge»); pipeline нет → без `--auto-merge`/`--auto`.
4. **Дождаться** терминального состояния (`gh pr view <num> --json state` / `glab mr view <iid>`) фоновым `until`-циклом; очередь — не «влито». Красный CI, конфликт → `❌ merge failed: <причина>`, CI не обходить.
5. **Уборка — всегда, даже когда гарды остановили merge.** (а) До `ExitWorktree` — `TaskStop` фоновых задач и `Monitor` этой задачи, закрыть Playwright, дождаться субагентов. (б) Remote-ветка снята флагом, иначе `git push origin --delete <branch>`. (в) `MERGED`/`merged` **и** `git status --porcelain` пуст → сразу `ExitWorktree({action: "remove", discard_changes: true})`; status непуст → флаг не ставить, показать. (г) Каталог остался — хук `worktree-exit-watch` назовёт держателей: свой процесс остановить, чужой не трогать, `rmdir` не нужен; жива ветка → `git branch -D <branch>` из главного checkout. Затем главный checkout на транк, `git pull`. Детали — `mr-merge.md` § «Уборка».
6. **Jira** — задача по ключу (из запроса, slug worktree или заголовка MR; ключ запомнить до п. 5 — уборка) и merge подтверждён → `@jira-expert`, `EVENT: merged`.
7. **Отчёт** `🔀 Merge:` — `MR`, `Merged: <sha>`, `Cleanup`, `Deploy: <triggered … | none>`, `Jira: <ключ> → <статус> | none | failed`.

Команды по платформам и отказы (approval, нет `gh`/`glab`, красный CI после merge) — [`references/mr-merge.md`](references/mr-merge.md).

---

## Что скилл не делает

Глубокое ревью по произвольной базе (`/code-review`), security-аудит (`/security-review`), `git commit` через Bash, merge без подтверждения (кроме docs-only) и в обход CI, документацию за главного (2.4 сверяет факты).

## Edge cases и файлы

Не git, сессия без задачи, недописанная задача, накопленные задачи без gate, зависший агент, pre-commit hook на auto-commit, потерянный state → [`references/edge-cases.md`](references/edge-cases.md). References: `full-mode`, `diff-review-flow`, `diff-review-axes`, `screenshot-gate`, `deferred-work-scan`, `artifact-handoff`, `auto-commit-rules`, `mr-merge`, `calibration`, `edge-cases`. Связанные скиллы: `/commit`, `doc-task`, `code-review`, `run`, `harness-contributing`.
