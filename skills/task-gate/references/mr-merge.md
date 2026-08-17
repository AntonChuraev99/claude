# MR & Merge — Step 6

Extract из Step 6 `task-gate/SKILL.md`. Точные команды, гарды и обработка отказов для доведения задачи до **влитого** MR/PR.

## Принцип

Задача закрыта не коммитом и не открытым MR, а изменением в транке (`CLAUDE.md` → «Git-коммиты», «Защищённая ветка и worktree»). Пользователь подтверждает результат один раз — по отчёту gate; дальше вся цепочка push → MR → merge → уборка идёт без дополнительных вопросов. Спрашивать разрешение на каждый шаг — это возврат ручного режима, ради ухода от которого правило и вводилось.

## Разрешение

**Считается подтверждением:** «да», «готово», «подтверждаю», «мержи», «всё верно», «ок, вливай» — сказанные **после** отчёта gate, в ответ на строку `Подтверди результат — дальше сам: push → MR → merge…`.

**НЕ считается:** молчание; «спасибо»; переход к новой задаче; «посмотрю позже»; подтверждение, сказанное ДО прогона gate («да делай» в начале задачи); подтверждение отдельного шага («да, закоммить») — оно закрывает только этот шаг.

**Отзывается** любой репликой про недостаток («а вот тут поправь», «стоп», «не мержи»). Отозвано → Step 6 не запускается до нового подтверждения по новому отчёту gate.

## Гард-условия (ВСЕ одновременно)

| # | Условие | Проверка |
|---|---|---|
| 1 | Вердикт Step 5 — `READY` / `READY WITH WARNINGS`, ни одного `❌` | результат Step 5 |
| 2 | Ветка не защищённая | `git rev-parse --abbrev-ref HEAD` + реестр `~/.claude/config/protected-branches.local.json` |
| 3 | Рабочее дерево чистое | `git status --porcelain` пусто |
| 4 | Validation (2.1) не `❌` | билд/тесты не падали |
| 5 | Репозиторий не профильный | не `~/.claude`, не `~/.claude-work` |
| 6 | Пользователь не запрещал merge в этой сессии | «MR сделаю сам», «пока не вливай» |
| 7 | Есть подтверждение | см. выше |

Не выполнено любое → Step 6 стоп, строка в отчёт с причиной. Гард 2 или 3 — это ещё и сигнал, что задача велась мимо worktree-правила; чинится до merge, а не после.

## Деплой-предупреждение

Merge в транк на проекте с CI-деплоем = выкатка пользователям. Признаки, которые проверяются в 5.1a:

- `.gitlab-ci.yml` — job с `only`/`rules` на транк и стадией deploy/publish;
- `.github/workflows/*.yml` — `on: push: branches: [<trunk>]`;
- `wrangler.jsonc` / `wrangler.toml` + Cloudflare Workers Builds на транке;
- Vercel/Netlify production branch = транк.

Нашлось → строка `⚠️ merge в <транк> запускает деплой <куда>` печатается **в отчёте gate**, до подтверждения. Пользователь подтверждает, уже зная это. Молча влить деплоящийся транк нельзя — это класс «деплой без сверки» из L3 process-gate.

Сверка аккаунта деплоя (`credentials-guard`, `~/.claude/config/project-credentials.local.md`) остаётся обязательной там, где деплой запускается локально; merge отдаёт выкатку CI, но расхождение аккаунта в CI-переменных агент не видит — если проект в реестре, назвать это в той же строке.

## Команды

Платформа определяется по `git remote get-url origin`: `gitlab` → glab, `github` → gh.

### Push

```bash
git push -u origin "$(git rev-parse --abbrev-ref HEAD)"   # апстрима нет
git push                                                   # апстрим уже есть
```

Push отклонён (non-fast-forward) → транк ушёл вперёд: `git fetch origin && git rebase origin/<trunk>`, прогнать билд заново, потом push. `--force-with-lease` допустим только на своей неслитой ветке; `--force` — нет.

### MR / PR

MR уже открыт (5.1a) — переиспользовать, не создавать второй.

```bash
# GitLab
glab mr create --fill --remove-source-branch --target-branch <trunk>
# GitHub
gh pr create --fill --base <trunk>
```

