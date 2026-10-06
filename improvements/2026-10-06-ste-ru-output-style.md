---
date: 2026-10-06
slug: ste-ru-output-style
status: applied
goal: ответы в чате по правилам ASD-STE100, перенесённым на русский; caveman снят
metric: доля ответов без нарушений STE-правил (обрывки, пассив, синонимы, оговорки) на выборке; output-токены на ответ
baseline_date: 2026-10-06
target_date: 2026-10-20
---

# Стиль ответов: упрощённый технический русский (ASD-STE100) вместо caveman

## Цель

Сделать ответы в чате однозначными и легко читаемыми. Источник идеи — совет Карпати: просить LLM писать «на 80% по ASD-STE100» (Simplified Technical English, стандарт для документации по обслуживанию самолётов). Решения пользователя: правила действуют **только на ответы в чате**, адаптируются к русскому, плагин caveman снимается.

## Baseline (на 2026-10-06)

- Стиль задавал плагин `caveman` уровня `lite` (запись [caveman-lite-default](2026-08-27-caveman-lite-default.md)). Он разрешал обрывки фраз («Fragments OK») и был написан под английский.
- Числового замера качества ответов нет. Чем лечится: на replay взять 20 ответов главного из транскриптов `~/.claude/projects/**/*.jsonl` за неделю до и неделю после и посчитать нарушения по 13 правилам стиля.

## Гипотеза

Output style — официальный механизм Claude Code для голоса и формата ответа. Он встраивается в system prompt главного агента и не попадает к субагентам. Правила STE убирают то, что делает ответ двусмысленным: синонимы ради разнообразия, пассив, оговорки, длинные предложения. Обрывки caveman этим правилам противоречат, поэтому два стиля вместе не держим.

## Изменения

- `output-styles/ste-ru.md` — новый стиль, 13 правил + пример. `keep-coding-instructions: true`: без этого флага из system prompt пропадают встроенные инженерные инструкции.
- `.gitignore` — whitelist `output-styles/`.
- `settings.example.json` — `"outputStyle": "ste-ru"`, удалены `caveman@caveman` и его marketplace.
- Живой `~/.claude/settings.json` (gitignored) — то же, плюс удалён `env.CAVEMAN_DEFAULT_MODE`.
- `claude plugin uninstall caveman@caveman` и `claude plugin marketplace remove caveman`. Uninstall, а не `enabledPlugins: false`: по issue anthropics/claude-code#35713 хуки отключённого плагина продолжали впрыскивать контекст.
- Удалены флаги `.caveman-active` в обоих профилях. Профиль `~/.claude-work` получил junction `output-styles` → `~/.claude/output-styles`; каталог добавлен в список общих в `skills/claude-profiles/SKILL.md`.
- `config/optional-capabilities.md` — строка возврата caveman.
- Не тронуто: `~/.agents/skills/caveman*` (Claude Code их не грузит, ссылок из профилей нет), `%APPDATA%\caveman\config.json`, исторические имена `cavecrew-*` в `scripts/session-stages.py`.

## Target

К 2026-10-20: в выборке из 20 ответов после правки нарушений STE-правил меньше, чем в 20 ответах до неё, а документы и брифы субагентов стиль не задел. Признак провала: стиль протекает в `.md`-файлы или ответы стали длиннее без прироста ясности — тогда `status: reverted`, вернуть Default.

## Replay (заполняется 2026-10-20)

_pending_
