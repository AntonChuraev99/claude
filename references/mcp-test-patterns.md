# MCP Mobile Test — Паттерны и опыт из реальных проектов

Этот файл содержит детальные паттерны, типичные ошибки и решения, накопленные при тестировании Android-приложений с разной архитектурой: одно на Hilt (single-activity, кастомные deeplink-маршруты, медиаплеер), другое на KMP (Koin, MVI, Room DB).

---

## 1. Критические ошибки при MCP-тестировании

### 1.1. Неправильные текстовые лейблы

**Проблема:** Тесты ищут текст, который отличается от реального UI. Причины: A/B тесты, Remote Config, обновления дизайна, i18n.

**Типичные случаи (текст в макете ≠ текст на экране):**
- Искали заголовок paywall из макета → на экране A/B-вариант ("3 Days for Free")
- Искали "Subscribe" → реально "Start your FREE trial"
- Искали "Restore Purchases" → реально "Restore Purchase" (без s — расхождение в одну букву)

**Решение:** Перед написанием assert — ВСЕГДА делать `analyze_screen` или `get_ui` чтобы увидеть точные тексты. НЕ полагаться на макеты или документацию.

```
# ПРАВИЛЬНО: сначала посмотреть, потом assertить
mcp__mobile__analyze_screen
# ... увидели реальный текст "Start your FREE trial"
mcp__mobile__assert_visible (text: "Start your FREE trial")

# НЕПРАВИЛЬНО: assertить текст из дизайна/доки
mcp__mobile__assert_visible (text: "Subscribe")  # может не совпадать!
```

### 1.2. Множественные совпадения текста

**Проблема:** Один текст встречается на экране несколько раз — assert/tap неоднозначны.

**Реальные случаи:**
- "Share" — 3 совпадения (заголовок, кнопка, подпись)
- "credits" — 3 совпадения (баланс, описание, кнопка)

**Решение:** Использовать `resourceId` вместо `text`, или `find_element` для проверки количества совпадений.

```
# Проверить сколько элементов с текстом "Share"
mcp__mobile__find_element (text: "Share")
# Если несколько — использовать resourceId
mcp__mobile__tap (resourceId: "share_button")
```

### 1.3. ModalBottomSheet невидим в UI-дереве

**Проблема (popup-окна):** `testTag` на `ModalBottomSheet` НЕ виден через UIAutomator/get_ui, т.к. sheet открывается в отдельном popup-окне.

**Решение:** Проверять содержимое sheet по тексту, не по resourceId:

```
# НЕПРАВИЛЬНО — не найдёт
mcp__mobile__assert_visible (resourceId: "select_face_sheet")

# ПРАВИЛЬНО — проверяем текст внутри sheet
mcp__mobile__assert_visible (text: "Select Face")
```

### 1.4. clearPackageData сбрасывает состояние

**Проблема (freemium):** Test Orchestrator с `clearPackageData = true` обнуляет кредиты → Analyze-экран показывает "Not enough credits" вместо полей ввода.

**Решение:** При тестировании freemium-приложений учитывать дефолтное состояние после чистой установки:
- 0 credits = ограниченный функционал
- Нет авторизации = ограниченный доступ
- Пустая БД = empty state

```
# Проверить начальный экран с 0 кредитов
mcp__mobile__screenshot (waitForStable: true)
# Убедиться что видим paywall или "Not enough credits"
mcp__mobile__assert_visible (text: "Not enough credits")
```

### 1.5. Toolbar collapse скрывает заголовок

**Проблема (collapsing toolbar):** `CollapsingToolbarLayout` при скролле скрывает название — assert по заголовку ненадёжен.

**Решение:** Assertить по стабильным элементам внутри контента, а не по toolbar:

```
# НЕНАДЁЖНО — toolbar может быть свёрнут
mcp__mobile__assert_visible (text: "Checklist Name")

# НАДЁЖНО — кнопка внутри контента всегда видна
mcp__mobile__assert_visible (text: "Create New Fill")
```

---

## 2. Паттерны тестирования по типам

### 2.1. Smoke Test (быстрая проверка)

Минимальный набор для проверки что приложение живо:

1. Приложение запускается без краша
2. Splash/Onboarding проходит
3. Главный экран загружается
4. Навигация между основными табами работает
5. Базовое действие выполняется (создание, просмотр)

```
# Smoke test flow
mcp__mobile__launch_app (package: "<pkg>")
mcp__mobile__wait_for_element (text: "Home", timeout: 10000)
mcp__mobile__screenshot (waitForStable: true)
mcp__mobile__tap (text: "Settings")
mcp__mobile__wait_for_element (text: "Settings", timeout: 5000)
mcp__mobile__press_key (key: "back")
mcp__mobile__assert_visible (text: "Home")
```

