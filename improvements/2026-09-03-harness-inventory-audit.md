---
date: 2026-09-03
slug: harness-inventory-audit
status: applied
goal: ревизия сторонних плагинов, MCP и скиллов по замеру вызовов и оценке Anthropic; профильный браузерный тул для веб-тестов; приоритет первоисточников Anthropic у scout'а
metric: always-on токены плагинов (`claude plugin details`), число MCP-серверов на старте, доля браузерных вызовов через Playwright vs claude-in-chrome
baseline_date: 2026-09-03
target_date: 2026-09-17
---

# Ревизия сторонних плагинов, MCP и скиллов

## Цель

Убрать из харнесса то, чем не пользуются — по замеру, не по ощущению; поставить профильный
браузерный инструмент вместо пиксельных кликов через `claude-in-chrome`; закрепить у
`@best-practices-scout` приоритет первоисточников Anthropic по темам харнесса и AI.

## Baseline (до изменений, на 2026-09-03)

Метод: два замера вызовов по транскриптам `~/.claude/projects/**/*.jsonl` — 08-01…08-19
(2097 файлов) и 08-19…09-03 (951 файл, 59 038 tool-вызовов, 798 спавнов субагентов, 398 вызовов
`Skill`) — плюс `claude plugin details` (оценка Anthropic always-on токенов на плагин).

