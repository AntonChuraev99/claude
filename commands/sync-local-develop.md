---
description: Быстрый merge локальной ветки develop в текущую (без fetch, офлайн, мгновенно)
argument-hint: "[ветка-источник; по умолчанию develop]"
allowed-tools: Bash(git rev-parse:*), Bash(git status:*), Bash(git rev-list:*), Bash(git log:*), Bash(git merge:*), Bash(git diff:*), Bash(git branch:*)
---

Синхронизируй текущую git-ветку с **локальной** веткой-источником быстрым merge — **без `git fetch`** (офлайн, мгновенно; вливается только то, что уже скачано локально).

Ветка-источник: если в `$ARGUMENTS` передано имя ветки — используй его, иначе `develop`.

Действуй решительно и кратко, останавливайся только при реальной проблеме:

1. **Git-репо?** `git rev-parse --is-inside-work-tree`. Не репозиторий → сообщи и стоп.
2. **Текущая ветка** = `git rev-parse --abbrev-ref HEAD`. Если она совпадает с веткой-источником → «уже на `<src>`, синхронизировать нечего» и стоп.
3. **Источник существует локально?** `git rev-parse --verify --quiet refs/heads/<src>`. Нет → сообщи, что локальной ветки `<src>` нет; **НЕ делай fetch сам**; предложи `/sync-local-develop <имя-ветки>` или ручной `git fetch`, и стоп.
4. **Что вольётся** = `git rev-list --count HEAD..<src>`. Если 0 → «уже синхронизировано с локальным `<src>`» и стоп. Иначе покажи `git log --oneline --no-decorate HEAD..<src>` (до ~15 строк).
5. **Merge** = `git merge <src>`.
   - Успех → краткий итог: сколько коммитов влилось, fast-forward или merge-commit, новый `HEAD` (короткий sha + subject).
   - Git отказался из-за незакоммиченных изменений («would be overwritten») → **НЕ форсируй**: сообщи, предложи закоммитить или `git stash`, затем повторить `/sync-local-develop`.
   - Конфликт merge → **НЕ паникуй**: покажи `git diff --name-only --diff-filter=U` (конфликтующие файлы), скажи что merge на паузе, предложи разрешить вручную или `git merge --abort`.

Не выводи лишнего — цель максимально быстрая синхронизация.
