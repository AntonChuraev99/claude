---
date: 2026-10-12
slug: stale-capability-limits
status: applied
goal: убрать из харнесса записанные «X нельзя», которые уже сняты обновлением MCP, CLI или платформы
metric: число ручных шагов и отказов «инструмент не умеет», которые агенты отдают пользователю при живом инструменте
baseline_date: 2026-10-12
target_date: 2026-10-26
---

# Устаревшие ограничения возможностей

## Цель

Агенты отказывались или отдавали пользователю ручной шаг по записям «MCP не умеет X», сделанным месяцы назад. Пример: `@jira-expert` не прикреплял скриншот к задаче, хотя Atlassian Rovo MCP v2 (GA 2026-09-08) умеет `uploadAttachmentToJiraIssue`.

## Baseline (2026-10-12)

Ревизия: два сканера прошли `CLAUDE.md`, `rules/`, `config/`, `agents/`, собственные скиллы и память агентов. Нашли ~110 технических ограничений. Около 30 из них в принципе снимаются обновлением инструмента — их проверили по первоисточникам (документация, changelog, локальные `--help`, живые схемы MCP-тулов):

- ~15 устарели или сформулированы неверно;
- ~10 подтверждены — им дописана дата проверки;
- остальные (особенности Windows, физические ограничения устройства, политика Workspace, вендорные скиллы) обновлением не снимаются и не трогались.

Числа «сколько раз агент отказал зря» до правки нечем измерить: отказы не логируются отдельно.

## Гипотеза

Запись ограничения без даты и источника переживает сам дефект. Если исправить формулировку и пометить датой проверки, агент пойдёт рабочим путём, а не обходом.

## Изменения

- `CLAUDE.md` → «Автономность»: хуки `account-align`/`credentials-guard` не видят MCP-тулы из-за матчера, а не из-за платформы.
- `skills/task-gate/SKILL.md` → «Ревью-агенты read-only» и `references/diff-review-axes.md`, `skills/subagent-authoring/SKILL.md` (п. 12 чеклиста), комментарий `hooks/docs-length-guard.js`: PreToolUse из `settings.json` срабатывает и на тулы субагента, в том числе фонового (документация + транскрипт 2026-10-08); запрет на запись держит бриф, потому что наш хук его не ставит, а `protected-branch-guard` — deny-once.
- `skills/claude-profiles/SKILL.md`: MCP-матчер для хуков; `/mcp` → Reconnect / `/mcp reconnect all` до рестарта сессии.
- `config/optional-capabilities.md`: рестарт для toggle плагина или MCP нужен только в headless; Atlassian standalone переведён на `/v2/mcp`; `skillOverrides` для плагинных скиллов подтверждён докой.
- `agents/jira-expert.md`: вложение через v2 `uploadAttachmentToJiraIssue`; нет upload — `BLOCKED`, а не тихая ссылка.
- `skills/jira-task-writer/SKILL.md`: HTML-файл только для ручной вставки; при MCP — markdown для `@jira-expert`.
- `skills/ab-test-dashboard/` (SKILL + pitfalls): имена тулов Amplitude (`use_amp_dashboards`, `manage_amp_entities`, `share_amp_entities` вместо `create_dashboard`/`share_object`); публикация в shared space через `destination`; Firebase `experimentValue.variantValue[]` в шаблоне Remote Config после миграции 2026-09-01; повторная проверка «нет удаления чартов» и «нет подписи серии».
- `skills/cloudflare-deploy-slack-notify/SKILL.md`: Deploy command и build-секреты через Builds API с user-scoped token.
- `skills/gitlab-release-slack-ci/` (SKILL + pitfalls): CI-переменная и protected tag через `glab variable set` / `glab api`; `--notes-file` в glab 1.81.0 существует.
- `skills/screenshot-driven-ui/references/roborazzi-setup.md`: версии CPST и Paparazzi.
- `agents/google-play-console-expert/scripts/play_publish.py` + README: повторяемые `--release-notes lang=…`, `--version-codes` (promote/ramp без AAB), повторяемый `--track` (custom-треки), импорт google-библиотек отложен до сети.
- Вне репозитория (приватно): сервер `atlassian` переключён на `/v2/mcp`; память агентов `jira-expert`, `product-expert`, `wasmjs-expert`, `google-play-console-expert`, `design-expert`, `marketing-expert` и скилл `notion-source-footnote` получили поправки и даты проверки.

## Target

К 2026-10-26:
- `@jira-expert` прикрепляет локальный файл вложением хотя бы в одной задаче (транскрипты: вызов `uploadAttachmentToJiraIssue`);
- ни одного отчёта «опубликуй в shared space вручную» от `ab-test-dashboard`;
- ни одного рестарта сессии ради MCP, который чинится `/mcp` → Reconnect.

## Replay (заполняется через N дней)

—