| что | значение |
|---|---|
| MCP-серверов у главного на старте (активный профиль) | 18: 6 standalone, 9 плагинных (5 из них — cloudflare), chrome, 2 коннектора claude.ai. Без содержательных вызовов за окно: `lazyweb` 0, `sentry` 1×`authenticate`, cloudflare ×5 — 2×`authenticate`; `claude.ai GitLab` падает 404 на каждом старте; `firebase` — таймаут 30 с (истекла авторизация) |
| always-on плагинов (`claude plugin details`) | amplitude 3 545 · compound-engineering 1 400 · RevenueCat 1 147 · cloudflare 1 000 · caveman 853 · ast-index 403 · frontend-design 59 — **≈8.4k токенов** на сессию и на каждый спавн субагента |
| вызовы скиллов плагинов за окно | frontend-design 22 · compound-engineering 0 · cloudflare 0 · amplitude 0 · RevenueCat 0 |
| браузер | `claude-in-chrome` 2 284 вызова за 16 дней (computer 740, javascript_tool 711, browser_batch 227) — пиксели и JS вместо accessibility-снапшотов; профильного браузерного тула нет |
| скиллы | 92 каталога в `~/.claude/skills`, 65 сторонних (35 junction'ов из `~/.agents/skills` по `.skill-lock.json`, 30 копий без lock-файла); в листинге сессии описание показано у ~70 из ~200 имён; 8 user-скиллов спрятаны короткими ключами `skillOverrides` (работают), 70 prefixed-ключей плагинных скиллов видимого эффекта не дают |
| дубли | 10 Cloudflare-копий, из них 7 = скиллы плагина `cloudflare:*` (3 — `cloudflare-email-service`, `cloudflare-one`, `cloudflare-one-migrations` — дубля в плагине не имеют); 4 caveman-junction'а = плагин `caveman:*`; `context7` плагин = standalone с API-key (0 vs 93 вызова); `revenuecat` standalone = плагин (0 vs 82) |
| хуки `warp` | PostToolUse ≈0.5 с на tool call даже с локальным perf-патчем ≈ 8 ч ожидания за окно |

Скрипт замера — одноразовый, в репозиторий не вошёл; провенанс сторонних скиллов по группам и
кандидаты с цифрами — `docs/backlog/harness-third-party-skills-cleanup.md`.

## Гипотеза

1. Tool Search (Claude Code ≥ 2.1.232) убрал схемы MCP-тулов из каждого turn; цену теперь дают
   `instructions` серверов, авторизационный шум и таймауты на старте, описания скиллов в
   капируемом листинге — резать надо мёртвые серверы и плагины с большим листингом, а не
   «число тулов».
2. Официальный маркетплейс Anthropic содержит плагин `playwright` (`@playwright/mcp`) — это и
   есть рекомендуемый Anthropic путь для браузерных тестов; `playwright-cli` (skill от Microsoft)
   дешевле по токенам за действие (снапшоты на диск) и не конфликтует с плагином.
   `claude-in-chrome` остаётся для ручных проверок в залогиненном профиле: по доке Anthropic
   расширение всегда ведёт видимое окно и делит логин-состояние, headless-режима у него нет.
3. Вторичные «best practices»-посты по харнессу регулярно расходятся с докой Anthropic; правило
   приоритета первоисточника у scout'а снимает этот класс ошибок на входе, а не на ревью.

## Изменения

- **Живой конфиг (не в MR):** `claude mcp remove lazyweb`, `sentry` (профиль claude-work);
  `pencil`, `vercel` (профиль claude); `claude plugin disable cloudflare`, `context7`;
  `claude plugin uninstall` — `compound-engineering`, `code-simplifier`, `mcp-apps`,
  `voltagent-*` ×3, `skill-creator`, `figma`, `vercel`, `claude-md-management`;
  `claude plugin marketplace remove` — `every-marketplace`, `kotlin-agents-marketplace`,
  `mcp-apps`, `voltagent-subagents`; `claude plugin install playwright@claude-plugins-official`;
  `npm i -g @playwright/cli` + `playwright-cli install --skills claude --global`
  (→ `~/.claude/skills/playwright-cli`); из `settings.json` → `skillOverrides` убраны мёртвые
  prefixed-ключи `cloudflare:*` (9) и `compound-engineering:*` (22) — плагины выключены/удалены;
  7 коротких cloudflare-имён **оставлены**: они прячут из листинга user-копии, которые пользователь
  удалять отказался; снята permission `mcp__pencil`; удалены каталоги `skills/lazyweb*` ×4 и
  eval-артефакт `skills/jira-task-writer-workspace`.
- `agents/best-practices-scout.md` — шаг 3 метода: тема харнесса или AI → владелец факта
  Anthropic, первоисточник открывается первым, при расхождении вердикт по Anthropic, чужой довод
  в `NOTES`; то же правило и прецедент этой задачи — в
  `agent-memory/best-practices-scout/reference_research_discipline_and_precedents.md` (gitignored).
- `config/optional-capabilities.md` — переписан: секция 2026-09-03 со строками возврата, цифры
  второго окна, устаревший довод «схемы едут в каждый turn» заменён на Tool Search и
  `claude plugin details` как метрику.
- `settings.example.json` — `enabledPlugins` приведён к живому состоянию; убраны permissions на
  context7 из compound-engineering.
- `.gitignore` — снята мёртвая whitelist-пара `skills/stop-slop-ru`.
- Impact scan удалённого плагина: `agents/product-expert.md` — из списка скиллов по требованию убраны
  `compound-engineering:ce-brainstorm` / `ce-strategy` / `ce-pov` (агент вызвал бы несуществующий
  скилл); `skills/task-gate/SKILL.md` → «Что скилл НЕ делает» — ссылка на `compound-engineering:ce-review`
  заменена на `/code-review`.
- `docs/backlog/harness-third-party-skills-cleanup.md` + строка в `docs/backlog/INDEX.md` — отложенные
  пользователем кандидаты с цифрами и триггером, чтобы следующая ревизия не начинала замер с нуля.
- `improvements/2026-08-31-anthropic-harness-alignment.md` — interim replay: короткие ключи
  `skillOverrides: "off"` прячут user-скиллы из листинга (8 проверенных), prefixed-ключи плагинных
  скиллов видимого эффекта не дают — экономия на плагинах только через `enabledPlugins`.

## Отложено сознательно (решение пользователя 2026-09-03)

Плагин `warp` и Chrome «by default» оставлены. Не удалялись сторонние скиллы: 10 Cloudflare-копий
(7 — дубли плагина, 3 без дубля; все 7 дублей уже спрятаны короткими ключами `skillOverrides`),
4 caveman-junction'а + 3 `caveman-*` в `~/.agents/skills` без junction,
мёртвые Google android-skills ×6 (`agp-9-upgrade`, `migrate-xml-views-to-jetpack-compose`,
`appfunctions`, `android-cli`, `testing-setup`, `r8-analyzer`), ни разу не вызванные общие ×9
(pm-skills ×4, `stop-slop`, `notion-api`, `notion-cli`, `accessibility`, `tailwind-design-system`).
В профиле `claude` оставлены standalone `revenuecat`, `mobile-mcp` и собственный проектный MCP.
Вернуться при следующей ревизии с новым замером — список кандидатов в
`docs/backlog/harness-third-party-skills-cleanup.md`.

## Target (к 2026-09-17)

- always-on плагинов по `claude plugin details` ≈ 6.0k вместо 8.4k (`playwright` — MCP без скиллов,
  always-on ≈0); MCP-серверов на старте 11 вместо 18 (4 standalone, 4 плагинных, chrome, 2 коннектора),
  ни одного сервера, у которого есть только `authenticate`.
- В веб-задачах появляются вызовы `mcp__plugin_playwright_playwright__*` и `Skill(playwright-cli)`;
  доля `claude-in-chrome` среди браузерных вызовов падает (baseline — 100%).
- Ни одна задача не упёрлась в удалённое; случилось — строка возврата в `optional-capabilities.md`.
- Дайджесты scout'а по темам харнесса цитируют `code.claude.com` / `anthropic.com` в `SOURCES`.

## Replay (заполняется 2026-09-17)

<пусто — заполнить реальными цифрами тем же методом: `claude plugin details`, замер вызовов по
транскриптам за 09-03…09-17, число скиллов с описанием в листинге новой сессии>
