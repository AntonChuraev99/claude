---
date: 2026-11-16
slug: testtag-resource-id
status: applied
goal: агент на устройстве нажимает элементы Compose-приложения по id (testTag), а не по тексту
metric: доля шагов tests/device-flows/ с селектором id= против text=; число находок «элемент без testTag» на прогон /mcp-mobile-test
baseline_date: 2026-11-16
target_date: 2026-11-30
---

# testTag → resource-id: проверка флага и теги по умолчанию

## Цель

Продолжение `2026-11-16-android-tree-nav`. Чтобы `android input tap 'id=…'` работал в Compose-приложении, нужны две вещи: флаг `testTagsAsResourceId` (источник: developer.android.com, SemanticsPropertiesAndroid) на корне и `Modifier.testTag` на элементах. Пользователь попросил, чтобы харнесс сам проверял и включал это, а не оставлял находкой в отчёте.

## Baseline (2026-11-16)

- Флаг и теги — только строка «Находки для кода» в отчёте `@mobile-tester` и шаг «Сделай руками» для пользователя.
- У `@compose-expert` правила про `testTag` не было.
- Доля шагов скриптов по `id=` — нечем измерить: скриптов ещё нет.

## Гипотеза

`testTagsAsResourceId` объявлен только для Android (источник: developer.android.com/reference/kotlin/androidx/compose/ui/semantics/SemanticsPropertiesAndroid), `testTag` — общий API. Поэтому флаг ставит `@android-platform-expert` в `androidMain` один раз, а теги — `@compose-expert` как постоянную конвенцию. Проверка флага в `/mcp-mobile-test` до сборки убирает ручной шаг. Селектор `id=` не ломается от смены текста и локали, поэтому скрипты flow реже падают ложно.

Отвергнуто: `@design-expert` (не пишет код); правка кода силами `@mobile-tester` (нарушает «прод-код пишет специалист»). Решение пользователя: флаг только в debug-сборке.

## Изменения

- `commands/mcp-mobile-test.md` — шаг 3 «Флаг `testTagsAsResourceId`»: `Grep` по проекту, нет → `@android-platform-expert` с готовым брифом (debug-only, `BuildConfig.DEBUG` или `FLAG_DEBUGGABLE`; источник: developer.android.com, ApplicationInfo); worktree перенесён до этого шага; находки «элемент без testTag» уходят `@compose-expert` одной пачкой, затем повторный прогон.
- `agents/compose-expert.md` — шаг 4: `testTag` на каждом actionable-элементе нового или изменённого экрана, формат `<экран>_<элемент>`, существующие теги не переименовывать.
- `agents/mobile-tester.md` — как распознать отсутствие флага по дереву, формат находки с предложенным тегом, перевод шагов скрипта с `text=` на `id=`.
- `references/android-device-flows.md` § «Compose» — рецепт флага, конвенция тегов, кто что ставит.

Не проверено: доходит ли флаг с корня Activity до `Dialog`, `ModalBottomSheet` и `Popup` (у них своё окно). Ветка «флаг есть, узел без `resource-id`» описана в команде; первый прогон на Compose-проекте её подтвердит или снимет.

## Target

К 2026-11-30: в рабочем Compose-проекте флаг включён, хотя бы один скрипт `tests/device-flows/` (не проверено — каталог в проекте приложения) нажимает ключевые кнопки по `id=`; новые экраны от `@compose-expert` приходят с тегами.

## Replay (заполняется через N дней)

<pending>