### 2.2. Screen Test (проверка конкретного экрана)

Для каждого экрана проверять:

| Аспект | Как проверять | MCP-инструмент |
|--------|--------------|----------------|
| Визуальная целостность | Скриншот | `screenshot` |
| Все элементы на месте | Текст, кнопки, поля | `analyze_screen` / `assert_visible` |
| Empty state | Нет данных | `assert_visible (text: "No items")` |
| Loading state | Индикатор загрузки | `screenshot` + анализ |
| Error state | Нет сети, ошибка API | `shell` для отключения сети + `screenshot` |
| Scrollable content | Контент за пределами экрана | `swipe (direction: "up")` + `screenshot (diff: true)` |

### 2.3. Flow Test (пользовательский путь)

Тестирование полного сценария от начала до конца. Использовать `run_flow` для оптимизации.

**Паттерн "Create-Read-Update-Delete":**
```
mcp__mobile__run_flow (steps: [
  # CREATE
  {"action": "tap", "args": {"text": "Create"}, "label": "Open create form"},
  {"action": "wait", "args": {"ms": 500}},
  {"action": "input_text", "args": {"text": "Test Item"}, "label": "Enter name"},
  {"action": "tap", "args": {"text": "Save"}, "label": "Save"},
  {"action": "wait_for_element", "args": {"text": "Test Item"}, "label": "Verify created"},

  # READ
  {"action": "tap", "args": {"text": "Test Item"}, "label": "Open detail"},
  {"action": "assert_visible", "args": {"text": "Test Item"}, "label": "Verify detail"},

  # UPDATE
  {"action": "tap", "args": {"text": "Edit"}, "if_not_found": "scroll_down", "label": "Find edit"},
  {"action": "assert_visible", "args": {"text": "Test Item"}, "label": "Verify edit form"},

  # DELETE
  {"action": "tap", "args": {"text": "Delete"}, "if_not_found": "scroll_down", "label": "Find delete"},
  {"action": "assert_not_exists", "args": {"text": "Test Item"}, "label": "Verify deleted"}
])
```

### 2.4. Deeplink Test

**Паттерн deeplink-тестирования (пример с 34 маршрутами):**

1. Открыть deeplink через `open_url`
2. Подождать загрузку (cold start ~10-15 сек, hot start ~5 сек)
3. Проверить целевой экран по testTag (resourceId)
4. Проверить что back-stack корректный (нажать back → увидеть предыдущий экран)

```
# Cold start deeplink test
mcp__mobile__shell (command: "am force-stop <package>")
mcp__mobile__wait (ms: 1000)
mcp__mobile__open_url (url: "scheme://path?param=value")
mcp__mobile__wait_for_element (resourceId: "target_screen", timeout: 15000)
mcp__mobile__screenshot (waitForStable: true)
mcp__mobile__assert_visible (resourceId: "target_screen")

# Проверка back-stack
mcp__mobile__press_key (key: "back")
mcp__mobile__wait (ms: 500)
mcp__mobile__assert_visible (resourceId: "main_screen")
```

