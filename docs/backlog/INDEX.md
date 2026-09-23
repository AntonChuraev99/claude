# Backlog — `~/.claude`

Отложенное по своей воле: полировка, техдолг, идеи по глобальным правилам и агентам. Внешней блокировки нет — запись берут руками, когда решили заняться.

Заблокированное внешним событием с проверяемым триггером сюда не кладём — для этого `docs/todos/` (правила — `~/.claude/rules/docs-structure.md`).

## Open

| дата | запись | область | суть |
|---|---|---|---|
| 2026-08-27 | [delegation-rule-enforcement-hook](delegation-rule-enforcement-hook.md) | hooks / CLAUDE.md | правило «прод-код пишет специалист» починено текстом, принуждения нет: `PreToolUse`-счётчик правок кода главного отложен решением пользователя; триггер — replay improvement'а 2026-09-10, если среднее вызовов специалистов на сессию не вернулось к ≥ 2.0 |
| 2026-08-21 | [powershell-search-flank](powershell-search-flank.md) | hooks | запрет текстового поиска висит на `matcher: "Bash"`, а `Select-String` в PowerShell проходит мимо: метрика «code-grep через Bash» зазеленеет от одного перетекания — replay обязан сначала сравнить PowerShell-поиски |
| 2026-08-19 | [hook-refactor-followups](hook-refactor-followups.md) | hooks | Хвосты рефакторинга hook-слоя: PR в warpdotdev/claude-code-warp (#77) решено не отправлять; находки ревью MEDIUM/LOW (рассинхрон fallback-списка с JSON, `permissions.allow` против гарда, `CLAUDE_CONFIG_DIR`); `async: true`; пункт 10 (оперативка как причина спайков спавна) закрыт → [gradle-daemon-sprawl](gradle-daemon-sprawl.md) |

## Done

| дата | запись | итог |
|---|---|---|
| 2026-09-03 | [harness-third-party-skills-cleanup](harness-third-party-skills-cleanup.md) | закрыто 2026-09-23 по замеру 09-03…09-23: дубли Cloudflare ×7 и caveman ×4 удалены, 6 мёртвых без ссылок из агентов и скиллов — `skillOverrides: "off"`, 11 мёртвых со ссылками оставлены (скрытие снимает и вызов), ASO-пакет переведён на junction'ы; `warp` и Chrome по умолчанию оставлены решением пользователя |
| 2026-08-19 | [gradle-daemon-sprawl](gradle-daemon-sprawl.md) | отменено 2026-09-23 решением пользователя: остаток живёт в проектных репозиториях, голод памяти 09-21 — commit-исчерпание, не jvmargs; запись оставлена справочником ловушек |
| 2026-08-04 | [protected-branch-bash-writes](protected-branch-bash-writes.md) | закрыто 2026-09-23: fail-open `catch` обоих guard-хуков пишет в `stats/hook-degraded.log`; разбор Bash-команд и сужение детекта credentials-guard — не делаем без инцидента |
| 2026-08-03 | [review-rules-noise-reduction](review-rules-noise-reduction.md) | закрыто 2026-08-31: в детектор добавлен `requires`, 10 правил сужены (6 остаются кандидатами — у двух сужение откачено ревью, оно глушило сам баг); триггер L2 сужен до находки `static` (runtime дал 0 блокировок на 5202 прогона); автогигиена «Прополка» в `stats.py` + `narrowed_since`, у сужённых критерий — объём, а не FP. Замер — Replay improvement'а 2026-09-14 |
| 2026-08-05 | [subagents-get-no-mcp-tools](subagents-get-no-mcp-tools.md) | субагент получает MCP только при трёх условиях сразу: сервер подключён в профиле + транспорт `stdio` + объявлен и в `mcpServers:`, и в `tools:`. Раскатано на 12 агентов, подтверждено живыми вызовами (context7 в `~/.claude`, atlassian в `claude-work`). Осталось: проверить context7 в рабочем профиле после рестарта |
| 2026-08-03 | [subagent-docs-ship-with-mr](subagent-docs-ship-with-mr.md) | вариант B: `DOCS_WRITTEN:` от `@doc-writer` + проверка 2.7b в `/task-gate`; hard scope субагентов не тронут |
