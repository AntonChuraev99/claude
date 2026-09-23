---
title: "Харнесс: сторонние скиллы-дубли и мёртвые группы — кандидаты, отложенные ревизией 2026-09-03"
date: 2026-09-03
status: done
resolved: 2026-09-23
area: harness
keywords: [skills, plugins, mcp, warp, claude-in-chrome, cloudflare, caveman, android-skills, aso-skills, pm-skills, context, skillOverrides]
---

> **Закрыто 2026-09-23** — итог ниже.

## Итог 2026-09-23

Замер вызовов по транскриптам обоих профилей за 09-03…09-23 (1447 файлов; `~/.claude-work/projects` — junction на `~/.claude/projects`, сырой обход считает каждый файл дважды — цифры ниже уже поделены; источник: разовый скрипт замера по `Skill`/`mcp__*` в транскриптах, вывод сессии 2026-09-23). Решения — пользователя, по каждой группе:

| группа | вызовов | решение |
|---|---|---|
| 7 Cloudflare-копий (дубли плагина `cloudflare:*`, плагин снова включён) | 0 | удалены из `skills/` (бэкап — вне репозитория), их короткие ключи из `skillOverrides` сняты |
| 4 caveman-junction'а (дубли плагина `caveman:*`) | 0 | junction'ы сняты, цели в `~/.agents/skills` не тронуты |
| `android-cli`, `notion-api`, `notion-cli`, `cloudflare-email-service`, `cloudflare-one`, `cloudflare-one-migrations` | 0 | `skillOverrides: "off"` |
| `caveman-commit`, `caveman-help`, `caveman-review` в `~/.agents/skills` без junction | — | не трогались: в листинг Claude Code не попадают (плагин `caveman:*` даёт свои) |
| `testing-setup`, `agp-9-upgrade`, `r8-analyzer`, `appfunctions`, `migrate-xml-views-to-jetpack-compose`, pm-skills ×4, `accessibility`, `tailwind-design-system` | 0 | **оставлены** — на них ссылаются таблицы скиллов агентов (`android-platform-expert`, `kmp-expert`, `compose-expert`, `product-expert`, `react-ui-expert`, `wasmjs-expert`), на `testing-setup` — `skills/screenshot-driven-ui`; любое скрытие через `skillOverrides` снимает и вызов моделью (дока `code.claude.com/docs/en/skills`, проверено вызовом скрытого скилла: «disabled for model invocation») |
| `stop-slop` | 5 (через `/stop-slop`) | живой, снят из кандидатов |
| плагин `warp` | — | оставлен (решение пользователя); таймаут хука 20 с в кеше плагина стирается обновлением — см. [hook-refactor-followups](hook-refactor-followups.md) |
| Chrome «by default» | 1342 вызова в 32 сессиях (Playwright MCP — 1408; источник: тот же замер) | оставлен: пользуется активно |
| ASO-пакет | — | 8 копий совпали с upstream `eronred/aso-skills` побайтно, перенесены в `~/.agents/skills` и подключены junction'ами — пакет ставится одним способом |

Замер и решения — `improvements/2026-09-03-harness-inventory-audit.md`, секция Replay.

# Что осталось после ревизии 2026-09-03

Ревизия `improvements/2026-09-03-harness-inventory-audit.md` сняла мёртвые MCP и плагины. Группы
ниже пользователь на этой ревизии **сознательно оставил** — не блокировка, а решение «не сейчас».
Брать руками при следующей ревизии, с новым замером вызовов (метод и окно — в improvements-записи).

## Кандидаты (с цифрами на 2026-09-03)

1. **Дубли плагинов** — 10 Cloudflare-копий в `~/.claude/skills` (7 совпадают со скиллами плагина
   `cloudflare:*`, который теперь выключен; 3 без плагинного дубля: `cloudflare-email-service`,
   `cloudflare-one`, `cloudflare-one-migrations`) и 4 junction'а `caveman`/`cavecrew`/`caveman-compress`/
   `caveman-stats` на `~/.agents/skills`, дублирующие плагин `caveman:*`; плюс `caveman-commit`,
   `caveman-help`, `caveman-review` в `~/.agents/skills` без junction. Все — 0 вызовов. Семь
   Cloudflare-дублей уже спрятаны из листинга короткими ключами `skillOverrides: "off"` (проверено
   2026-09-03) — дешёвая обратимая альтернатива удалению для любой группы ниже: короткий ключ
   прячет user-скилл, prefixed-ключ плагинного скилла эффекта не даёт.
2. **Мёртвые Google android-skills** (0 вызовов за всё время): `agp-9-upgrade` (проект уже на AGP 9),
   `migrate-xml-views-to-jetpack-compose` (XML-views в проектах нет), `appfunctions`, `android-cli`,
   `testing-setup`, `r8-analyzer`.
3. **Ни разу не вызванные общие**: pm-skills ×4 (`create-prd`, `north-star-metric`,
   `prioritization-frameworks`, `ab-test-analysis` — `@product-expert` их не звал за 6 спавнов),
   `stop-slop`, `notion-api`, `notion-cli`, `accessibility`, `tailwind-design-system`.
4. **Плагин `warp`** — только нативные уведомления Warp; 6 хуков, PostToolUse ≈0.5 с на каждый tool
   call даже с локальным perf-патчем (`hooks/ensure-warp-perf-patch.js`) ≈ 8 ч ожидания за 16 дней.
   Собственный `notify.ps1` на Stop/Notification уже есть.
5. **Chrome «by default»** (`claudeInChromeDefaultEnabled: true` в обоих профилях) — дока Anthropic:
   включённый по умолчанию Chrome грузит browser-тулы в каждую сессию; альтернатива — `claude --chrome`
   или `/chrome` по требованию.
6. **ASO-пакет наполовину скопирован, наполовину слинкован** (8 копий батча 2026-07-02 + 6 junction'ов
   2026-08-09 из `eronred/aso-skills`) — привести к одному способу установки, чтобы обновлялся целиком.

## Триггер к работе

Любое из: следующая ревизия харнеса (replay improvements-записи 2026-09-17); листинг скиллов снова
показывает описание меньше чем у половины имён; появился новый плагин с ещё одним дублем скиллов;
`warp` обновился без perf-фикса (issue warpdotdev/claude-code-warp#77) и хук-патч перестал подходить.
