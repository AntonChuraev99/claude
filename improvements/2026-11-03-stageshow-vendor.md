---
date: 2026-11-03
slug: stageshow-vendor
status: applied
goal: faux product UI для лендингов (hero, карточка фичи, bento, анимация с курсором) делается по правилам и киту Stageshow, а не «с нуля» агентом
metric: доля задач на маркетинговую иллюстрацию продукта, где @react-ui-expert прочитал SKILL.md копии и сдал снимки скрипта съёмки кита
baseline_date: 2026-11-03
target_date: 2026-11-17
---

# Stageshow — локальная копия у react-ui-expert

## Цель
`ui-demo-video` покрывает один сюжет («переписка → маркер → структура»). Для остальных маркетинговых иллюстраций продукта на web правил кадра, сюжета и проверки не было: агент собирал сцену «по вкусу».

## Baseline (до изменений, на дату 2026-11-03)
Нечем измерить: задач на faux UI в журнале не размечено. Replay считает задачи вручную по транскриптам за период.

## Гипотеза
Внешний скилл Stageshow (`benjitaylor/skills`, MIT, пакет `0.1.0`) даёт gold-примеры, правила кадра и автопроверку кадров. Копия вне каталога скиллов (схема `video-expert`, 2026-10-06) не грузит описание в контекст главного.

## Изменения
- Копия архивом на пине `802057409787133703c56001080169e347305572` в gitignored `~/.claude/agent-memory/react-ui-expert/vendor/stageshow/`; `npm ci`, typecheck, `check:css`, `film.mjs --still` и `--gate` проверены на Windows (источник: `scripts/film.mjs` копии, прогон 2026-11-03).
- `agents/react-ui-expert/README.md` — новый справочник: пути, пин, лицензии ассетов, грабли (gate красный на gold, Grep не видит gitignored-копию, MP4 через виртуальные часы), команды обновления.
- `agents/react-ui-expert.md` — строка в таблице скиллов и в `description`.
- `agents/design-expert.md` — шаг 4: какие references читать и что класть в спеку.
- `agents/video-expert.md` — строка в таблице движков: MP4 из Stageshow-сцены; исключение из запрета таймеров для часов кита.
- `skills/ui-demo-video/SKILL.md` — маршрут на Stageshow в `description` и таблица «Какой движок сцены»; правила рилса ограничены своей грамматикой.

## Target
Каждая задача на faux UI за период идёт цепочкой design-expert → react-ui-expert со ссылкой на gold-пример и снимками `film.mjs` в отчёте (источник: `scripts/film.mjs` копии). Нет задач за период — replay переносится.

## Replay (заполняется через N дней)
