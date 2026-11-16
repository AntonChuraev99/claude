---
name: commit
description: Create a Conventional Commits compliant git commit. Use this skill whenever the user says "commit", "create a commit", "git commit", "зафиксируй изменения", "сделай коммит", or asks to commit staged or unstaged changes. Stages relevant files and crafts a properly scoped commit message automatically.
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git rev-parse:*), Bash(git stash:*), Bash(git worktree:*), Bash(python ~/.claude/skills/task-gate/scripts/gate-prep.py:*)
---

# Git Commit — Conventional Commits

Create a well-formed git commit following the [Conventional Commits](https://www.conventionalcommits.org/) specification.

## Steps

0. **Защищённая ветка — до всего остального.** `git rev-parse --abbrev-ref HEAD`. Ветка защищена (`main`, `master`, `develop`, `release/*`; точный список проекта — `~/.claude/config/protected-branches.local.json`, ключ `repos.<путь>.protected`) → **не коммитить**, вынести развилку через `AskUserQuestion`:
   - *(Recommended)* перенести правки в отдельную ветку: WIP-коммит либо `git stash push -u -m "<тег>"` с SHA записи из `git stash list --format='%H %gs'` → `EnterWorktree({name: "<type>/<slug>"})` (тул переключает CWD сессии в worktree; `git worktree add` этого не делает) → `git stash apply <sha>` уже в worktree и `git stash drop` своей записи (найти по тегу) → коммит там → push + MR/PR. Голый `git stash`/`pop` нельзя: stash общий для всех сессий;
   - согласованный hotfix — коммитить в транк как есть.

   Без вопроса продолжать, если: каталог вне git; ветка не защищена; пользователь уже в этой сессии подтвердил работу в транке.

1. Run `git status` to see what has changed.
2. Run `git diff` (unstaged) and `git diff --staged` (staged) to understand the actual changes.
3. Run `git log --oneline -5` to match the style of recent commits in this project.
4. Decide which files belong in this commit — skip build artifacts, caches, lock files unless explicitly changed on purpose.
4a. **Deferred-work scan** (see `## Deferred-work scan` ниже) — блокирует stage, если в коммите есть `// TODO:` / `// FIXME:` / `// STOPSHIP:` без соответствующего `docs/todos/<...>.md`.
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

Перед stage'ом — новые `// TODO:` / `// FIXME:` / `// STOPSHIP:` в файлах, которые войдут в коммит (staged + unstaged + новые):

```bash
python ~/.claude/skills/task-gate/scripts/gate-prep.py --todo-only
```

`todo.status`: `clean` или `anchors_valid` → идти к шагу 5 (Stage files). `unbacked` или `broken_anchor` → не stage'ить, процедура — `~/.claude/skills/task-gate/references/deferred-work-scan.md` → «Действие при unbacked TODO» (вопрос на файл, создание `docs/todos/<...>.md` и якоря `// Pending:`, override строкой в теле коммита). После правок — повторить скан. Скан и процедура живут в одном месте, `/task-gate` 2.8 использует те же.

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
