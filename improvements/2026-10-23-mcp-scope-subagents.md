---
date: 2026-10-23
slug: mcp-scope-subagents
status: applied
goal: снять с каждой сессии ~0,6 GB stdio-MCP, которые нужны одному агенту или редкому сценарию
metric: private-память MCP-дерева одной сессии вне Android; число MCP-процессов на сессию
baseline_date: 2026-10-23
target_date: 2026-11-06
---

# MCP только там, где нужен: inline `mcpServers` у агентов, `--mcp-config` по требованию

## Цель

16 GB RAM, 6 параллельных сессий Claude Code: свободно 0,5 GB, hard reads ~5,4k/s, система тормозит. Каждая сессия запускает полный набор stdio-MCP, даже в каталоге, где они не нужны (например, в `~/.claude`).

## Baseline (2026-10-23)

- 6 сессий = 13,1 GB private: на сессию `claude.exe` 0,6–0,8 GB + MCP 1,1–1,3 GB.
- MCP одной сессии: ARTEMIS (python) 495 MB, firebase-плагин 260–970 MB, layout-debug 130–230 MB, playwright 160–570 MB, mobile 60 MB, appstore 45 MB.
- layout-debug снова стоял user-scope в обоих профилях, хотя 2026-09-25 его сняли (`2026-09-25-mcp-memory-on-demand`): схема «`claude mcp add` перед работой, `remove` после» не удержалась.

## Исследование

- Ленивого старта stdio-MCP в Claude Code нет: сервер стартует с сессией и живёт до её конца (открытые feature request'ы в issue-трекере). `MCP_DISCOVERY_CACHE` откладывает подключение только удалённых HTTP/SSE. Tool search экономит контекст, а не процессы.
- Поле `mcpServers` субагента с inline-описанием: сервер подключается при старте субагента и отключается по завершении (code.claude.com/docs/en/sub-agents, «Scope MCP servers to a subagent»). Ссылка по имени (`- artemis`) переиспользует соединение главной сессии и память не экономит.
- `--mcp-config` добавляет серверы к основному конфигу на одну сессию и сочетается с `--continue` (code.claude.com/docs/en/cli-reference).

## Замеры проверки (Claude Code v2.1.309)

- `${USERPROFILE}` в inline-сервере субагента **не раскрывается**: процесс получает буквальный путь и падает (`Cannot find module '...\${USERPROFILE}\...'`). В файле `--mcp-config` тот же `${USERPROFILE}` раскрывается.
- Обход без приватного пути в публичном файле: `command: cmd`, `args: ['/c', ..., '%USERPROFILE%\...']` — путь раскрывает cmd. Проба `claude -p --agents`: ARTEMIS `ready`, `mobile` видит устройства, `appstore` отвечает; по завершении субагента у всех трёх `STDIO connection closed (cleanly)`, процессов-сирот нет. Хук `artemis-default-guard` в субагенте срабатывает как раньше.
- Inline-серверы агента из проектного `.claude/agents/` Claude Code пропускает, пока папке не дано доверие (`Skipping frontmatter MCP servers ... not trusted`). Агенты из `~/.claude/agents/` проверку доверия не проходят.

## Гипотеза

Сессия вне Android и маркетинга освобождается от artemis + mobile + appstore + layout-debug: ~0,6–0,8 GB на сессию, при 6 сессиях — 3,6–4,8 GB. Проверка на устройстве не страдает: процедура переехала в агента целиком, главный передаёт бриф.

## Изменения

- `agents/mobile-tester.md` — новый агент: процедура проверки на устройстве из `/mcp-mobile-test`, inline `artemis` + `mobile`.
- `commands/mcp-mobile-test.md` — главный выбирает устройство, ставит сборку, собирает бриф и спавнит `@mobile-tester`; строка включения ARTEMIS и `mobile` в главной сессии на одну сессию.
- `agents/marketing-expert.md` — inline `appstore`, `mcp__appstore__*` в `tools`, строка о сервере в «Метод».
- `config/mcp/device.json`, `config/mcp/layout-debug.json` — для `claude --continue --mcp-config`.
- `config/optional-capabilities.md` — секция «Перенесено 2026-10-23», старая строка layout-debug помечена заменённой.
- `.gitignore` — whitelist `config/mcp/*.json`.
- Вне репо: `claude mcp remove -s user` для `artemis`, `mobile`, `appstore`, `layout-debug` в обоих профилях; локальный скилл `layout-debug` — включение через `--mcp-config`.

firebase и playwright не тронуты: выключенный плагин убирает из сессии и скиллы (решение 2026-09-25 в `config/optional-capabilities.md`).

## Target

К 2026-11-06:
- MCP-дерево сессии вне Android ≤ 0,6 GB (остаются firebase и playwright);
- `/mcp-mobile-test` проходит через `@mobile-tester` без ручного включения серверов;
- layout-debug не появился снова в user-scope ни одного профиля.

## Replay (заполняется через N дней)
