---
date: 2026-09-23
slug: backlog-triage-skills-and-guard-log
status: applied
goal: разобрать три записи бэклога — дубли и мёртвые скиллы по замеру, журнал деградации guard-хуков, отмена Gradle-записи
metric: строки в stats/hook-degraded.log; задачи, упёршиеся в удалённый или скрытый скилл
baseline_date: 2026-09-23
target_date: 2026-10-07
---

# Разбор бэклога: скиллы и журнал деградации guard-хуков

## Цель

Закрыть три записи `docs/backlog/` решениями, а не переносом: убрать дубли скиллов, у которых есть плагинная копия; убрать из листинга мёртвые скиллы, не ломая агентов; сделать fail-open guard-хуков видимым.

## Baseline (на 2026-09-23)

- Замер вызовов за 09-03…09-23, 1447 транскриптов (метод и цифры — Replay записи `2026-09-03-harness-inventory-audit.md`): у всех кандидатов 0 вызовов, кроме `stop-slop` (5) — источник: разовый скрипт замера, вывод сессии 2026-09-23.
- `protected-branch-guard.ps1` и `credentials-guard.ps1` в fail-open `catch` выходят молча: «упал» неотличим от «не понадобился». Сбоев в журнале — нечем измерить до этой правки (журнала не было).
- Задачи, упёршиеся в удалённый или скрытый скилл: нечем измерить автоматически — ловится ошибкой `disabled for model invocation` в транскриптах, считать грепом на replay.
- ASO-пакет `eronred/aso-skills`: 8 копий в `skills/` + 6 junction'ов из `~/.agents/skills`.

## Гипотеза

1. Дубль плагинного скилла только засоряет листинг — удаление ничего не отнимает.
2. `skillOverrides` (ключ пользовательского settings.json; не проверено — файл вне репозитория; источник: code.claude.com/docs/en/skills) снимает скилл и из листинга, и из вызова моделью (дока `code.claude.com/docs/en/skills`, живая проверка: «disabled for model invocation»). Значит, скрывать можно только скиллы, на которые не ссылается ни один агент и ни один скилл; остальные мёртвые оставлены (`testing-setup` — из-за ссылки в `skills/screenshot-driven-ui`).
3. Строка в журнале из `catch` даёт replay'ю отличить «хук сломан» от «хук не понадобился» — без изменения поведения хука.

## Изменения

- **Живой конфиг (не в MR):** из `~/.claude/skills` удалены 7 Cloudflare-копий (`cloudflare`, `wrangler`, `durable-objects`, `sandbox-sdk`, `web-perf`, `workers-best-practices`, `agents-sdk`) и 4 caveman-junction'а; в пользовательском settings.json (не проверено — файл вне репозитория) → `skillOverrides` сняты 7 коротких Cloudflare-ключей, добавлено `"off"` для `android-cli`, `notion-api`, `notion-cli`, `cloudflare-email-service`, `cloudflare-one`, `cloudflare-one-migrations`; 8 ASO-копий (побайтно равны upstream) перенесены в `~/.agents/skills` и подключены junction'ами.
- `hooks/protected-branch-guard.ps1`, `hooks/credentials-guard.ps1` — fail-open `catch` пишет `<время>\t<хук>\t<сообщение>` в `stats/hook-degraded.log` (вне git); сбой записи хук не роняет.
- `docs/backlog/` — три записи закрыты с решениями, `INDEX.md` обновлён; в `gradle-daemon-sprawl.md` исправлено значение `kotlin.daemon.jvmargs` (3g).
- `improvements/2026-09-03-harness-inventory-audit.md` — заполнен Replay.

Оставлено решением пользователя: плагин `warp`, Chrome по умолчанию.

## Target (к 2026-10-07)

- Ни одна задача не упёрлась в удалённый или скрытый скилл; упёрлась — ключ из `skillOverrides` снимается одной строкой (источник: code.claude.com/docs/en/skills).
- `stats/hook-degraded.log` пуст или каждая строка разобрана: причина найдена и исправлена.

## Replay (заполняется 2026-10-07)

<пусто>
