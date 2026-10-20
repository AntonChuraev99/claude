---
date: 2026-10-20
slug: claude-md-diet
status: applied
goal: Вдвое сократить резидентный контекст главного (CLAUDE.md) и описания агентов без потери инвариантов
metric: символы CLAUDE.md и сумма description агентов; соблюдение делегирования и gate по replay
baseline_date: 2026-10-20
target_date: 2026-11-03
---

# Диета CLAUDE.md и описаний агентов

## Цель

Сверка с рекомендациями Anthropic на 2026-10-20 (code.claude.com/docs: memory, best-practices, sub-agents; гайд по промптингу Opus 5): длинный CLAUDE.md снижает соблюдение правил, `@import` стоимость не снижает, тест строки — «если убрать, Claude ошибётся?». Наш файл формально укладывался в 200 строк, но строки были очень длинные: 34,5 тыс. символов. Описания агентов едут в системный промпт каждой сессии; три из них были почти вдвое выше бюджета ~1 500 символов из `subagent-authoring`.

## Baseline (2026-10-20)

- `CLAUDE.md`: 196 строк, 34 553 символа; порог хука `claude-md-size-guard` — 37 000.
- Сумма `description` 18 агентов: 27 408 символов. Выше бюджета: `marketing-expert` 2 876, `product-expert` 2 844, `google-play-console-expert` 2 631, `best-practices-scout` 1 698.
- Соблюдение правил отдельно не замерено; база для replay — `scripts/replay-delegation.py` и `scripts/session-stages.py` на сессиях до 2026-10-20.

## Гипотеза

Почти всё лишнее в CLAUDE.md — обоснования («почему») и пересказ процедур, которые уже живут в скиллах (`task-gate` Step 6, `harness-contributing`, `screenshot-driven-ui`, `mcp-mobile-test`, `install-device`), в `rules/` и в хуках, которые сами печатают свои границы (`bash-tool-discipline`, `credentials-digest`, `artemis-default-guard`). Если убрать их и оставить инварианты, файл сократится вдвое, а поведение не изменится. Три прошлые попытки сократить файл (последняя — `claude-md-char-trim`, 2026-09-23) снимали по 5-10%; здесь граница проведена по механизму, а не по длине абзаца, и порог хука опущен вслед за файлом, чтобы рост снова стал виден.

## Изменения

- `CLAUDE.md`: 135 строк, 16 801 символ (−51%; цель разбора была 10-12 тыс., не достигнута — ниже резать без потери инвариантов не стал, см. `docs/decisions/claude-md-diet-2026-10-20.md`). Сохранены все 17 якорей, на которые ссылаются агенты, скиллы, оверлеи и `review-rules/process-gate.yaml` (§ «Цена вызова инструмента», «Тесты», «Багфикс», «Защищённая ветка и worktree», «Документирование», «Git-коммиты», «Definition of Done», «Bug-pattern gate» и др.), и нумерация шагов Prompt Contract (на «шаг 3» ссылаются скауты). Убраны обоснования, пересказ процедур скиллов и деталей, которые печатают хуки; снижен объём жирного шрифта. Указатель на прецеденты перенесён в HTML-комментарий: по доке memory блочные комментарии вырезаются до инжекта.
- `hooks/claude-md-size-guard.py`: `CHAR_LIMIT` 37 000 → 17 500 (~5% над новым размером), комментарий и docstring; `skills/instruction-routing/SKILL.md` — то же число в двух местах.
- `hooks/claude-md-size-guard.tests.py`: фикстура «чуть ниже обоих порогов» 30 099 → 15 099 символов вслед за новым порогом; assert не менялся, 24/24 зелёные.
- `agents/{marketing-expert,product-expert,google-play-console-expert,best-practices-scout}.md`: description сокращены до 1 210–1 950 символов. Убраны английские дубли русских триггеров и формат вывода, который уже есть в теле; триггеры по смыслу и взаимные границы `DO NOT use for:` сохранены. Сумма — 23 890 (−13%).

