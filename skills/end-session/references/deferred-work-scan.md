# Deferred-Work Scan — Step 2.9 алгоритм и Bash-команды

Этот файл — extract из Step 2.9 `end-session/SKILL.md`. Алгоритм проверки `TODO`/`FIXME`/`STOPSHIP` в коде против `docs/todos/`. Правило-источник — глобальный `~/.claude/CLAUDE.md` → раздел «Отложенный функционал».

## Цель

Поймать ситуацию, когда часть scope сознательно не доделана (ждём бэкенд, пользователь отложил, partial platform coverage), но артефакт `docs/todos/<...>.md` не создан → следующая сессия не увидит долг.

## Алгоритм

### Шаг 1 — Сбор кандидатов в диффе сессии

`git diff` по staged + unstaged + новым файлам, только code-расширения, ищем `TODO|FIXME|STOPSHIP:` в **новых** строках (`^+`, исключая `+++`):

```bash
git diff -U0 HEAD -- \
    '*.kt' '*.kts' '*.java' '*.ts' '*.tsx' '*.js' '*.jsx' \
    '*.py' '*.go' '*.rs' '*.swift' '*.rb' '*.php' '*.cs' \
    '*.cpp' '*.c' '*.h' '*.hpp' '*.m' '*.mm' \
  | grep -nE '^\+.*\b(TODO|FIXME|STOPSHIP):' \
  | grep -v '^\+\+\+'
```

**Test-файлы исключить из списка** — там TODO допустим как часть test scaffolding. Паттерны exclude:

- `*Test.kt`, `*Tests.kt` (Kotlin)
- `*test*.py`, `__tests__/` (Python / JS)
- `*_test.go`, `*_spec.rb`, `*.spec.ts`, `*.test.ts`
- любые файлы в каталогах `test/`, `tests/`, `spec/`

### Шаг 2 — Категоризация результатов

#### Случай A — 0 совпадений

→ `✅ no unbacked TODO`. Шаг закрыт.

#### Случай B — Есть совпадения с `// Pending:` anchor рядом

Для каждой строки с TODO/FIXME проверить, есть ли в той же строке или в смежной строке anchor формата:

```
// Pending: docs/todos/<YYYY-MM-DD>-<slug>.md
```

```bash
# Поиск anchor'ов
grep -nE '// Pending: docs/todos/' <files>
```

Затем проверить, что упомянутые файлы **реально существуют**:

```bash
ls docs/todos/<YYYY-MM-DD>-<slug>.md   # для каждого упомянутого
```

- Все файлы на месте → `✅ TODO anchors valid (N items)`.
- Хоть один файл отсутствует → `⚠️ broken Pending anchor: <file>` + список ломаных.

#### Случай C — Есть совпадения без anchor'а

→ `⚠️ unbacked TODO in code (N items)` + список `файл:строка`.

### Шаг 3 — Действие при unbacked TODO

В финальный отчёт Step 5.2 вынести строку:
```
2.9 Deferred-work integrity ⚠️ N unbacked TODOs
```
с перечнем.

**Не блокировать gate автоматически** (это warning, не ❌). Но в `5.1.1 Auto-commit` действует жёсткое правило: **если есть unbacked TODO — auto-commit НЕ запускать**, спросить пользователя через `AskUserQuestion`:

| Опция | Действие |
|---|---|
| **Создать `docs/todos/<...>.md` и заменить TODO на Pending-anchor** (Recommended) | Скилл сам делает Write + Edit, затем продолжает с auto-commit |
| **Удалить TODO из кода** | Мини-Edit, продолжить с auto-commit |
| **Override (закоммитить с TODO)** | Пометка `2.9 ⚠️ override (N TODOs)`, продолжить с auto-commit, в commit body добавить `Refs: deferred-work-override <N> TODO(s)` со списком |
| **Отложить решение** | `2.9 ⚠️ pending user`, **остановить** end-session, вернуть управление пользователю |

### Шаг 4 — Проверка `docs/todos/INDEX.md` (если файл существует)

```bash
test -f docs/todos/INDEX.md && cat docs/todos/INDEX.md
```

- Для каждой записи в `## Open` — `Glob` указанного файла → существует ли. Сломанные ссылки в `⚠️ stale INDEX entry: <link>`.
- Если в project memory есть `deferred_*.md`, но в `docs/todos/INDEX.md` соответствующей записи нет — `⚠️ memory-INDEX desync: <slug>`.

### Шаг 5 — Не дублировать работу `/commit`

Если в этой сессии уже был вызван `/commit` и он прошёл свой собственный deferred-work scan → Step 2.9 повторяет лишь нумерацию строки в финальном отчёте:

```
2.9 Deferred-work integrity ✅ verified by /commit at <sha>
```

Цель end-session — поймать ситуацию, когда `/commit` ещё не запускался либо запускался **до** появления новых TODO.

## Создание `docs/todos/<...>.md` (если пользователь выбрал «Создать»)

Шаблон из `docs/todos/TEMPLATE.md` (если есть). Минимум:

```yaml
---
title: <короткое описание>
date: <YYYY-MM-DD>
status: deferred
parent_task: <slug активного doc-а>
blocking_reason: <user-deferred|waiting-for-backend|waiting-for-decision|waiting-for-data|partial-platform-coverage>
resume_trigger: <что должно случиться, чтобы возобновить>
estimated_complexity: <Trivial|Standard|Complex>
keywords: [<ключевые слова для поиска>]
---

# <Title>

## Что отложено
<краткое описание>

## Контекст
<родительская задача, ссылки>

## Шаги при возобновлении
1. ...
2. ...

## Как возобновить (для cold-start агента)
<инструкции, чтобы агент следующей сессии понял с нуля>
```

И обновление `docs/todos/INDEX.md` — строка в верх таблицы `## Open`:

```
| YYYY-MM-DD | <title> | <blocking_reason> | <resume_trigger> | [link](file.md) |
```

Также добавить запись в `## Deferred Work` секцию project memory.

## Why

Прецедент 2026-05-12 (NavRail OfferTimerCard) — `// TODO: render com.example.ui.banner.SomeComponent...` остался в `app/src/commonMain/.../AppContent.kt`, в memory задача попала в Completed Features, через 1 день пользователь нашёл симптом «компонент не появляется на web после закрытия оффера», потребовался отдельный turn на разбор.

End-session — последний gate перед сменой контекста; ловит то, что прошло мимо `/commit` (например, если правки делались в нескольких подсессиях). Без этого scan'а долги тихо растворяются.
