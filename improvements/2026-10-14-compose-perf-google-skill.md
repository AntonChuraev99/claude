---
date: 2026-10-14
slug: compose-perf-google-skill
status: applied
goal: compose-expert оптимизирует перф Compose по официальному скиллу Google и не лечит тормоза аннотациями стабильности
metric: доля перф-задач compose-expert, где вызван jetpack-compose-performance и в диффе нет новых @Stable/@Immutable/ImmutableList на моделях с коллекциями
baseline_date: 2026-10-14
target_date: 2026-10-28
---

# Официальный скилл Google по перфу Compose для compose-expert

## Цель

Дать `compose-expert` официальный чеклист Google (7 категорий, справочник на каждую) и закрыть типичную ошибку агентов: лечить тормоза через `@Stable` / `@Immutable` / `ImmutableList`.

## Baseline (2026-10-14)

- У `compose-expert` для перфа был один скилл — `compose-performance` (сторонний, диагностика по замерам). Правила про Strong Skipping и аннотации на моделях с коллекциями в нём не зафиксированы.
- Значение метрики: 0 — перф-задач с этим скиллом ещё не было, долю считать от первой такой задачи.
- Google опубликовал скилл `jetpack-compose-performance` на developer.android.com; в `android skills list` (Android CLI 1.0.16500706) и в github.com/android/skills на эту дату его нет.

## Гипотеза

Если агент на перф-задаче вызывает скилл Google и читает справочник категории до правки, он перестанет добавлять аннотации стабильности к моделям с коллекциями и будет чинить фазу чтения state, ключи lazy-списков и аллокации.

## Изменения

- `agents/compose-expert.md` — строка `jetpack-compose-performance` в таблице «Скилл под симптом»; у `compose-performance` уточнён триггер (диагностика по замерам); абзац «Перф-правки»: приоритет Google по стабильности, сверка версии Compose перед API с порогом, замер только на release + R8 + Baseline Profile.
- Сам скилл ставится локально в `~/.claude/skills/jetpack-compose-performance/` (сторонний, в репо не коммитится, как остальные скиллы Google). Пока Android CLI его не отдаёт — копия с developer.android.com; после появления — `android skills add jetpack-compose-performance`.

## Target

К 2026-10-28: в перф-задачах `compose-expert` скилл вызван, в диффах нет новых аннотаций стабильности на моделях с коллекциями.

## Replay (заполняется через N дней)

—
