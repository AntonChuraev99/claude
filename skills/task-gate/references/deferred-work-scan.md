# Deferred-work scan — TODO в коде против `docs/todos/`

Единственное место процедуры: её используют `/task-gate` 2.8 и `/commit` (шаг 4a). Правило-источник — `~/.claude/CLAUDE.md` → «Документирование» (`// TODO:` без записи в `docs/todos/` — нарушение) и `~/.claude/rules/docs-structure.md` (`todos` vs `backlog`).

## Цель

Поймать сознательно не доделанную часть scope (ждём бэкенд, пользователь отложил, partial platform coverage), у которой нет `docs/todos/<...>.md`, — иначе следующая сессия не увидит долг.

## Скан — скрипт, а не grep

| Кто | Команда | Что сканирует |
|---|---|---|
| gate 2.8 | `gate-prep.py` (поле `todo` в общем выводе) | новые строки `git diff -U0 <BASE_SHA>` + неотслеживаемые файлы |
| `/commit` до stage | `python ~/.claude/skills/task-gate/scripts/gate-prep.py --todo-only` | staged + unstaged против `HEAD` + неотслеживаемые |
| `/commit` после stage | то же с `--staged` | только staged |

Скрипт ищет `\b(TODO|FIXME|STOPSHIP):` только в **добавленных** строках файлов кода (`.kt .kts .java .ts .tsx .js .jsx .py .go .rs .swift .rb .php .cs .cpp .c .h .hpp .m .mm`). Тестовые файлы исключены (`*Test.kt`, `*.test.ts`, `test_*.py`, `*_test.go`, каталоги `test/`, `tests/`, `spec/`, `__tests__/`, `*Test/` source sets): там TODO — часть scaffolding. `.md` не сканируется — TODO в задачнике норма.

Для каждой находки — якорь в той же или соседней строке: `// Pending: docs/todos/<YYYY-MM-DD>-<slug>.md` (файл обязан существовать), в харнессе `~/.claude` ещё `// Issue: <url GitHub issue>` (скилл `harness-contributing`).

## Статусы

| `todo.status` | Значит | Статус пункта |
|---|---|---|
| `clean` | новых маркеров нет | `✅ no unbacked TODO` |
| `anchors_valid` | у всех маркеров живой якорь | `✅ TODO anchors valid (N)` |
| `broken_anchor` | якорь ведёт на несуществующий файл | `⚠️ broken Pending anchor: <файл>` |
| `unbacked` | маркер без якоря | `⚠️ unbacked TODO (N)` + `файл:строка` |

`/commit` уже прогнал скан на этом диффе → в gate `✅ verified by /commit at <sha>`.

## Действие при unbacked TODO

Gate не блокируется (это `⚠️`), но **auto-commit 5.1.1 и stage в `/commit` не запускать** до ответа на `AskUserQuestion` — один вопрос на файл, до 4 в пачке, путь:строка и текст в вопросе:

| Опция | Действие |
|---|---|
| **Создать `docs/todos/<YYYY-MM-DD>-<slug>.md` и заменить TODO на якорь** (Recommended) | `Write` документа по шаблону ниже, строка в `docs/todos/INDEX.md`, `Edit` маркера: `// TODO: <...>` → `// Pending: docs/todos/<файл>` (один якорь на запись, в главной точке). Новые файлы — в тот же коммит. В харнессе — «Создать GitHub issue» и якорь `// Issue: <url>` |
| **Удалить TODO** | маркер был артефактом черновика — убрать строку, перестейджить |
| **Я уже создал запись** | пользователь называет файл → `Glob` подтверждает → заменить маркер на `// Pending:` |
| **Override (закоммитить с TODO)** | `⚠️ override (N TODOs)`; в тело коммита строка `Refs: deferred-work-override <N> TODO(s)` со списком файл:строка. Один override закрывает все маркеры этого коммита |
| **Отложить решение** (только gate) | `2.8 ⚠️ pending user`, gate останавливается, управление пользователю |

После правок — повторить скан: маркеров нет либо у всех живой якорь.

**Ложные срабатывания.** Перенесённый без изменений TODO (git видит его как `+` в новом файле) — спросить, при «это перенос» — override. Неожиданный тип файла кода вне списка расширений — спросить, считать ли его кодом.

## `docs/todos/INDEX.md` (gate 2.8, если файл есть)

- Каждая запись `## Open` — `Glob` по ссылке; битая → `⚠️ stale INDEX entry: <link>`.
- В project memory есть `deferred_*.md`, а записи в INDEX нет → `⚠️ memory-INDEX desync: <slug>`.

## Шаблон `docs/todos/<YYYY-MM-DD>-<slug>.md`

Берётся `docs/todos/TEMPLATE.md`, если есть. Иначе минимум:

```yaml
---
title: <короткое описание>
date: <YYYY-MM-DD>
status: deferred
parent_task: <slug активного документа>
blocking_reason: <waiting-for-backend|waiting-for-decision|waiting-for-data|partial-platform-coverage>   # только внешнее событие; «отложили без триггера» → docs/backlog/
resume_trigger: <что должно случиться, чтобы возобновить>
scope: <что именно отложено, одной строкой>
keywords: [<ключевые слова для поиска>]
---

# <Title>

## Что отложено
## Контекст
## Шаги при возобновлении
## Как возобновить (для cold-start агента)
```

Строка наверх таблицы `## Open` в `docs/todos/INDEX.md` (файла нет — создать с шапкой):

```
| YYYY-MM-DD | <title> | <blocking_reason> | <resume_trigger> | [link](file.md) |
```

И запись в секцию `## Deferred Work` project memory.

## Почему

Прецедент 2026-05-12: `// TODO: render com.example.ui.banner.SomeComponent...` остался в `commonMain`, задача ушла в память как завершённая, detekt `ForbiddenComment` на этом source set не запускался. Через день пользователь нашёл симптом «компонент не появляется после закрытия оффера» и потратил отдельный цикл на разбор. `/commit` ловит маркер до истории; gate — то, что прошло мимо `/commit` (правки из нескольких подсессий, коммит до появления маркера).
