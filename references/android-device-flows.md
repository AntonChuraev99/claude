# Android: навигация по дереву UI и device-flow скрипты

Как агент ходит по Android-приложению на живом устройстве: по дереву accessibility через Android CLI, а не по скриншотам. Пройденный путь сохраняется скриптом и повторяется без LLM. Исполнитель — `@mobile-tester` (`agents/mobile-tester.md`), вход — `/mcp-mobile-test`. Решение и замеры — `improvements/2026-11-16-android-tree-nav.md`.

## Инструмент

Android CLI от Google, версия не ниже `1.1.16919734` (`android --version`, обновление — `android update`). Установка на Windows: `winget install -e --id Google.AndroidCLI` (источник: android-developers.googleblog.com, «Android CLI stable 1.0», 2026-05). Вызов — через Bash, MCP не нужен.

| Команда | Что делает |
|---|---|
| `android layout --flat --device=<serial>` | плоский JSON интерактивных узлов: `text`, `resource-id`, `content-desc`, `class`, `interactions`, `bounds`, `center`. Сам ждёт idle |
| `android layout --flat --no-idle` | то же без ожидания idle — для экранов с бесконечной анимацией (shimmer, progress) |
| `android layout --full` | всё дерево, включая неинтерактивные и скрытые узлы — когда нужного узла нет в `--flat` |
| `android input tap '<селектор>' --wait=<ms>` | нажать; `--wait` ждёт появления элемента |
| `android input text '<текст>' '<селектор поля>' [--submit]` | ввести текст |
| `android input scroll '<контейнер>' --until='<цель>' --dir=down` | листать до элемента |
| `android input swipe`, `android input key back\|enter\|home` | жест, клавиша |
| `android screen capture --output=<png> [--annotate]` | кадр; `--annotate` нумерует найденные зрением элементы |

Результат `input` — JSON `results[].status`: `success`, `no_matches`, `multiple_matches` (со списком `matches`; источник: вывод `android input tap` на эмуляторе 2026-11-16). Сбой даёт exit code 1, поэтому скрипт с `set -e` останавливается на сломанном шаге.

## Селектор

Пары `key=value` через запятую: `id=`, `text=`, `desc=`, `class=`, `clickable=true`, `checked=`, `scrollable=` и др. Строка — подстрока без учёта регистра: `text=pay` найдёт и «Pay», и «Repayment». Точное совпадение — regex: `text=/^Оплатить$/`. Текст с запятой — только regex: без него запятая делит селектор.

Порядок выбора:
1. `id=<testTag>` — не зависит от языка и текста.
2. `text=/^…$/` — точный текст из `strings.xml` (не проверено — файл проекта приложения, вне репозитория харнесса).
3. `desc=` — для иконок без текста.
4. `class=…,clickable=true` плюс уточнение — крайний случай.

Координаты (`center`) — только в запасном пути, где дерева нет.

Статус `multiple_matches` (источник: вывод `android input tap` на эмуляторе 2026-11-16) означает, что селектор неоднозначен. Уточни селектор. `--match=first` допустим только с комментарием в скрипте, почему порядок стабилен.

## Цикл агента

1. **Observe.** `android layout --flat` — найди нужный узел.
2. **Act.** `android input …` по селектору из шага 1.
3. **Verify.** Снова `layout` или `expect_*` в скрипте: экран сменился так, как ждали. Действие без проверки — не шаг.
4. Шаг записывается в черновик скрипта сразу, тем селектором, который сработал.

## Грабли Windows (замерено 2026-11-16, эмулятор API 28, CLI 1.1.16919734)

- **Git Bash портит regex.** MSYS превращает `text=/^Network/` в путь Windows, и селектор ничего не находит. Перед вызовами — `export MSYS_NO_PATHCONV=1`. Шаблон делает это сам.
- **Кириллица в stdout.** `android layout` пишет stdout в кодировке консоли, и не-ASCII символы становятся `?`. Лечение — `JAVA_TOOL_OPTIONS=-Dstdout.encoding=UTF-8` или `--output=<файл>`: файл всегда UTF-8. В аргументах селектора кириллица доходит без потерь.
- **JSON экранирует** `&`, `<`, `>`, `=`, `'` как `\u00XX`: «Network & internet» лежит в дереве как `Network \u0026 internet` (источник: вывод `android layout` на эмуляторе 2026-11-16). `expect_text` шаблона учитывает это сам. Свой `grep` по дереву — учитывай.

## Compose

Связка из двух частей. Тег (`Modifier.testTag`) — общий API, ставится в `commonMain`. Флаг `testTagsAsResourceId` — только Android (источник: developer.android.com/reference/kotlin/androidx/compose/ui/semantics/SemanticsPropertiesAndroid, Compose UI 1.2.0+), ставится в `androidMain`. Флаг действует на всё поддерево semantics: одного раза на корне `setContent` хватает для экранов Activity (источник: тот же раздел, описание свойства). `Dialog`, `ModalBottomSheet` и `Popup` открываются в своём окне со своим деревом, и флаг с корня Activity туда, вероятно, не доходит (не проверено — вывод из устройства Compose, источника нет). Признак: в коде у элемента диалога есть тег, а в `android layout` у узла нет `resource-id`. Тогда флаг ставится и на корень содержимого диалога. В `commonMain` это делается через `expect`/`actual`-модификатор, и решение принимает `@kmp-expert`.

**Флаг — только debug, один раз на Activity.** Кто ставит — `@android-platform-expert`, когда `/mcp-mobile-test` не нашёл флага в проекте (команда, шаг 3):

```kotlin
setContent { // источник: developer.android.com/reference/kotlin/androidx/compose/ui/semantics/SemanticsPropertiesAndroid
    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = BuildConfig.DEBUG }) { // источник: тот же раздел
        App()
    }
}
```