### Prompt audit (`/doctor prompt-audit`, 2026-10-20)

Аудит по руководству `prompt-audit.md` встроенного скилла `claude-api`, целевая модель Opus 5.5, три read-only аудитора по зонам. Применены только находки High/Medium группы 1 и удаление датированных нарративов; конфликты файлов и устаревшие факты (группа 2) по правилу руководства не применяются без подтверждения и вынесены пользователю.

- Регрессия диеты: 10 агентов ссылались на `CLAUDE.md` § «Тесты» и § «Цена вызова инструмента» за текстом, который из CLAUDE.md ушёл; ссылка «Тесты» переведена на `~/.claude/rules/testing.md`, «замеры» — на «границы печатают хуки».
- `agents/design-expert.md`: удалён финальный «self-check» — Opus 5.5 проверяет себя сам, и строка противоречила `model-overlays/subagent.md`.
- `output-styles/ste-ru.md`: «как раньше» (ссылка на стиль, которого модель не видела) → позитивная формулировка.
- `commands/install-device.md`: снят нажим «ВСЕГДА / обязательный» в шаге запуска; удалён четвёртый повтор разрешения на uninstall.
- `skills/{task-gate,amplitude-slack-payload,jira-task-writer,ab-test-dashboard}`: удалены датированные прецеденты внутри правил (правило рядом остаётся), включая ключ приватного Jira-тикета.
- `skills/subagent-authoring`: убран второй, расходящийся абзац о превышении бюджета; `skills/instruction-routing`: «что делать, а не почему» → одна фраза причины там, где без неё правило применят не там.

Второй раунд — группа 2 по решению пользователя (2026-10-20):

- Голый `git stash`/`pop` и `grep`/`head`/`cat` через Bash убраны из `skills/commit`, `skills/task-gate` (+ `references/deferred-work-scan.md`), `skills/instruction-routing`, `skills/subagent-authoring`, `commands/sync-local-develop.md`, `rules/docs-structure.md` — как в CLAUDE.md.
- `commands/install-device.md`: description больше не обещает «never uninstalls» — uninstall при конфликте версии/подписи разрешён.
- Область режима `full`: одна формулировка в `skills/task-gate/SKILL.md` и CLAUDE.md — правки инструкций или исполняемых файлов `~/.claude`.
- `references/mr-merge.md`: конфликт с транком — merge транка в ветку, как Step 6.0; rebase только на незапушенной ветке (squash-merge всё равно схлопывает историю ветки).
- `references/diff-review-axes.md` выровнен с SKILL.md: на frontmatter `@bug-pattern-reviewer` не полагаться.
- `android-platform-expert`, `wasmjs-expert`: условие протокола багфикса — «или виден пользователю», как в CLAUDE.md.
- `kmp-expert`: «ViewModel в commonMain» уточнён до переноса ViewModel-слоя (зависимость, базовый класс, DI-фабрика); ViewModel конкретной фичи остаётся у `@feature-expert`.
- Мелочь: комментарий о fallback в `model-overlays/opus-5.md` по `hooks/model-overlay.ps1`; датированная заметка в `fable.md`; «исчерпывающая таблица» в `test-firebase-function`; ссылка на `decisions/` в шаблоне INDEX; список git-шагов в `task-gate/references/edge-cases.md`.

## Target

- Хук `claude-md-size-guard` молчит; CLAUDE.md не дорастает до 17 500 к target_date.
- Replay на сессиях после 2026-10-20: доля прод-правок главного вне трёх условий и пропуски `/task-gate` не растут относительно baseline (`scripts/replay-delegation.py`, `scripts/session-stages.py`).
- Маршрутизация продукт / маркетинг / Play Console не ухудшилась: нет случаев, где вопрос ушёл не тому агенту или главный ответил сам.

## Replay (заполняется через N дней)

<!-- 2026-11-03 -->