**Типы deeplink для тестирования:**
- `scheme://path` — кастомная схема (myapp://, ...)
- `https://domain/path` — Universal Links / App Links
- Hot start (приложение уже запущено) vs Cold start
- С параметрами и без

**404 — это OK:** Для deeplink-тестов навигации можно использовать несуществующие ID (например `test_item_001`). Цель — проверить навигацию, а не данные.

### 2.5. Onboarding Skip

**Паттерн skip onboarding:**

```
mcp__mobile__run_flow (steps: [
  {"action": "wait_for_element", "args": {"text": "Skip"}, "label": "Wait for onboarding"},
  {"action": "tap", "args": {"text": "Skip"}, "if_not_found": "skip", "label": "Skip onboarding"},
  {"action": "wait_for_element", "args": {"text": "Home"}, "label": "Wait for main screen"}
])
```

Если onboarding не появляется (повторный запуск) — `if_not_found: "skip"` предотвращает падение.

---

## 3. Оптимизация кредитов/токенов

### Стоимость инструментов (от дешёвого к дорогому)

| Инструмент | Стоимость | Когда использовать |
|------------|-----------|-------------------|
| `assert_visible` / `assert_not_exists` | Минимальная | Проверка наличия/отсутствия элемента |
| `find_element` | Низкая | Поиск элемента, проверка количества совпадений |
| `analyze_screen` | Средняя | Понимание структуры экрана без визуала |
| `get_ui` | Средняя | Полное UI-дерево, resourceId, координаты |
| `screenshot (diff: true)` | Средняя | Только изменения после действия |
| `screenshot` | Высокая | Полный визуальный контроль |
| `annotate_screenshot` | Высокая | Скриншот с разметкой элементов |

### Паттерн экономии

```
# ДОРОГО: скриншот после каждого действия
mcp__mobile__tap (text: "Button")
mcp__mobile__screenshot  # ~1000 токенов
mcp__mobile__tap (text: "Next")
mcp__mobile__screenshot  # ~1000 токенов

# ДЁШЕВО: hints + assert + diff-скриншот в конце
mcp__mobile__tap (text: "Button", hints: true)  # hints расскажет что изменилось
mcp__mobile__tap (text: "Next", hints: true)
mcp__mobile__assert_visible (text: "Final Screen")  # дешёвая проверка
mcp__mobile__screenshot (diff: true)  # один скриншот в конце, только изменения
```

---

## 4. Compose-специфика

### testTag и resourceId

В Jetpack Compose `testTag` маппится на `resourceId` через:
```kotlin
Modifier
    .semantics { testTagsAsResourceId = true }
    .testTag("screen_name")
```

При MCP-тестировании:
```
# testTag "premium_screen" → resourceId "premium_screen"
mcp__mobile__assert_visible (resourceId: "premium_screen")
mcp__mobile__tap (resourceId: "premium_screen")
```

### Пример: соглашение об именовании testTag (`<feature>_screen`)

Договорись в проекте о стабильной схеме testTag для корневого узла каждого экрана — `<feature>_screen` — и тестируй по `resourceId`, а не по тексту. Пример набора:

| testTag | Экран |
|---------|-------|
| `premium_screen` | Premium / Paywall |
| `one_time_offer_screen` | One-time offer |
| `settings_screen` | Settings |
| `profile_screen` | Profile |
| `catalog_screen` | Catalog (список) |
| `full_item_screen` | Детальный экран элемента |
| `<feature>_screen` | …по одному на каждый экран фичи |

---

## 5. Тестовые сценарии по доменам

### 5.1. Paywall / Premium

- Paywall отображается с правильными ценами
- Trial текст корректен (точная строка из текущего билда, не из макета)
- Кнопка восстановления покупок видна
- Paywall не блокирует бесплатный контент
- Privacy Policy / Terms of Service ссылки кликабельны

### 5.2. Credits / Freemium

- Баланс отображается корректно
- При 0 кредитов — показывается paywall или ограничение
- После покупки — кредиты обновляются (instant restore)
- Дедукция: сначала базовые, потом extra кредиты

### 5.3. Navigation / Bottom Tabs

- Все табы переключаются
- Back-stack корректный (не уходит в бесконечный цикл)
- Deep-link не ломает back-stack
- Tab re-selection скроллит к верху / не создаёт дубль

### 5.4. AI / Async Operations

- Loading indicator показывается
- Error state обрабатывается (нет сети, таймаут, ошибка API)
- Результат отображается корректно
- Повторная попытка работает

### 5.5. Media (Video / Image)

- Видео загружается и воспроизводится
- Карусель листается
- Placeholder показывается до загрузки
- Fullscreen работает корректно

### 5.6. Forms / Input

- Валидация работает (пустое поле, длинный текст, спецсимволы)
- Клавиатура не перекрывает поле ввода
- Submit отправляет данные
- Error message отображается

---

## 6. Debug-чеклист при падении теста

1. **Сделать скриншот** — `screenshot (waitForStable: true)` — увидеть текущее состояние
2. **Проверить UI-дерево** — `get_ui (showAll: true)` — найти элемент в дереве
3. **Прочитать логи** — `get_logs (level: "E", lines: 50)` — найти exception/crash
4. **Проверить activity** — `shell (command: "dumpsys activity top")` — какой экран реально показан
5. **Проверить текст** — `analyze_screen` — увидеть реальные тексты, а не ожидаемые

---

## 7. Инфраструктурные паттерны

### Mock Auth для тестирования

```
# Запуск с bypass auth через intent extra
mcp__mobile__shell (command: "am start -n <package>/<activity> --ez TEST_BYPASS_AUTH true --ez TEST_MOCK_PREMIUM true")
```

### Сетевые условия

```
# Отключить Wi-Fi (для offline-теста)
mcp__mobile__shell (command: "svc wifi disable")
# Включить обратно
mcp__mobile__shell (command: "svc wifi enable")
```

### Очистка данных приложения

```
# Полная очистка
mcp__mobile__shell (command: "pm clear <package>")
# Только кэш
mcp__mobile__shell (command: "pm clear --cache-only <package>")
```

### Доступные эмуляторы

Перед запуском тестов — проверить через `list_devices`. Известные эмуляторы:
- **Пример 1**: Pixel 9, Medium_Phone_API_36
- **Пример 2**: Pixel_9, Medium_Phone_API_36.1
