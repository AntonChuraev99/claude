# Выключенные возможности (плагины и MCP)

Реестр того, что стоит в харнессе, но **отключено или удалено ради контекста и скорости**, и почему.

**Что реально стоит контекста (Claude Code ≥ 2.1.232, Tool Search включён по умолчанию):** схемы
MCP-тулов в каждый turn НЕ едут — в системном промпте только имена и описания, полная схема
подгружается `ToolSearch`. Платятся: `instructions` сервера (у `mobile`, `amplitude`, а до удаления —
`lazyweb`: абзацы текста на каждый turn), описания скиллов в листинге (листинг капируется: в сессии
2026-09-03 описание показано у ~70 из ~200 скиллов, остальные — только имя, и неиспользуемые
вытесняют используемые), хуки плагинов (латентность на каждый tool call), таймауты и
авторизационный шум серверов на старте. Мерить — `claude plugin details <plugin>` (оценка
Anthropic по always-on токенам) плюс замер реальных вызовов по транскриптам.

**Правило для агента:** задача упёрлась в возможность из таблицы — не отказывать и не искать
обход. Назвать пользователю точную строку возврата из колонки «Вернуть» и сказать, что нужен
рестарт сессии. Включает пользователь, не агент.

Замеры: вызовы `mcp__<server>__*` и `Skill(...)` по транскриптам `~/.claude/projects/**/*.jsonl`
(не упоминания). Окна: 2026-08-01…08-19 (2097 файлов) и 2026-08-19…09-03 (951 файл, 59k
tool-вызовов, 798 спавнов субагентов).

## Выключено / удалено 2026-09-03

| Возможность | Что давала | Вызовов 08-19…09-03 | Вернуть |
|---|---|--:|---|
| `compound-engineering@every-marketplace` | 27 скиллов `ce-*` (brainstorm, plan, review…), ~1.4k always-on токенов | 0 (4 за прошлое окно) | `claude plugin marketplace add EveryInc/compound-engineering-plugin` → `claude plugin install compound-engineering@every-marketplace` |
| `cloudflare@claude-plugins-official` | 11 скиллов + 5 MCP (api, docs, bindings, builds, observability), ~1.0k always-on | 2 (оба `authenticate`); MCP не авторизован с 08-28 | `settings.json` → `enabledPlugins` → `true`, затем `/mcp` → авторизация |
| `context7@claude-plugins-official` | MCP context7 без API-key | 0 — дубль standalone `context7` (93 вызова, с ключом) | там же |
| MCP `lazyweb` (user, профиль claude-work) + 4 скилла `lazyweb*` | ~50 тулов, длинные server-instructions в каждом turn, version-check на старте | 0 (8 за прошлое окно) | `claude mcp add --transport http lazyweb https://www.lazyweb.com/mcp`; skill-pack — установщик с lazyweb.com (`~/.lazyweb` не удалялся) |
| MCP `sentry` (user, профиль claude-work) | Sentry issues | 1 (`authenticate`); не авторизован с 08-28 | `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp` |
| MCP `pencil`, `vercel` (профиль `claude`, `~/.claude.json`) | Pencil desktop, Vercel | 0 | `claude mcp add …` заново |
| Удалены из кэша (были выключены): `code-simplifier`, `mcp-apps`, `voltagent-*` ×3, `skill-creator`, `figma`, `vercel`, `claude-md-management`; маркетплейсы `every-marketplace`, `kotlin-agents-marketplace`, `mcp-apps`, `voltagent-subagents` | — | 0 | `claude plugin marketplace add <repo>` + `claude plugin install <plugin>@<marketplace>` |

**Добавлено 2026-09-03:** плагин `playwright@claude-plugins-official` (`@playwright/mcp` от
Microsoft, официальный маркетплейс Anthropic) и скилл `playwright-cli` (`npm i -g @playwright/cli`,
`playwright-cli install --skills claude --global` → `~/.claude/skills/playwright-cli`) — браузерные
тесты веб-разработки: headless Chromium, accessibility-snapshot вместо пикселей, console/network.
`claude-in-chrome` остаётся для ручных проверок в залогиненном профиле пользователя (у расширения
нет headless-режима, оно всегда ведёт видимое окно).

## Оставлено включённым — с цифрами (08-19…09-03)

`claude-in-chrome` 2284 · `mobile` 175 · `amplitude` (плагин) 96 · `context7` (standalone) 93 ·
`RevenueCat` (плагин) 82 · `atlassian` 34 · `firebase` 23 · `Gmail` 9 · `Slack` 5 · `appstore` 2.

Без вызовов, но оставлено сознательно: `warp` (только уведомления Warp; 6 хуков, PostToolUse
≈0.5 с на tool call — решение пользователя 2026-09-03), `caveman` (режим активен,
`cavecrew-reviewer` 11 спавнов), `ast-index` (CLI через Bash — 444 вызова), `frontend-design`
(22 вызова скилла).

`skillOverrides: "off"` работает по-разному (проверено 2026-09-03 в двух сессиях, главной и
субагентной): **короткий ключ прячет user-скилл из `~/.claude/skills` целиком** — `git-worktree-env`
и 7 Cloudflare-копий (`cloudflare`, `wrangler`, `durable-objects`, `sandbox-sdk`, `web-perf`,
`workers-best-practices`, `agents-sdk`) в листинге отсутствуют; **prefixed-ключ плагинного скилла
видимого эффекта не даёт** — `amplitude:*`, `RevenueCat:*` с `"off"` оставались в листинге name-only,
как и не выключенные соседи за бюджетом. Вывод: неиспользуемый user-скилл можно спрятать обратимо
коротким ключом, не удаляя каталог; плагинный скилл прячется только через `enabledPlugins`.

## Дубли MCP

| сервис | standalone | плагин | статус |
|---|--:|--:|---|
| Amplitude (профиль `claude`) | `Amplitude` — 29, только главный | `plugin_amplitude_amplitude` — 96, 2/3 из `@product-expert` | не тронуто: наборы тулов различаются |
| RevenueCat (профиль `claude`) | `revenuecat` — 0 | 82 | standalone оставлен по решению пользователя |
| context7 | `context7` — 93 (с API-key) | 0 | плагин выключен 2026-09-03 |

Сторонние скиллы (65 из 92 в `~/.claude/skills`) этой ревизией не трогались — провенанс,
нули по группам и что отложено см. `improvements/2026-09-03-harness-inventory-audit.md`.
