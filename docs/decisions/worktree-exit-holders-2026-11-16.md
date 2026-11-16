---
title: "Каталог worktree после ExitWorktree на Windows: держатели и отложенная уборка"
summary: "ExitWorktree в половине сессий оставлял каталог; держателей теперь пишет PostToolUse-хук, а сносит скрытый отложенный уборщик через WMI."
date: 2026-11-16
type: bug-fix
modules: [hooks, task-gate]
keywords: [ExitWorktree, worktree, could not remove, Windows, handle, PEB, WMI, worktree-exit-watch, squash, discard_changes]
project: claude
---

# Каталог worktree остаётся после `ExitWorktree` на Windows

**Суть:** каталог держат процессы, которые сессия запустила в worktree и не остановила до выхода. Перед `ExitWorktree` останови свои фоновые задачи, `Monitor`, Playwright и дождись субагентов. Оставшийся каталог ловит `hooks/worktree-exit-watch.ps1`: пишет держателей в `~/.claude/stats/worktree-holders.jsonl` и сносит каталог отвязанным процессом. Процедура — `skills/task-gate/references/mr-merge.md` → «Уборка».

## Проблема / Контекст

«could not remove it — kept at …» — в 105 сессиях из 210. Каталог оставался чаще с dev-server (68% против 38%) и Playwright (66%); с Gradle связи нет (источник: разбор JSONL-транскриптов профиля в сессии 2026-11-16). Держатель базовых 38% неизвестен. Баги процедуры, baseline и target — `improvements/2026-11-16-worktree-exit-holders.md`.

## Решение

1. `hooks/worktree-exit-watch.ps1`, PostToolUse `ExitWorktree`:
   - каталога нет → строка `outcome: removed`;
   - каталог остался → держатели: текущий каталог процесса (PEB через `NtQueryInformationProcess` и `ReadProcessMemory`, без прав администратора), исполняемый файл или командная строка внутри каталога, открытые файлы (Restart Manager по файлам, оставшимся в каталоге); цепочка родителей и пометка `in_session`;
   - уборщик (тот же скрипт с `-Cleanup`) через WMI `Win32_Process.Create`, `ShowWindow=0`: каждые 15 с, до 10 минут, по правилам `worktree-shell-sweep`;
   - держатели — агенту в контекст; чужие процессы хук не убивает.
2. Step 6 (`skills/task-gate/SKILL.md`, `references/mr-merge.md`): освободить каталог до выхода, `discard_changes: true` сразу после `MERGED`, `git branch -D`, `--auto` — по ответу `gh pr checks --required`.

## Почему именно так

- **Сначала диагностика:** держатель части случаев неизвестен; лог закрывает пробел без ручных команд.
- **WMI:** процесс от WmiPrvSE вне job-объекта сессии и переживает её выход. Окружение хука до него не доходит — путь лога идёт параметром `-LogFile`.
- **stdin в UTF-8 явно:** иначе кавычка `”` из ответа тула прилипает к пути, и хук считает каталог удалённым.
- **Без убийства процессов:** ошибка стоила бы пользователю IDE или чужого dev-server.

## Связанные файлы

- `hooks/worktree-exit-watch.ps1`, `hooks/worktree-exit-watch.tests.ps1`
- `hooks/worktree-shell-sweep.ps1` — страховка на SessionStart
- `skills/task-gate/references/mr-merge.md`
- `improvements/2026-11-16-worktree-exit-holders.md`