Есть корневой composable с параметром `modifier` — semantics вешается на него, лишний `Box` не нужен. Если `buildConfig` в модуле выключен, вместо `BuildConfig.DEBUG` берётся `(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0` (источник: developer.android.com/reference/android/content/pm/ApplicationInfo). Включать `buildFeatures.buildConfig` (источник: AGP DSL, developer.android.com/reference/tools/gradle-api) ради одного флага не нужно. В release-сборке флаг выключен, поэтому release проверяется только по `text=`.

**Теги — на каждом actionable-элементе.** Кто ставит — `@compose-expert` на каждом новом или изменённом экране (правило в его агенте):
- формат `<экран>_<элемент>`, snake_case латиницей: `checkout_pay_button`, `login_email_field` (не проверено — имена-примеры, в коде их нет);
- без текста интерфейса и без индекса позиции; элемент списка — с id сущности: `cart_item_<id>` (не проверено — имя-пример);
- на кликабельном контейнере, а не на внутреннем `Text`;
- существующий тег не переименовывается: на него завязаны скрипты `tests/device-flows/`.

Нет тега у нужного элемента — находка для отчёта `@mobile-tester` с предложенным тегом, а не повод перейти на координаты. Главный отдаёт такие находки `@compose-expert` одной пачкой.

Проверка связки на устройстве: `android layout --flat` — у узла с тегом поле `"resource-id":"checkout_pay_button"`, селектор `id=checkout_pay_button` нажимает его. Форма значения `resource-id` для Compose-тега не проверялась (не проверено — пробы шли на системных View); селектор `id=` ищет подстроку и сработает при любой форме.

## Где дерева нет

WebView без accessibility, Canvas, игры, карты, нативный диалог оплаты с картинками вместо текста. Порядок:
1. `android layout --full` — узел мог быть скрыт фильтром.
2. `android screen capture --annotate --output=<png>`, открой кадр, затем `android screen resolve --screenshot=<png> --string="input tap #N"` подставит координаты центра рамки `N`. Полученную строку выполни через `adb -s <serial> shell`. Метки действительны только для этого кадра.
3. ARTEMIS (`mcp__artemis__*`, только у `@mobile-tester`) — гибрид дерева, OCR и зрения на Gemini.

## Device-flow скрипты в проекте

Пройденный агентом путь сохраняется как bash-скрипт и повторяется без LLM: регрессия ключевых flow (оплата, вход, онбординг) после каждой правки рядом.

**Где:** `tests/device-flows/` в репозитории проекта.
- `<flow>.sh` — один скрипт на один flow. Шаблон — `~/.claude/references/android-device-flow-template.sh`: шапка-метаданные, хелперы (`tap`, `type_into`, `submit`, `key`, `scroll_to`, `expect_text`, `expect_id`, `expect_gone`), ловушка сбоя с деревом и кадром в `build/device-flows/`.
- `README.md` — индекс, связь с ключевыми flow продукта:

```markdown
| flow | ключевой путь | проверяет | требует | last-green |
|---|---|---|---|---|
| payment-subscription | оплата | покупка месячной подписки открывает премиум | license tester, тестовая карта | 2026-11-16 · 1.4.2 |
| login-email | вход | вход по email ведёт на главный экран | тестовый аккаунт | 2026-11-16 · 1.4.2 |
```

Строки выше — пример формата. Колонка `flow` — имя скрипта без `.sh`; в настоящем индексе это ссылка на файл скрипта.

**Запуск** из корня репозитория проекта: `DEVICE=<serial> APP=<applicationId> bash tests/device-flows/<flow>.sh`. Обе переменные обязательны: без них скрипт сразу останавливается с подсказкой. Exit 0 — `PASS <flow>`, иначе `FAIL <flow> на шаге: …` и пути к дереву и кадру.

**Правила скрипта:**
- Скрипт сам открывает приложение (`launch`) и не зависит от того, что было на экране.
- После каждого значимого действия — `expect_*`. Финальная проверка доказывает строку `проверяет` из индекса.
- Никаких `sleep` вместо ожидания: `--wait` у действий и `expect_*` с таймаутом.
- Данные для входа — из переменных окружения (например `TEST_EMAIL`, `TEST_PASSWORD` (не проверено — имена задаёт проект)), не в тексте скрипта.
- Секретов, реальных карт и личных данных в скрипте нет.

**Оплата.** Только аккаунт из списка license testers в Play Console и тестовая карта Google Play («Test card, always approves»). Реальная покупка в скрипте и в прогоне агента запрещена: это трата денег (`CLAUDE.md` § «Автономность»). Диалог Google Play — окно пакета `com.android.vending` (не проверено — пакет Google Play Store, дерево диалога покупки в этой задаче не снималось), оно должно быть в дереве; нет — запасной путь из раздела «Где дерева нет». Отмена тестовой подписки — вручную или отдельным flow.

**Жизненный цикл:**
1. Проверка затрагивает flow из индекса → сначала прогон скрипта.
2. `PASS` → вердикт по скрипту, исследование не нужно.
3. `FAIL` → открой дерево и кадр сбоя. Отличи баг приложения (экран не тот, краш — `adb logcat -d`) от устаревшего селектора (элемент на месте, но сменились id или текст).
4. Устаревший селектор → пройди шаг циклом агента, поправь скрипт, прогони целиком до `PASS`, обнови `last-green`.
5. Новый flow → пройди циклом агента, сохрани скрипт по шаблону, добавь строку в индекс, прогони скрипт с нуля до `PASS`.

Скрипт, который не прошёл с нуля, в индекс не попадает.
