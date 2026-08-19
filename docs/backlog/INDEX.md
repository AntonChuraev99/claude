# Backlog — `~/.claude`

Отложенное по своей воле: полировка, техдолг, идеи по глобальным правилам и агентам. Внешней блокировки нет — запись берут руками, когда решили заняться.

Заблокированное внешним событием с проверяемым триггером сюда не кладём — для этого `docs/todos/` (правила — `~/.claude/rules/docs-structure.md`).

## Open

| дата | запись | область | суть |
|---|---|---|---|
| 2026-08-19 | [hook-refactor-followups](hook-refactor-followups.md) | hooks | Хвосты рефакторинга hook-слоя: PR в warpdotdev/claude-code-warp (#77) решено не отправлять, находки ревью уровня MEDIUM/LOW (рассинхрон fallback-списка с JSON, `permissions.allow` против гарда, `CLAUDE_CONFIG_DIR`), `async: true` и Defender-исключения |
| 2026-08-04 | [protected-branch-bash-writes](protected-branch-bash-writes.md) | hooks | PreToolUse-гард видит только файловые инструменты: запись в транк через `Bash` (`cat >`, `sed -i`, `git apply`) и правки фоновых субагентов проходят мимо |
| 2026-08-03 | [review-rules-noise-reduction](review-rules-noise-reduction.md) | review-rules | 98 runtime-правил дают тысячи срабатываний при est-FP 88-100%; прополоть, сменить триггер L2 с «L1 непуст», добавить автогигиену в stats.py |

## Done

| дата | запись | итог |
|---|---|---|
| 2026-08-05 | [subagents-get-no-mcp-tools](subagents-get-no-mcp-tools.md) | субагент получает MCP только при трёх условиях сразу: сервер подключён в профиле + транспорт `stdio` + объявлен и в `mcpServers:`, и в `tools:`. Раскатано на 12 агентов, подтверждено живыми вызовами (context7 в `~/.claude`, atlassian в `claude-work`). Осталось: проверить context7 в рабочем профиле после рестарта |
| 2026-08-03 | [subagent-docs-ship-with-mr](subagent-docs-ship-with-mr.md) | вариант B: `DOCS_WRITTEN:` от `@doc-writer` + проверка 2.7b в `/task-gate`; hard scope субагентов не тронут |
