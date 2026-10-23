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
обход. Назвать пользователю точную строку возврата из колонки «Вернуть». Включает пользователь,
не агент. Рестарт в интерактивной сессии обычно не нужен: `/plugin` или `/mcp` → toggle
действует сразу; в headless (`-p`) изменение подхватит только следующая сессия (сверено с
code.claude.com/docs/en/mcp 2026-10-12).

Замеры: вызовы `mcp__<server>__*` и `Skill(...)` по транскриптам `~/.claude/projects/**/*.jsonl`
(не упоминания). Окна: 2026-08-01…08-19 (2097 файлов) и 2026-08-19…09-03 (951 файл, 59k
tool-вызовов, 798 спавнов субагентов).

## Выключено 2026-10-08 — дубли интеграций

Один сервис подключён двумя путями: оба висят в `/mcp` и в листинге тулов, а один из них
не авторизован и шумит «Needs authentication» на старте. Оставлен тот, что авторизован и
реально вызывается. Замер вызовов — транскрипты 2026-09-08…10-08.

| Возможность | Дубль чего | Вызовов за месяц | Вернуть |
|---|---|--:|---|
| Плагин `revenuecat@RevenueCat` (MCP `plugin:revenuecat:RevenueCat` + 26 скиллов `revenuecat:*`) | коннектор claude.ai `RevenueCat` (тот же `mcp.revenuecat.ai/mcp`, авторизован) | MCP 0 (не авторизован), скиллы 0 | `settings.json` → `enabledPlugins` → `"revenuecat@RevenueCat": true`, рестарт сессии, затем `/mcp` → `plugin:revenuecat:RevenueCat` → авторизация |
| Коннектор claude.ai `Atlassian MCP` (`/v2/mcp`) в Claude Code | standalone `atlassian` (user-scope; **с 2026-10-12 на `/v2/mcp`** — v2 GA 2026-09-08 даёт `discover`/`execute*` и `uploadAttachmentToJiraIssue`, префикс `mcp__atlassian__*` прежний) | 16 против 148 у standalone; `@jira-expert`, `jira-task-writer` и память агента ссылаются на `mcp__atlassian__*` | снять запрет `mcp__claude_ai_Atlassian_MCP` из `permissions.deny` в `settings.json`, рестарт сессии |

## Удалено 2026-10-06

| Возможность | Что давала | Почему снята | Вернуть |
|---|---|---|---|
| `caveman@caveman` + marketplace `caveman` | стиль сжатых ответов (lite) через SessionStart/UserPromptSubmit-хуки, скиллы `caveman:*`, агенты `cavecrew-*` | заменён output style `ste-ru` (`output-styles/ste-ru.md`) — решение пользователя; обрывки фраз caveman противоречат полным предложениям STE | `claude plugin marketplace add JuliusBrussee/caveman` → `claude plugin install caveman@caveman`, убрать `outputStyle` из `settings.json` |

## Выключено / удалено 2026-09-03

| Возможность | Что давала | Вызовов 08-19…09-03 | Вернуть |
|---|---|--:|---|
| `compound-engineering@every-marketplace` | 27 скиллов `ce-*` (brainstorm, plan, review…), ~1.4k always-on токенов | 0 (4 за прошлое окно) | `claude plugin marketplace add EveryInc/compound-engineering-plugin` → `claude plugin install compound-engineering@every-marketplace` |
| `cloudflare@claude-plugins-official` | 11 скиллов + 5 MCP (api, docs, bindings, builds, observability), ~1.0k always-on | 2 (оба `authenticate`); MCP не авторизован с 08-28 | `settings.json` → `enabledPlugins` → `true`, затем `/mcp` → авторизация |
| `context7@claude-plugins-official` | MCP context7 без API-key | 0 — дубль standalone `context7` (93 вызова, с ключом) | там же |
| MCP `lazyweb` (user, профиль claude-work) + 4 скилла `lazyweb*` | ~50 тулов, длинные server-instructions в каждом turn, version-check на старте | 0 (8 за прошлое окно) | `claude mcp add --transport http lazyweb https://www.lazyweb.com/mcp`; skill-pack — установщик с lazyweb.com (`~/.lazyweb` не удалялся) |
| ~~MCP `sentry`~~ **возвращён 2026-09-07** | Sentry issues | на дату ревизии: 1 (`authenticate`), не авторизован с 08-28 | — уже стоит (user-scope, `.claude-work/.claude.json`), авторизован 09-07 |
| MCP `pencil`, `vercel` (профиль `claude`, `~/.claude.json`) | Pencil desktop, Vercel | 0 | `claude mcp add …` заново |
| Удалены из кэша (были выключены): `code-simplifier`, `mcp-apps`, `voltagent-*` ×3, `skill-creator`, `figma`, `vercel`, `claude-md-management`; маркетплейсы `every-marketplace`, `kotlin-agents-marketplace`, `mcp-apps`, `voltagent-subagents` | — | 0 | `claude plugin marketplace add <repo>` + `claude plugin install <plugin>@<marketplace>` |

