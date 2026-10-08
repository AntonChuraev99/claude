---
date: 2026-10-08
slug: harness-latency-fixes
status: applied
goal: убрать два источника лишней задержки, найденные по транскриптам — непропатченный warp 2.3.0 и отказы Bash в worktree-сессиях
metric: медиана хука warp PostToolUse; число отказов «too complex to verify» на worktree-сессию
baseline_date: 2026-10-08
target_date: 2026-10-22
---

# Задержки харнесса: warp 2.3.0 и отказы Bash в worktree

## Цель

Аудит транскриптов за 2026-10-06..08 (`scripts/hook-timeouts-report.py`, `scripts/session-stages.py` и разовый разбор длительности tool call) нашёл две проблемы на стороне харнесса.

1. Плагин warp обновился до 2.3.0. `hooks/ensure-warp-perf-patch.js` знал только 2.1.0 и 2.2.0 и оставил новую версию без патча. В итоге каждый вызов инструмента снова платит за медленный хук, а у хуков плагина нет таймаута.
2. Claude Code отклоняет в worktree-сессии каждую Bash-команду, которую не может проверить статически («too complex to verify that it stays inside the worktree»). Модель пишет такие команды по привычке обычного checkout.

## Baseline (2026-10-08)

- warp `on-post-tool-use.sh`: 11 005 запусков за 2 дня, в сумме 8065 с, медиана 0,62 с, максимум 44,7 с. Один таймаут `UserPromptSubmit` на 30 с (у хуков 2.3.0 нет поля `timeout`). Стенд, 8 прогонов: оригинал 2.3.0 — 586 мс, с патчем — 141 мс, вывод `tool_complete` совпадает побайтно.
- Отказы worktree-проверки (отдельный разбор, окно шире — 2026-10-05..08): 218, около 15 на worktree-сессию, 49% всех ошибок Bash. Типичные отказанные формы: переменные (`S=...; cmd "$S/x"`), `cd … &&`, `$(…)`, `$?`, подоболочки, `{ …; } > file`, циклы, heredoc.

## Гипотеза

1. Патч на 2.3.0 подходит без изменений. Против 2.1.0 версия добавляет только matcher `agent_needs_input` (его сохраняет `patchHooksJson`), новый `on-stop-failure.sh` (он уже есть в патче) и обрезку текста уведомления до 120 символов (её добавляет локальный `notify.jq`).
2. Текстовое правило в `CLAUDE.md` модель не видит в момент, когда пишет команду. Подсказка нужна в тот момент, когда сессия становится изолированной: на старте внутри worktree, после `EnterWorktree` и на старте каждого субагента в worktree (субагент не видит контекст родителя).

## Изменения

- `hooks/ensure-warp-perf-patch.js` — `2.3.0` добавлен в `KNOWN_VERSIONS`.
- `hooks/worktree-bash-hint.js` (новый) и `hooks/worktree-bash-hint.tests.js` (9 кейсов) — только `additionalContext`, без решений. События: `SessionStart` и `SubagentStart`, если cwd внутри `.claude/worktrees/<name>`, и `PostToolUse` с matcher `EnterWorktree`.
- `settings.example.json` — регистрация хука на трёх событиях.
- Вне репозитория (локально): `patches/warp-perf/scripts/notify.jq` — обрезка текста уведомления до 120 символов, как в 2.3.0.

## Target

- warp PostToolUse: медиана ≤ 0,25 с, ни одного таймаута хуков warp.
- Отказы «too complex to verify»: ≤ 3 на worktree-сессию (сейчас около 15).

## Replay (заполняется через N дней)

<!-- 2026-10-22: `python scripts/hook-timeouts-report.py --days 7`; медиана warp — тем же разбором attachment `hook_success` по command; отказы — счёт tool_result с текстом «isolated in the worktree» на сессию. -->
