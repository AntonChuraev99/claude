---
description: "Тестирование Android-приложения через MCP mobile tools. Запускает визуальное тестирование на подключённом устройстве/эмуляторе. Использовать когда нужно проверить UI, навигацию, deeplinks, текст, состояния экранов или провести E2E smoke-тест."
---

# MCP Mobile Test — Android UI Testing Skill

Систематическое тестирование Android-приложения через MCP mobile tools на подключённом устройстве/эмуляторе. Включает опыт реальных проектов (десятки E2E- и instrumented-тестов, множество deeplink-паттернов).

## Аргументы

Пользователь может передать аргументы: `$ARGUMENTS`

Если аргументы пустые — запросить через AskUserQuestion:
1. Какое приложение тестировать (package name)
2. Что именно тестировать (экран, фичу, флоу, deeplink)
3. Уровень тестирования: `smoke` (быстрая проверка), `screen` (конкретный экран), `flow` (пользовательский путь), `deeplink` (deeplink-маршруты), `full` (полный прогон)

## Phase 0: Setup

1. Найти устройство:
```
mcp__mobile__list_devices (platform: "android")
```

2. Установить целевое устройство:
```
mcp__mobile__set_device (deviceId: "<id>")
```

3. Запустить приложение:
```
mcp__mobile__launch_app (package: "<package_name>")
```

4. Дождаться загрузки и сделать первый скриншот:
```
mcp__mobile__wait (ms: 2000)
mcp__mobile__screenshot (waitForStable: true)
```

## Phase 1: Screen Inspection (экран)

Для каждого тестируемого экрана — трёхшаговая верификация:

### Шаг 1: Визуальный осмотр
```
mcp__mobile__screenshot (waitForStable: true)
```
Проверить: layout не сломан, элементы видимы, текст не обрезан, нет артефактов.

### Шаг 2: Структурный анализ
```
mcp__mobile__analyze_screen
```
Проверить: все ожидаемые кнопки, поля, заголовки на месте. Определить scrollable-области.

### Шаг 3: UI-дерево (при необходимости)
```
mcp__mobile__get_ui (showAll: false)
```
Использовать для: поиска resourceId, проверки testTag, уточнения координат, обнаружения скрытых элементов.

### Шаг 4: Assert-проверки (дешёвые, без скриншотов)
```
mcp__mobile__assert_visible (text: "Expected text")
mcp__mobile__assert_visible (resourceId: "expected_tag")
mcp__mobile__assert_not_exists (text: "Error")
```

## Phase 2: Navigation Testing

### Тестирование навигации между экранами
```
# Нажать на элемент
mcp__mobile__tap (text: "Settings")
# или по resourceId (надёжнее):
mcp__mobile__tap (resourceId: "settings_screen")
# или fuzzy-поиск:
mcp__mobile__find_and_tap (description: "settings button")

# Подождать переход
mcp__mobile__wait_for_element (text: "Settings", timeout: 5000)

# Проверить что экран появился
mcp__mobile__assert_visible (text: "Settings")

# Скриншот для верификации
mcp__mobile__screenshot (diff: true)
```

### Навигация назад
```
mcp__mobile__press_key (key: "back")
mcp__mobile__wait (ms: 500)
mcp__mobile__assert_visible (text: "Previous screen title")
```

## Phase 3: Input Testing

```
# Найти поле и тапнуть
mcp__mobile__tap (resourceId: "input_field")
# Ввести текст
mcp__mobile__input_text (text: "Test input value")
# Скриншот для проверки
mcp__mobile__screenshot (diff: true)
```

## Phase 4: Deeplink Testing

```
# Открыть deeplink
mcp__mobile__open_url (url: "myapp://premium")
mcp__mobile__wait (ms: 3000)

# Проверить что открылся правильный экран
mcp__mobile__screenshot (waitForStable: true)
mcp__mobile__assert_visible (resourceId: "premium_screen")
```

## Phase 5: Scroll & Swipe

```
# Свайп вверх (скролл вниз)
mcp__mobile__swipe (direction: "up")
mcp__mobile__screenshot (diff: true)

# Свайп вправо (карусель)
mcp__mobile__swipe (direction: "left")
```

## Phase 6: Batch & Flow (оптимизация)

### batch_commands — последовательные шаги без условной логики
```
mcp__mobile__batch_commands (commands: [
  {"name": "tap", "arguments": {"text": "Create"}},
  {"name": "wait", "arguments": {"ms": 1000}},
  {"name": "input_text", "arguments": {"text": "Test Checklist"}},
  {"name": "tap", "arguments": {"text": "Save"}},
  {"name": "wait_for_element", "arguments": {"text": "Test Checklist", "timeout": 5000}}
])
```

### run_flow — сложные сценарии с условиями и циклами
```
mcp__mobile__run_flow (steps: [
  {"action": "tap", "args": {"text": "Add Item"}, "if_not_found": "scroll_down", "label": "Find add button"},
  {"action": "wait", "args": {"ms": 500}},
  {"action": "input_text", "args": {"text": "New item"}},
  {"action": "tap", "args": {"text": "Save"}, "on_error": "retry"},
  {"action": "assert_visible", "args": {"text": "New item"}, "label": "Verify saved"}
])
```

## Phase 7: Debug & Logs

При обнаружении ошибки:
```
mcp__mobile__get_logs (package: "<package_name>", level: "E", lines: 50)
```

## Принципы тестирования (из опыта)

Перед написанием тестов — обязательно прочитать reference файл:
`~/.claude/references/mcp-test-patterns.md`

Содержит детальные паттерны, типичные ошибки и решения из 90+ реальных тестов.

### Критические правила

1. **assert_visible дешевле screenshot** — для проверки текста/элементов использовать assert, скриншоты — для визуальной верификации
2. **wait_for_element > wait(ms)** — никогда не полагаться на фиксированные задержки, всегда ждать конкретный элемент
3. **diff: true экономит токены** — после действий использовать `screenshot(diff: true)`, чтобы видеть только изменения
4. **analyze_screen дешевле screenshot** — для понимания структуры экрана без визуальной проверки
5. **resourceId надёжнее text** — текст может меняться (i18n, A/B тесты), resourceId стабильнее
6. **batch_commands для простых последовательностей** — 2-4x быстрее отдельных вызовов
7. **run_flow для условной логики** — if_not_found: "scroll_down" вместо ручного скролла
8. **hints: true** — после tap/swipe использовать hints чтобы узнать что изменилось без screenshot

## Формат отчёта

После тестирования — предоставить отчёт:

```
## Результат тестирования [App Name]

**Устройство:** [device_id]
**Дата:** [дата]
**Уровень:** smoke / screen / flow / deeplink / full

### Пройдено
- [x] Описание проверки — OK
- [x] Описание проверки — OK

### Проблемы
- [ ] Описание проблемы — скриншот / лог

### Рекомендации
- Что исправить
- Что проверить дополнительно
```
