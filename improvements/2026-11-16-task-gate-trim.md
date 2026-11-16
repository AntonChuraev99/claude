---
date: 2026-11-16
slug: task-gate-trim
status: applied
goal: гейт задачи быстрее и надёжнее — full по коду, а не по документам, без очереди рекомендаций, механика в скриптах, Step 6 переживает compaction
metric: доля full среди гейтов; медиана длительности гейта; отказы worktree на строке тайминга; доля READY WITH WARNINGS
baseline_date: 2026-11-16
target_date: 2026-11-30
---

# /task-gate: порог full по коду, скрипты вместо ручных команд, без очереди рекомендаций

## Цель

Гейт запускается на каждую задачу, поэтому его цена умножается на всё. По логу гейт почти всегда шёл в `full`, вердикт почти всегда был «с предупреждениями», а ручные строки Bash отклонялись в worktree. Убрать то, что не меняет решение, и перенести механику в код, который не ошибается в схеме.

## Baseline (до изменений, на дату 2026-11-16)

Источник — `~/.claude/stats/task-gate-timings.jsonl` (вне git) и логи сессий, аудит главного 2026-11-16:

- режимы: `full` 526, `lite` 147 — `full` в 78% гейтов. Медиана 12 файлов на гейт; порог `full` был «5+ файлов», а гейт сам создаёт 3 файла документов (активный документ, solution, INDEX);
- длительность `full`: медиана гейта 9,4 мин, ревью 4,1 мин, p90 26 мин;
- вердикт: 487 из 544 гейтов — `READY WITH WARNINGS`, вердикт перестал различать;
- строка тайминга с `$(date …)` и `$(basename "$(git rev-parse …)")`: в worktree отказ «too complex to verify» в 26 из 299 вызовов (9%); схема гуляет — 38 строк `READY_WITH_WARNINGS`, 99 строк `artifact: null`;
- очередь рекомендаций (Step 4, 5.2.1): в `~/.claude/recommendations/` 282 файла, 276 `pending-review`, 1 `applied`, 5 `partially-applied` — её не читают;
- `SKILL.md` 52 816 символов, 424 строки; описание 1779 символов — листинг резал его на «завершаем се…», пропадали хвостовые триггеры и «запускай до сообщения о готовности»;
- по докам Claude Code после compaction от скилла остаются первые 5000 токенов — Step 6 (merge) стоял в конце 52k-файла и выпадал;
- TODO-скан был описан дважды: `skills/commit/SKILL.md` и `references/deferred-work-scan.md`; `skills/git-commit-conventions` повторял формат из `skills/commit`; `skills/git-worktree-env` помечен DEPRECATED и выключен.

## Гипотеза

1. Порог `full` по файлам **кода** (без `docs/**`, `*.md`, тестов и `improvements/`) уберёт ложные `full`, которые набирались документами самого гейта; остальные триггеры `full` не меняются.
2. Вердикт различает, если `⚠️` ставится только на то, что требует решения пользователя или действия, а информационные пометки идут в строку «Заметки» при вердикте `READY`.
3. `gate-prep.py` и `gate-log.py` убирают ручные команды с `$(...)` из worktree (0 отказов на строке тайминга) и держат схему лога (0 строк вне набора `mode`/`verdict`/`artifact`); длительности снимаются в обоих режимах без лишних вызовов.
4. `SKILL.md` ≤ 25k символов с lite-путём и Step 6 в начале переживает compaction; описание ≤ 600 символов показывается целиком.

## Изменения

- `skills/task-gate/SKILL.md` — переписан: 52 816 → ~16k символов; описание 1779 → 578 символов, триггеры первыми; порог `full` по коду; Step 4 и 5.2.1 удалены; вердикт с «Заметками»; Step 1, 2.0, 2.7b, 2.8, 5.1a, 5.2 вызывают скрипты; номера пунктов, на которые ссылаются `CLAUDE.md`, агенты и правила, сохранены.
- `skills/task-gate/scripts/gate-prep.py` (+ `gate-prep.tests.py`) — BASE_SHA и state, режим 1.1, пакет диффа и отпечаток для ревьюера, L1, пакет L2, TODO-скан, 2.7b, факты 5.1/5.1.1/5.1a, класс docs-only для Step 6.
- `skills/task-gate/scripts/gate-log.py` (+ `gate-log.tests.py`) — строка тайминга с валидацией схемы, обновление state (`lastGateSha`, `reviewedSha` по отпечатку, `onceChecks`, `artifactServer`), защита от двойной записи.
- `skills/task-gate/references/full-mode.md` — новое: второй ревьюер, `[once]`-проверки, 2.6, сигналы Step 3 (`@kmp-expert` влит в `@android-platform-expert`), строка `⏱`.
- `references/diff-review-flow.md` — раздел «Фан-аут (2.0)» (бриф, сторож, L2); отпечаток через скрипты. `diff-review-axes.md` — пакет собирает скрипт, раздел «Порог находки» не тронут.
- `references/recommendations-pull.md` — удалён; ссылки в `edge-cases.md`, `auto-commit-rules.md`, `doc-task` (секция «Предложения по улучшению агентов» и шаблон) убраны. Дефект агента или скилла → GitHub issue по `harness-contributing` (2.10).
- `references/deferred-work-scan.md` — единственное место процедуры TODO; `skills/commit` вызывает `gate-prep.py --todo-only` вместо своего grep и своей копии вопросов.
- `skills/git-commit-conventions/`, `skills/git-worktree-env/` — удалены.

## Target

К 2026-11-30 по строкам `task-gate-timings.jsonl` после merge:

- доля `full` ≤ 50% (было 78%);
- медиана длительности гейта ниже 9,4 мин (`gate_sec` теперь пишется и в `lite`);
- 0 отказов «too complex to verify» на вызовах `gate-prep.py` / `gate-log.py` в worktree;
- 0 новых строк с `verdict` или `artifact` вне набора;
- доля `READY WITH WARNINGS` заметно ниже 90%.

## Replay (заполняется через N дней)
