---
name: commit
description: Create a Conventional Commits compliant git commit. Use this skill whenever the user says "commit", "create a commit", "git commit", "зафиксируй изменения", "сделай коммит", or asks to commit staged or unstaged changes. Stages relevant files and crafts a properly scoped commit message automatically.
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*)
---

# Git Commit — Conventional Commits

Create a well-formed git commit following the [Conventional Commits](https://www.conventionalcommits.org/) specification.

## Steps

1. Run `git status` to see what has changed.
2. Run `git diff` (unstaged) and `git diff --staged` (staged) to understand the actual changes.
3. Run `git log --oneline -5` to match the style of recent commits in this project.
4. Decide which files belong in this commit — skip build artifacts, caches, lock files unless explicitly changed on purpose.
4a. **Deferred-work scan** (see `## Deferred-work scan` ниже) — заблокирует stage, если в коммите есть `// TODO:` / `// FIXME:` / `// STOPSHIP:` без соответствующего `docs/todos/<...>.md`.
5. Stage files with `git add <files>` if not already staged.
6. Craft the commit message (see format below) and commit using HEREDOC syntax.

## Commit Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**

| Type | When to use |
|---|---|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change with no new feature or fix |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `style` | Formatting, whitespace |
| `test` | Adding or updating tests |
| `chore` | Tooling, dependencies, maintenance |
| `build` | Build system changes |
| `ci` | CI/CD configuration |

**Rules (apply every time):**

- Description max 50 characters
- No period at the end
- Imperative mood: "add", "fix", "update" — not "added", "fixed"
- Type and scope in lowercase
- Scope is optional — use it when it adds clarity (module name, feature area)
- Never add `Co-Authored-By` or attribution trailers

## HEREDOC Syntax (required)

Always use HEREDOC to avoid shell escaping issues:

```bash
git commit -m "$(cat <<'EOF'
feat(auth): add password reset flow
EOF
)"
```

With body:
```bash
git commit -m "$(cat <<'EOF'
feat(catalog): add infinite scroll pagination

Load next page when user reaches 80% of list.
Replaces manual "Load more" button.
EOF
)"
```

## When to Add a Body

Add a body when:
- The change touches 3+ files and the why isn't obvious from the title
- The approach is non-obvious or has trade-offs worth documenting
- It's a breaking change or a revert

## Breaking Changes

Add `!` after type/scope and a `BREAKING CHANGE:` footer:

```
feat(api)!: change auth endpoint response format

BREAKING CHANGE: `jwt` field renamed to `accessToken`, update all clients
```

## Reverts

```
revert: feat(catalog): add infinite scroll pagination

Refs: abc1234
```

## Examples

```
feat(auth): add two-factor authentication
fix(catalog): resolve image loading crash on Android 14
refactor(data): extract repository base class
perf(db): replace O(n²) lookup with hash map
docs: update contributing guide
chore(deps): bump retrofit to 3.0.0
```

## If Arguments Were Provided

If the user passed arguments (e.g., `/commit fix login bug`), treat them as a hint for the description. Validate the staged diff still matches before committing.

## Deferred-work scan

Перед stage'ом проверить, что в коммитимом диффе нет «потерянных» TODO. Правило из глобального `~/.claude/CLAUDE.md` → раздел «Отложенный функционал (`docs/todos/`)»: если функционал отложен, должен существовать `docs/todos/<YYYY-MM-DD>-<slug>.md`. `// TODO:` / `// FIXME:` / `// STOPSHIP:` в коде сам по себе уже нарушение (detekt `ForbiddenComment` для Kotlin), плюс теряется между сессиями.

### Алгоритм

D1. Собрать списки кандидатов из диффа (staged + unstaged, которые войдут в коммит). Команда:
   ```bash
   git diff --cached -U0 -- '*.kt' '*.kts' '*.java' '*.ts' '*.tsx' '*.js' '*.jsx' '*.py' '*.go' '*.rs' '*.swift' '*.rb' '*.php' '*.cs' '*.cpp' '*.c' '*.h' '*.hpp' '*.m' '*.mm' \
     | grep -nE '^\+.*\b(TODO|FIXME|STOPSHIP):' \
     | grep -v '^\+\+\+'
   ```
   Аналогично для `git diff` (unstaged), если файл планируется добавить в этот коммит.
D2. Если совпадений нет — `✅ no unbacked TODO`, идти к шагу 5 секции «Steps» (Stage files).
D3. Если совпадения есть — для каждого нового TODO-маркера показать пользователю (через `AskUserQuestion`, 1 вопрос на каждый файл, до 4 файлов в одной пачке):
   - Путь:строка, текст комментария.
   - Опции (single-select):
     - **Создать `docs/todos/<YYYY-MM-DD>-<slug>.md` и заменить `// TODO:` на `// Pending: docs/todos/<file>`** (Recommended) — скилл сам создаёт документ из `docs/todos/TEMPLATE.md` (или встроенного шаблона, если templates нет), просит подтвердить slug, открывает редактор полей через follow-up вопрос если нужно. После — заменяет маркер в коде.
     - **Удалить TODO** — этот TODO не нужен, доделать сейчас не успеваем, но и tracking не требуется (редкий случай: маркер был артефактом черновика). Скилл удаляет строку из staged-файла, перестейджит.
     - **Я уже создал `docs/todos/<...>` для этого** — пользователь укажет имя файла; скилл проверит `Glob`, что файл реально существует, и предложит заменить `// TODO:` на `// Pending: docs/todos/<...>`.
     - **Override (закоммитить как есть)** — намеренный override (legacy code, технический долг по решению команды). Скилл коммитит, но **в commit body** добавляет строку `Refs: deferred-work-override <count> TODO(s) — see TODO listing below` со списком файл:строка. Это оставляет след в истории.
D4. Если в качестве варианта выбран override — **не повторять** этот вопрос для других TODO в том же коммите (батч-override), но всё равно перечислить их в commit body.
D5. Если выбрано «создать docs/todos» хотя бы для одного TODO — **до** stage:
   - `Write` файл `docs/todos/<YYYY-MM-DD>-<slug>.md` по шаблону (см. глобальный CLAUDE.md или `docs/todos/TEMPLATE.md`).
   - Обновить `docs/todos/INDEX.md` (создать с шапкой, если нет).
   - `Edit` исходный файл: `// TODO: <comment>` → `// Pending: docs/todos/<YYYY-MM-DD>-<slug>.md` (один anchor на todo, в самой важной точке).
   - Добавить новые `docs/todos/...` к stage этого же коммита.
D6. После применения вариантов — заново прогнать grep шага D1 и убедиться, что либо TODO нет, либо все оставшиеся имеют `// Pending:` anchor с валидным путём.

### Edge cases

- **Не Kotlin/JS/Python проект.** Расширения уточнить по диффу — скан должен покрыть актуальный стек. Если тип файла неожиданный — спросить пользователя (`AskUserQuestion`), считать ли его «code».
- **TODO в комментариях документации (`.md`)** — НЕ проверяется (TODO в задачнике это нормально). Глобирование выше явно ограничено code-расширениями.
- **TODO существовал и до этой сессии** (контекст диффа `^ ` без `^\+`) — НЕ проверяется. Скан только новых маркеров: префикс `^\+` в diff (новые строки коммита).
- **Перенесённый TODO** (move from file A to file B без изменения) git показывает как `+` в B и `-` в A — будет ложное срабатывание. Спросить пользователя, если он подтвердит «это перенос», override.
- **Тесты с `@Ignore("TODO ...")` / `@Test fun todo_implement_X()`** — в test-файлах допускается, не блокировать. Шаг D1 grep'а должен исключить файлы под `*Test.kt`, `*test*.py`, `__tests__/`.

### Why

Прецедент 2026-05-12 (NavRail OfferTimerCard Desktop UI): solution doc + memory зафиксировали задачу как «COMPLETED», в коде остался `// TODO: render com.example.ui.banner.OfferTimerCard above CreditsCard when OneTimeOfferRepository.activeTimer is exposed`. Detekt-конфиг проекта (`default-detekt-config.yml`) запрещает `TODO:`, но convention plugin'ы для commonMain в этом репо не запускают detekt-таску → маркер прошёл в main. Через 1 день пользователь столкнулся с симптомом «таймер не появляется в нав-рейле после закрытия оффера» — потратил время на разбор. Скан на этапе `/commit` ловит такие случаи **до** того, как они уходят в историю.

## Deploy reminders

Some changes require a manual deploy step **after** commit — `git push` alone won't put them in production. Inspect the staged diff: if it matches a pattern below, append a single-line warning to the user **after** the commit succeeds.

| File pattern in diff | Print this warning |
|---|---|
| `firebase-functions/**/*.py` (or any path that resolves to Firebase Cloud Functions source) | `⚠️ This commit touches Cloud Functions. Push alone does not deploy — there is no CI for them. Run `firebase deploy --only functions:<list>` from repo root, then smoke-test with `curl -i -X OPTIONS <function-url>` (expect 204 + Access-Control-Allow-Origin).` |

**Why this exists:** on 2026-05-08 a CORS fix sat in `firebase-functions/main.py` for days while prod kept serving the stale binary, because no one re-ran `firebase deploy`. wasmJs `register_user` kept failing → onboarding looped on every page refresh. The diagnostic was 200 ms (`curl -X OPTIONS`), but the gap was a missing reminder. See `docs/solutions/runtime-errors/cloud-functions-cors-deploy-skew-2026-05-08.md` (in the affected repo).

**How to use:** the table is short on purpose. Add a new row only when a real deploy/CI gap is observed in a project — not preemptively. False-positive warnings train the user to ignore them.

## Result Output

After a successful commit, run these two commands and display the output verbatim — git's built-in colors handle the formatting:

```bash
git log -1 --pretty=format:"%C(yellow bold)%h%Creset → %C(cyan)%D%Creset%n%n%C(white bold)%s%Creset%n%b" HEAD
git diff --stat --color=always HEAD~1 HEAD
```

This gives: yellow hash + cyan branch, bold commit message, green/red file stats. No extra prose needed — the output speaks for itself.
