# Backlog — `~/.claude`

Отложенное по своей воле: полировка, техдолг, идеи по глобальным правилам и агентам. Внешней блокировки нет — запись берут руками, когда решили заняться.

Заблокированное внешним событием с проверяемым триггером сюда не кладём — для этого `docs/todos/` (правила — `~/.claude/rules/docs-structure.md`).

## Open

| дата | запись | область | суть |
|---|---|---|---|
| 2026-08-27 | [delegation-rule-enforcement-hook](delegation-rule-enforcement-hook.md) | hooks / CLAUDE.md | правило «прод-код пишет специалист» починено текстом, принуждения нет: `PreToolUse`-счётчик правок кода главного отложен решением пользователя; триггер — replay improvement'а 2026-09-10, если среднее вызовов специалистов на сессию не вернулось к ≥ 2.0 |
| 2026-08-21 | [powershell-search-flank](powershell-search-flank.md) | hooks | запрет текстового поиска висит на `matcher: "Bash"`, а `Select-String` в PowerShell проходит мимо: метрика «code-grep через Bash» зазеленеет от одного перетекания — replay обязан сначала сравнить PowerShell-поиски |
| 2026-08-19 | [gradle-daemon-sprawl](gradle-daemon-sprawl.md) | build | глобальный `~/.gradle/gradle.properties` перебил проектные jvmargs, но в репозиториях остались `-Xmx16g` на 15.6 GB машине, `daemon=false` и пять разных версий Gradle — демон привязан к версии, унификацией args это не лечится |
| 2026-08-19 | [hook-refactor-followups](hook-refactor-followups.md) | hooks | Хвосты рефакторинга hook-слоя: PR в warpdotdev/claude-code-warp (#77) решено не отправлять; находки ревью MEDIUM/LOW (рассинхрон fallback-списка с JSON, `permissions.allow` против гарда, `CLAUDE_CONFIG_DIR`); `async: true`; пункт 10 (оперативка как причина спайков спавна) закрыт → [gradle-daemon-sprawl](gradle-daemon-sprawl.md) |
| 2026-08-04 | [protected-branch-bash-writes](protected-branch-bash-writes.md) | hooks | PreToolUse-гард видит только файловые инструменты: запись в транк через `Bash` (`cat >`, `sed -i`, `git apply`) и правки фоновых субагентов проходят мимо |

## Done

| дата | запись | итог |
|---|---|---|
| 2026-08-03 | [review-rules-noise-reduction](review-rules-noise-reduction.md) | закрыто 2026-08-31: в детектор добавлен `requires`, 12 правил сужены (4 оставлены сознательно — high severity либо нет файлового маркера контекста); триггер L2 сужен до находки `static` (runtime дал 0 блокировок на 5202 прогона); автогигиена «Прополка» в `stats.py` + поле `narrowed_since`, чтобы правило судилось по нынешней форме. Замер — Replay improvement'а 2026-09-14 |
| 2026-08-05 | [subagents-get-no-mcp-tools](subagents-get-no-mcp-tools.md) | субагент получает MCP только при трёх условиях сразу: сервер подключён в профиле + транспорт `stdio` + объявлен и в `mcpServers:`, и в `tools:`. Раскатано на 12 агентов, подтверждено живыми вызовами (context7 в `~/.claude`, atlassian в `claude-work`). Осталось: проверить context7 в рабочем профиле после рестарта |
| 2026-08-03 | [subagent-docs-ship-with-mr](subagent-docs-ship-with-mr.md) | вариант B: `DOCS_WRITTEN:` от `@doc-writer` + проверка 2.7b в `/task-gate`; hard scope субагентов не тронут |
