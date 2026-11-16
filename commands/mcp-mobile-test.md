---
description: "Проверка Android-приложения на живом устройстве/эмуляторе. Главный собирает бриф и спавнит `@mobile-tester`: он ходит по дереву UI через Android CLI (`android layout` + `android input` по селекторам, не по скриншотам), гоняет и сохраняет device-flow скрипты ключевых путей (оплата, вход, онбординг) в `tests/device-flows/` проекта; запасные — ARTEMIS и `mobile` MCP. Использовать для проверки UI, навигации, deeplinks, текста, состояний экранов, E2E smoke и регрессии flow после сборки и установки."
---

# MCP Mobile Test — проверка на устройстве

Проверку ведёт субагент `@mobile-tester`. Основной путь — дерево accessibility через Android CLI: агент читает `android layout`, нажимает `android input` по `id`/`text`/`desc` и проверяет экран деревом после каждого шага. Пройденный путь сохраняется bash-скриптом в `tests/device-flows/<flow>.sh` проекта и повторяется без LLM. Процедура и конвенции — `~/.claude/references/android-device-flows.md`.

Запасные пути — ARTEMIS (где дерева нет: Canvas, WebView, игры) и `mobile` MCP (deeplink, логи). Оба подключены **только у агента** — inline `mcpServers` в `~/.claude/agents/mobile-tester.md`. В главной сессии их нет намеренно: экономия ~0,55 GB RAM на сессию (improvements `2026-10-23-mcp-scope-subagents`). Не ищи `mcp__artemis__*` через `ToolSearch` и не обходи — спавни агента.

Готовый скрипт главный может прогнать и сам, без агента, из корня репозитория проекта: `DEVICE=<serial> APP=<package> bash tests/device-flows/<flow>.sh`. Exit 0 — `PASS`. Exit 1 — спавни агента с выводом скрипта.

## Аргументы

`$ARGUMENTS` — package, что проверять, уровень (`smoke` / `screen` / `flow` / `deeplink` / `full`), для `flow` — имя flow. Пусто — `AskUserQuestion`.

## Шаги главного

1. **Устройство.** `adb devices -l`. Устройств несколько — выбор через `AskUserQuestion` (у субагента его нет), дальше явный `device_serial`. Пусто — попроси подключить телефон или запусти `/install-emulator`: он поднимет AVD.
2. **Worktree.** Агент пишет скрипты в `tests/device-flows/` проекта, шаг 3 может править код. Перед спавном пишущего агента сессия уже в worktree задачи (`CLAUDE.md` § «Защищённая ветка и worktree»). Только прогон готовых скриптов без правок — можно из любого checkout.
3. **Флаг `testTagsAsResourceId`** — только Compose-приложение (в `*.kt` проекта есть `setContent` из `androidx.activity.compose`). `Grep` по `testTagsAsResourceId` в `*.kt` проекта. Нашёлся — дальше. Нет — до сборки спавни `@android-platform-expert` с брифом:
   ```
   Включи testTagsAsResourceId только в debug-сборке приложения <модуль с com.android.application>.
   Где: каждый setContent { } Activity в androidMain — semantics на корневом модификаторе,
   новый Box(Modifier.fillMaxSize().semantics { ... }) — только если корня с modifier нет.
   Значение: BuildConfig.DEBUG; buildConfig в модуле выключен — флаг FLAG_DEBUGGABLE из applicationInfo,
   buildFeatures не включать ради этого. Не трогать commonMain, release-поведение не меняется.
   Приёмка: компиляция модуля. Сборку, установку и проверку на устройстве делает главный.
   Рецепт и зачем — ~/.claude/references/android-device-flows.md § «Compose».
   ```
   Проверка после шага 4: `android layout --flat --device=<serial>` на экране с известным тегом — у узла есть `resource-id`.
   Это правка прод-кода по задаче проверки: строкой в отчёт пользователю.
4. **Сборка.** Свежая — `/install-device` или `/install-emulator` до спавна.
5. **Спавн `@mobile-tester`** с брифом. Код экрана, который ты уже читал в задаче, передавай путями и выдержками, а не названием фичи:
   ```
   Package: <applicationId>
   Устройство: <serial>
   Репозиторий: <абсолютный путь к корню проекта>
   Сборка: <чем и когда установлена | путь к APK>
   Что проверить: <ожидаемое поведение / критерий приёмки задачи>
   Уровень: <smoke | screen | flow <имя> | deeplink | full>
   Код экрана: <пути к Composable, strings.xml, testTag>
   Стартовое состояние: <залогинен ли, какие данные, откуда начать>
   Тестовые данные: <имена переменных окружения, не значения; для оплаты — license tester>
   ```
6. **Отчёт агента — пользователю:** статус, доказательства, пути к кадрам, строка «Скрипты». Новые или изменённые скрипты в `tests/device-flows/` — часть диффа задачи, они идут в коммит. «Находки для кода»: нет `testTagsAsResourceId` и `Grep` флага не находит → шаг 3; флаг в коде есть, а узел без `resource-id` → смотри, где узел: release-сборка — норма, нужен debug; `Dialog`, `ModalBottomSheet` или `Popup` — флаг нужен и на корне их содержимого (справочник § «Compose») → `@android-platform-expert`, при `commonMain` — вместе с `@kmp-expert`; элементы без `testTag` → `@compose-expert` одной пачкой (список из отчёта: экран, элемент, `file:line`, предложенный тег), затем сборка и повторный спавн `@mobile-tester` — он переводит селекторы скриптов на `id=`. Правки кода — строкой в отчёт пользователю. `MANUAL` → блок «Сделай руками», перепроверив шаги своими инструментами. `FAIL` с багом приложения → фикс специалисту по обычным правилам, затем повторный прогон скрипта.
7. `NEEDS_INPUT` → уточни у пользователя и `SendMessage` тому же агенту. `BLOCKED` → покажи пользователю строку починки из отчёта.

## Как включить ARTEMIS и `mobile` в главной сессии

Нужно редко: ручной разбор вместе с пользователем, `mobile` для iOS-симулятора, desktop или браузерного модуля. Включает пользователь, на одну сессию — перезапуском с продолжением диалога:

```powershell
claude --continue --mcp-config "$HOME/.claude/config/mcp/device.json"
```

Ничего не остаётся в конфиге: следующая сессия без флага стартует без этих серверов. Профиль `claude` — с `$env:CLAUDE_CONFIG_DIR=$null` перед командой.