## Перенесено 2026-10-23 — MCP только там, где нужен

Замер 2026-10-23: 6 сессий = 13,1 GB private, на сессию `claude.exe` 0,6–0,8 GB + MCP 1,1–1,3 GB.
Claude Code запускает stdio-MCP при старте сессии и держит до конца; ленивого старта для stdio нет
(`MCP_DISCOVERY_CACHE` откладывает только удалённые HTTP/SSE). Поэтому сервер, нужный одному агенту,
описан inline в его `mcpServers`: стартует со спавном, закрывается по завершении. Пути — через
`cmd /c` и `%USERPROFILE%`: `${VAR}` в inline-серверах субагента Claude Code не раскрывает
(v2.1.309), а в файле `--mcp-config` раскрывает.

| Сервер | Где теперь | Цена на сессию, снятая с главной | Включить в главной сессии |
|---|---|--:|---|
| `artemis` (ARTEMIS) | `agents/mobile-tester.md`, спавн из `/mcp-mobile-test` | ~495 MB | `claude --continue --mcp-config "$HOME/.claude/config/mcp/device.json"` — на одну сессию |
| `mobile` (claude-in-mobile) | там же | ~60 MB | та же строка |
| `appstore` | `agents/marketing-expert.md` | ~45 MB | не нужно: данные сторов — работа `@marketing-expert`. Не поднялся у агента → нет `%USERPROFILE%\mcp-servers\mcp-appstore\server.js`: `git clone https://github.com/appreply-co/mcp-appstore` в этот каталог и `npm install` там |
| `layout-debug` | только по флагу | 130–230 MB | `claude --continue --mcp-config "$HOME/.claude/config/mcp/layout-debug.json"` — на одну сессию, снимать после работы нечего |

Профиль `claude` — с `$env:CLAUDE_CONFIG_DIR=$null` перед командой. Прошлый способ для
layout-debug (`claude mcp add -s user` + `remove` после работы) не удержался: к 2026-10-23 сервер
снова стоял user-scope в обоих профилях.

## Выключено 2026-09-25 — память, не контекст

stdio-MCP стартует **в каждой сессии** отдельным набором процессов; при 5 параллельных сессиях на
16 GB это ощутимо (замер 2026-09-25: сессия ≈ 1,3–1,5 GB, из них MCP ≈ 730 MB).

| Возможность | Что давала | Цена на сессию | Вернуть |
|---|---|--:|---|
| MCP `layout-debug` (был user-scope в обоих профилях) | выбор слоя на живом UI → агенту | 6 процессов (`cmd → npx → tsx → node`), ~200 MB | **Заменено 2026-10-23** — `--mcp-config`, см. секцию выше |

`firebase` (~240 MB) и `playwright` (~160 MB) оставлены сознательно: выключенный плагин убирает из
сессии и имена тулов, и скиллы — агент перестаёт знать, что они есть (решение пользователя 2026-09-25).

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
≈0.5 с на tool call — решение пользователя 2026-09-03), `ast-index` (CLI через Bash — 444 вызова), `frontend-design`
(22 вызова скилла).

`skillOverrides: "off"` работает по-разному (проверено 2026-09-03 в двух сессиях, главной и
субагентной): **короткий ключ прячет user-скилл из `~/.claude/skills` целиком** — `git-worktree-env`
и 7 Cloudflare-копий (`cloudflare`, `wrangler`, `durable-objects`, `sandbox-sdk`, `web-perf`,
`workers-best-practices`, `agents-sdk`) в листинге отсутствуют; **prefixed-ключ плагинного скилла
видимого эффекта не даёт** — `amplitude:*`, `RevenueCat:*` с `"off"` оставались в листинге name-only,
как и не выключенные соседи за бюджетом. Вывод: неиспользуемый user-скилл можно спрятать обратимо
коротким ключом, не удаляя каталог; плагинный скилл прячется только через `enabledPlugins`.
Документация это подтверждает (code.claude.com/docs/en/skills, сверено 2026-10-12): «Plugin skills
are not affected by skillOverrides».

## Дубли MCP

| сервис | standalone | плагин | статус |
|---|--:|--:|---|
| Amplitude (профиль `claude`) | `Amplitude` — 29, только главный | `plugin_amplitude_amplitude` — 96, 2/3 из `@product-expert` | не тронуто: наборы тулов различаются |
| RevenueCat (профиль `claude`) | `revenuecat` — 0 | 82 | standalone оставлен по решению пользователя |
| RevenueCat (профиль `claude-work`) | коннектор claude.ai `RevenueCat` — авторизован | 0, не авторизован | плагин выключен 2026-10-08 |
| Atlassian | `atlassian` — 148 | коннектор claude.ai — 16 | коннектор запрещён в Claude Code 2026-10-08 |
| context7 | `context7` — 93 (с API-key) | 0 | плагин выключен 2026-09-03 |

Сторонние скиллы (65 из 92 в `~/.claude/skills`) этой ревизией не трогались — провенанс,
нули по группам и что отложено см. `improvements/2026-09-03-harness-inventory-audit.md`.