`--fill` берёт заголовок и тело из коммитов ветки. Есть активный документ задачи (`docs/active/...` или уже заархивированный) → дописать ссылку в тело (`glab mr update <iid> --description`, `gh pr edit <num> --body`). Документы задачи обязаны быть в этой же ветке — это проверяет 2.7b.

### Merge

```bash
# GitLab: squash + auto-merge (влить, когда pipeline станет зелёным)
glab mr merge <iid> --squash --auto-merge --remove-source-branch --yes

# GitHub: squash + auto-merge
gh pr merge <num> --squash --auto --delete-branch
```

Проверено 2026-08-10: glab 1.81.0, gh 2.88.1. `--when-pipeline-succeeds` в glab больше нет — GitLab 16.0 переименовал «merge when pipeline succeeds» в «auto-merge», флаг стал `--auto-merge`; при запущенном pipeline glab включает auto-merge по умолчанию, немедленный merge — `--auto-merge=false`. Стратегия по умолчанию — **squash**: одна задача = один коммит в транке, ревертится целиком.

Pipeline в проекте отсутствует → те же команды без `--auto-merge` / `--auto` (иначе gh уходит в ожидание проверок, которых не будет).

### Дождаться результата

```bash
glab mr view <iid>                                  # State: merged
gh pr view <num> --json state,mergedAt -q '.state'  # MERGED
```

Merge, поставленный в очередь по CI, **не** является «влито». Дождаться терминального состояния; ожидание длинное → сказать об этом и вернуть контроль, не заявляя завершение.

## Отказы

| Ситуация | Действие |
|---|---|
| Красный pipeline | `❌ merge failed: pipeline red` + ссылка на job. Чинить причину. **Запрещено**: мержить в обход CI, `--admin`, отключать джобу, ретраить в надежде на flaky без разбора |
| Конфликт с транком | `git fetch origin && git rebase origin/<trunk>`, конфликты разрешить, билд прогнать заново, push. Не мержить транк в ветку, если в проекте линейная история |
| Нужен approval / protected branch rule | `⚠️ merge blocked: требуется approval` + ссылка на MR в блок `## 👉 Сделай руками`. Обходить правило approval нельзя |
| `gh` / `glab` не установлен или не авторизован | `gh auth status` / `glab auth status`. Не авторизован → MR не создавать вслепую: ссылка на веб-форму создания MR в блок ручных шагов |
| Remote — не GitHub и не GitLab | Ручной шаг: push сделан, ссылка на создание MR в UI |
| MR влит, но CI на транке покраснел после merge | Сообщить сразу, предложить revert (`git revert -m 1 <merge-sha>` либо revert squash-коммита) — не оставлять транк красным молча |

## Уборка (только после подтверждённого merge)

```bash
git push origin --delete <branch>   # если не сняли флагом --remove-source-branch / --delete-branch
```

Дальше — **выход из worktree тулом, а не `git worktree remove`**: сессия стоит внутри каталога, и снести его, не сменив CWD, нельзя (на Windows каталог просто залочен).

| Как заводили worktree | Уборка |
|---|---|
| `EnterWorktree({name})` в этой сессии | `ExitWorktree({action: "remove"})` — возвращает CWD, сносит каталог и локальную ветку |
| вошли по `EnterWorktree({path})` / worktree из прошлой сессии | `ExitWorktree({action: "keep"})`, затем из главного checkout `git worktree remove <путь>` и `git branch -d <branch>` (`-d`, не `-D`: проверяет, что ветка влита) |

`ExitWorktree` отказал с «commits not on the original branch» — после **squash**-merge это ожидаемо: squash кладёт в транк новый sha, коммитов ветки там буквально нет. Merge подтверждён (есть `Merged: <sha>`) → повторить с `discard_changes: true`. Merge не подтверждён → раздел «Отказы», ничего не сносить.

Отказ на незакоммиченных файлах → в worktree осталась несохранённая работа: `discard_changes` **не** ставить, показать `git status` пользователю. `git branch -d` отказывается → ветка не влита, merge не состоялся — раздел «Отказы».

```bash
git -C <main-checkout> checkout <trunk> && git -C <main-checkout> pull
```

## Отчёт

```
🔀 Merge:
   MR:      <url>
   Merged:  <sha в транке> (squash)
   Cleanup: remote branch + worktree + local branch removed
   Deploy:  <triggered: Cloudflare production | none>
```
