---
date: 2026-10-29
slug: android-preview-render
status: applied
goal: Android-вёрстка проверяется снимком без эмулятора и без Roborazzi в модуле — `android preview render` стал инструментом скриншот-цикла по умолчанию
metric: доля UI-задач на Android, где в отчёте есть прочитанные PNG; число вопросов «завести Roborazzi?» ради цикла
baseline_date: 2026-10-29
target_date: 2026-11-12
---

# `android preview render` — скриншот-цикл Android по умолчанию

## Цель

Скриншот-цикл (`screenshot-driven-ui`) на Android требовал Roborazzi + Robolectric в модуле правящегося файла. Нет инфраструктуры — цикл вставал до вопроса пользователю. Android CLI 1.1 (октябрь 2026) рендерит `@Preview` в PNG на машине без устройства и без IDE. Google выпустил плагин `android-cli` для Claude Code.

## Baseline (2026-10-29)

- Нечем измерить автоматически: отчёты агентов не размечены по инструменту снимка. Replay — по транскриптам UI-задач за две недели: были ли PNG и откуда.
- Замеры на двух проектах (Android CLI 1.1.16717390, Windows; времена — источник: `date +%s` вокруг команд в сессии 2026-10-29):
  - обычный Android-модуль: `preview list` 113 с, рендер 15 вариантов одного превью ≈ 2 с на тёплом демоне, Gradle up-to-date ≈ 50 с; первая сборка — полная компиляция, 10+ мин;
  - KMP-модуль на AGP 9 (`com.android.kotlin.multiplatform.library`, источник: `libs.versions.toml` проверенного проекта): напрямую `is not an Android application or library project`; через app-модуль (`:androidApp --all`) список и рендер `androidMain`-превью работают, 119 с;
  - `commonMain`-превью с `org.jetbrains.compose.ui.tooling.preview.Preview` CLI не находит (источник: импорт в `App.kt` проверенного проекта и вывод `preview list --all`);
  - вывод в pipe вешает команду до 10+ мин (дочерние процессы держат pipe), в файл — возвращается сразу.

## Гипотеза

Цикл больше не зависит от инфраструктуры модуля: снимок есть везде, где есть `@Preview` в Android-модуле или в `androidMain`. Вопрос «завести Roborazzi?» уходит из цикла и остаётся только для baseline/CI.

## Изменения

- `skills/screenshot-driven-ui/references/android-preview-render.md` — новый: команды, формат выхода, ловушки с замерами, дубль скилла `android-cli`.
- `skills/screenshot-driven-ui/SKILL.md` — description, шаг 0 (инструмент по умолчанию), шаги 2–6 (раскрытие multipreview, команда, каталоги «до/после», baseline не блокер).
- `CLAUDE.md` → «Вёрстка — проверяется картинкой»: Android по умолчанию `android preview render`; вопрос пользователю — только когда снять нечем.
- `agents/compose-expert.md` — шаг 5 метода, «до/после», разрешение гонять `android preview` самому.
- `agents/android-platform-expert.md` — перед заведением Roborazzi проверить `preview render`; ловушка KMP-модулей на AGP 9 при миграции (плагин — см. Baseline выше).
- `agents/test-expert.md` — `android preview list/render` в разрешённых командах.
- `skills/android-feature-module-builder/SKILL.md` — валидация снимком через `preview render`.
- `skills/task-gate/SKILL.md` (2.2b) и `skills/task-gate/references/screenshot-gate.md` — модуль без Roborazzi не считается `no screenshot infra`, если его снимает `preview render`.
- `settings.example.json` — плагин `android-cli@android-cli-plugin` и его marketplace.
- Вне репо: плагин поставлен user-scope; локальная копия скилла `android-cli`, которую ставит сам CLI, удалена для Claude Code (`android skills remove --agent=claude-code`) по решению пользователя — чтобы не было дубля.

## Target

К 2026-11-12:
- в UI-задачах на Android отчёт содержит пути PNG от `preview render` или Roborazzi, без «инфраструктуры нет, снимков не будет»;
- ноль вопросов «завести Roborazzi?» ради цикла (только ради baseline);
- ни одного зависания `android preview` на pipe в транскриптах.

## Replay (заполняется через N дней)
