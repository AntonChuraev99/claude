---
date: 2026-11-16
slug: android-tree-nav
status: applied
goal: проверка на Android-устройстве идёт по дереву UI (Android CLI), а ключевые flow повторяются скриптами без LLM
metric: доля прогонов /mcp-mobile-test по дереву или скрипту против ARTEMIS; число flow в tests/device-flows/ с last-green; ложные PASS/FAIL
baseline_date: 2026-11-16
target_date: 2026-11-30
---

# Android: навигация по дереву UI и device-flow скрипты

## Цель

Пользователь попросил, чтобы агент ходил по приложению и нажимал элементы по дереву view, а не по скриншотам, и сохранял пройденный путь скриптами, привязанными к ключевым flow (оплата и т.п.).

## Baseline (2026-11-16)

- Основной исполнитель `/mcp-mobile-test` — ARTEMIS (с 2026-09-30, `2026-09-30-artemis-primary-mobile-testing`): Gemini flash-lite прокликивает сценарий, вердикт — по кадрам. Решения о кликах принимает не Claude; бесплатная квота Gemini ограничена, при исчерпании прогон падает таймаутом.
- Повтора пути без LLM нет: каждый прогон — новый LLM-сценарий.
- Хук `artemis-default-guard` отклонял первый вызов `mobile` MCP.
- Число прогонов по дереву — нечем измерить (такого пути не было).

## Гипотеза

Официальный Android CLI (`android layout` + `android input`, 1.1.16919734) даёт дерево accessibility и действия по селектору (`id`/`text`/`desc`, regex, `--match=single` с ошибкой на неоднозначность, `--wait`, JSON-статус и exit code 1 на сбой). Claude по подписке сам ведёт цикл observe → act → verify точнее, чем дешёвая vision-модель, и без расхода квоты. Сохранённый bash-скрипт превращает разовый проход в регрессию ключевого flow, которая идёт без LLM.

Сравнение кандидатов (best-practices-scout, 2026-11): mobile-mcp, claude-in-mobile/mcp-devices, appium-mcp, Maestro MCP, DroidRun, ARTEMIS, голый `uiautomator dump`. Android CLI выигрывает: селектор-движок от Google, встроенные ожидание idle и `scroll --until`, ноль MCP-схем в контексте, winget. Maestro отложен: нужна проверка на Windows; запись путём bash-скрипта выбрал пользователь.

## Замеры на эмуляторе (API 28, CLI 1.1.16919734, Git Bash)

- `android layout --flat` экрана «Настройки» — 4330 байт JSON с системными окнами (источник: `wc -c` по файлу `--output`).
- `input tap` на отсутствующий элемент — `no_matches`, exit 1; на неоднозначный — `multiple_matches` со списком кандидатов, exit 1 (источник: вывод `android input tap` в этой сессии).
- Git Bash (MSYS) переписывает аргумент `text=/regex/` как путь Windows: все regex-селекторы давали `no_matches` (источник: вывод `android input tap` в этой сессии). С `MSYS_NO_PATHCONV=1` — `success`, включая не-ASCII символ и запятую внутри regex.
- stdout `layout` на Windows теряет не-ASCII (`Wi‑Fi` → `Wi?Fi`); `JAVA_TOOL_OPTIONS=-Dstdout.encoding=UTF-8` или `--output=<файл>` отдают UTF-8.
- JSON дерева экранирует `&` как `\u0026`.
- Без `set -E` ловушка `ERR` не срабатывает, когда сбой внутри функции-хелпера: кадр сбоя не сохранялся.
- Шаблон скрипта прошёл пробный flow в «Настройках»: 3 шага с `expect_*` зелёные, четвёртый — намеренный сбой: exit 1, дерево и PNG сохранены. На Compose-приложении шаблон не прогонялся.

## Изменения

- `references/android-device-flows.md` — новый: инструмент, селекторы, цикл агента, грабли Windows, Compose (`testTagsAsResourceId`, источник: developer.android.com/develop/ui/compose/testing/interoperability), где дерева нет, конвенция `tests/device-flows/` с индексом `README.md`, правила оплаты (license tester), жизненный цикл скрипта.
- `references/android-device-flow-template.sh` — новый: шаблон скрипта с хелперами `tap`/`type_into`/`submit`/`key`/`scroll_to`/`expect_*` и ловушкой сбоя.
- `agents/mobile-tester.md` — основной путь: готовый скрипт → проход по дереву → сохранение скрипта; ARTEMIS и `mobile` MCP — запасные; добавлены `Write`, `Edit` (только `tests/device-flows/`).
- `commands/mcp-mobile-test.md` — новый порядок, worktree до спавна пишущего агента, поля брифа «Репозиторий» и «Тестовые данные», прогон скрипта главным без агента.
- `CLAUDE.md` § «Автономность» — строка про проверку на Android-устройстве.
- `hooks/artemis-default-guard.js` и тесты — удалены, регистрация убрана из `settings.example.json`: дефолт больше не ARTEMIS, а `mobile` MCP подключён только у `@mobile-tester`.

## Target

К 2026-11-30:
- `/mcp-mobile-test` идёт по дереву или скрипту в большинстве прогонов; ARTEMIS — только для экранов без дерева.
- В рабочем проекте есть хотя бы один ключевой flow (оплата или вход) в `tests/device-flows/` с `last-green`.
- Нет ложного `PASS` по скрипту (скрипт зелёный, а flow сломан).

## Replay (заполняется через N дней)

<pending>
