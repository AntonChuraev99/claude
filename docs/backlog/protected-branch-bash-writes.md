---
title: "Protected-branch guard: закрыть запись в транк через Bash"
date: 2026-08-04
status: backlog
area: hooks
keywords: [protected-branch, hooks, PreToolUse, bash, git, worktree, MR]
---

# Запись в защищённую ветку мимо файловых инструментов

## Что уже закрыто (2026-08-04)

`hooks/protected-branch-guard.ps1` перехватывает `Write`/`Edit`/`MultiEdit`/`NotebookEdit` (matcher `(?i)^(write|.*edit)$`) и возвращает `ask`. `/commit` шаг 0 и условие (6) auto-commit в `/task-gate` не дают закоммитить в транк. Полностью: `improvements/2026-08-04-protected-branch-guard.md`.

## Что осталось открытым

Правило соблюдается формально — Write/Edit не вызывались, — а код в транке:

1. **Запись через `Bash`.** `cat > f <<EOF`, `sed -i`, `tee`, `Set-Content`, `git apply`, `git checkout <ref> -- path`. На `Bash` висит только `credentials-guard` (деплой/публикация), путей записи он не смотрит.
2. **История через `Bash`.** `git merge`, `git cherry-pick`, `git revert`, `git rebase` в транк. `/sync-local-develop` от локального merge в транк уже отговорён (шаг 2a), но это текст команды, а не гейт.
3. **Фоновые субагенты.** `run_in_background: true` не наследует PreToolUse вовсе. Закрыто процедурно: правило `no-code-on-protected-branch` в `review-rules/process-gate.yaml` + проверка ветки в `agents/doc-writer.md` + пункт 12 чеклиста `subagent-authoring`. Хука по-прежнему нет.
4. **Детектор деградации.** Хук fail-open по всей длине (`catch { exit 0 }`). Битый реестр, отсутствующий `pwsh`, таймаут 10 c — правило выключается молча. Replay 2026-08-18 не отличит «ни разу не понадобился» от «сломан и не звал».

## Почему отложено

Пункты 1-2 — второй PreToolUse-хук на `Bash` с разбором команды: парсинг редиректов и git-подкоманд, отдельная матрица ложных срабатываний (чтение через `cat`, `git checkout -b`, работа вне репозитория). Это своя задача с собственной приёмкой, а не довесок. Практический риск ниже, чем у файловых правок: у агента есть `Write`/`Edit`, и через `sed -i` он правит код редко.

Пункт 4 дешевле остальных: одна строка в `~/.claude/stats/` из `catch`-ветки.

## Триггер к работе

Любое из: замечена правка кода в транке, прошедшая мимо хука; Replay 2026-08-18 показал нулевые срабатывания при явно бывших правках (подозрение на пункт 4); появился второй похожий guard, под который логично слить общий разбор `Bash`.
