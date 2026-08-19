# Выключенные возможности (плагины и MCP)

Реестр того, что стоит в харнессе, но **отключено ради контекста и скорости**. Descriptions скиллов
и схемы MCP-тулов включённых плагинов едут в системном промпте КАЖДОГО turn и каждого субагента —
поэтому набор, которым не пользуются, выключен, а не удалён.

**Правило для агента:** задача упёрлась в возможность из таблицы — не отказывать и не искать обход.
Назвать пользователю точную строку включения из колонки «Включить» и сказать, что нужен рестарт
сессии. Включает пользователь, не агент.

Замер использования — по транскриптам `~/.claude/projects/**/*.jsonl` за 2026-08-01…08-19
(2097 файлов): считались реальные вызовы `mcp__<server>__*` и `Skill(...)`, не упоминания.

## Выключено 2026-08-19

| Возможность | Что даёт | Использований за 3 недели | Включить |
|---|---|--:|---|
| `vercel@claude-plugins-official` | ~30 скиллов (Next.js, AI SDK, деплой Vercel), MCP `vercel` | 0 MCP, 0 скиллов | `settings.json` → `enabledPlugins` → `true` |
| `figma@claude-plugins-official` | MCP Figma (~30 тулов: чтение дизайна, генерация файлов, Code Connect) + 12 скиллов | 0 MCP, 0 скиллов | там же |
| `skill-creator@claude-plugins-official` | создание и eval скиллов | 0 | там же |

Ранее выключенные (не этой ревизией): `code-simplifier`, `mcp-apps`, `voltagent-*`,
`claude-md-management`.

Скиллы Cloudflare выключены отдельно через `settings.json` → `skillOverrides` (`cloudflare`,
`wrangler`, `durable-objects`, `sandbox-sdk`, `web-perf`, `workers-best-practices`, `agents-sdk`),
сам плагин и его MCP остаются включёнными.

## Оставлено включённым — с цифрами

`claude-in-chrome` 4899 · `Amplitude` 950 · `mobile` 388 · `firebase` 110 · `context7` 94 ·
`appstore` 71 · `RevenueCat` 53 · `atlassian` 36 · `cloudflare-builds` 27 · `Gmail` 25 ·
`lazyweb` 8 · `sentry` 2 · `Slack` 2.

`compound-engineering` — 4 вызова скиллов за 3 недели (`ce-brainstorm`, `ce-plan`) при ~25 скиллах
в наборе. Кандидат на выключение следующим заходом, если частота не вырастет.

## Дубли MCP — отдельная тема

Один и тот же сервис подключён дважды, схемы тулов грузятся оба раза:

| сервис | standalone (`~/.claude.json` → `mcpServers`) | плагин |
|---|--:|--:|
| Amplitude | `Amplitude` — 950 | `plugin_amplitude_amplitude` — 84 |
| RevenueCat | `revenuecat` — 19 | `plugin_RevenueCat_RevenueCat` — 53 |
| context7 | `context7` — 94 | `plugin_context7_context7` — 1 |

Плюс `pencil` в `mcpServers` — 0 вызовов.

Не тронуто: standalone-серверы и плагины дают разные наборы тулов, слепое отключение любой из
половин рискует сломать рабочий сценарий. Разбирать по одному, сверяя, какие именно тулы вызывались.
