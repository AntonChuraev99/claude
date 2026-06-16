---
allowed-tools: Bash(adb:*), Bash(./gradlew:*), Bash(./gradlew.bat:*), Bash(ls:*), Bash(file:*), Glob, Grep, Read, AskUserQuestion
description: Build debug APK and install on connected physical Android device (auto-detects app module via com.android.application plugin — AGP 9 KMP split aware, handles multi-device, never uninstalls)
---

# Install APK on Physical Device

Собрать debug APK текущего Android/KMP-проекта и установить на подключённое **физическое** устройство (USB или Wi-Fi debugging).

Команда выполняется только при явном запуске пользователя. Все шаги — последовательно. На любом fail — понятное сообщение и stop, не пытаться обходить.

## Шаг 1. Проверить, что мы в Gradle-проекте

Через `Glob` найти в текущей рабочей директории `settings.gradle.kts` или `settings.gradle`. Если ни одного нет — вывести и завершить:

> ❌ Не похоже на Gradle-проект (нет `settings.gradle[.kts]` в текущей директории). Запусти команду из корня Android/KMP проекта.

## Шаг 2. Auto-detect app-модуля

**Источник истины — `com.android.application` plugin, а не имена директорий.** В современных KMP-проектах с AGP 9 module split распространённая ловушка: `composeApp` — это **KMP library** (без application plugin), а Android app лежит в отдельном модуле (`androidApp`, `app`). Полагаться на знакомое имя директории нельзя.

**Алгоритм:**

1. Через `Grep` собрать кандидатов:
   - pattern: `com\.android\.application|androidApplication`
   - glob: `**/build.gradle*`
   - output_mode: `content`, `-n: true` (нужны строки чтобы отфильтровать `apply false`)

2. **Отфильтровать декларации `apply false`.** Root `build.gradle.kts` обычно содержит `alias(libs.plugins.androidApplication) apply false` или `id("com.android.application") apply false` — это plugin-management, **не** активный application module. Для каждой найденной строки:
   - Если в строке есть `apply false` или `apply(false)` — пропустить.
   - Иначе считать файл кандидатом.

3. **Исключить root build** — если матч в `./build.gradle*` (нет директории-модуля перед именем файла), пропустить.

4. **Извлечь имена модулей** из путей кандидатов: `<module>/build.gradle.kts` → `MODULE = <module>` (для вложенных — `<group>/<module>` → Gradle path `:<group>:<module>`).

5. Случаи:
   - **1 кандидат** — это `MODULE`, продолжить.
   - **2+ кандидатов** (multi-app: app + benchmark; разные flavors модулей) — `AskUserQuestion`, options = найденные модули.
   - **0 кандидатов** — вывести и завершить:
     > ❌ Не найден модуль с активным плагином `com.android.application` (все упоминания — `apply false` или в root). Проверь, что это Android-проект и что есть модуль-app.

**Sanity-check (Recommended).** Если найденный `MODULE` совпадает с `composeApp`, **дополнительно** убедиться что в его `build.gradle.kts` нет `com.android.kotlin.multiplatform.library` или `kotlin("multiplatform")` без `com.android.application` — это сигнал что произошёл AGP 9 split и application module теперь где-то ещё. В этом случае повторить grep с фильтром, исключив `composeApp/build.gradle*` из списка кандидатов.

## Шаг 3. Найти физическое устройство

Запустить:

```bash
adb devices -l
```

Если команда не нашлась (`command not found` / `'adb' is not recognized`):

> ❌ `adb` не найден в PATH. Установи Android SDK Platform-Tools и добавь в PATH (`$ANDROID_HOME/platform-tools`).

**Парсинг.** Игнорировать первую строку `List of devices attached` и пустые строки. Каждая валидная строка — `<serial>  <state>  [product:... model:... device:... transport_id:...]`.

**Физическое устройство** = `state == "device"` И **serial НЕ начинается с `emulator-`**.

Случаи:

- **0 физических** — вывести и завершить:
  > ❌ Физическое устройство не найдено. Проверь:
  > - USB-кабель подключён (или Wi-Fi debugging активен)
  > - На устройстве включена «Отладка по USB» (Developer options → USB debugging)
  > - На устройстве принято разрешение для этого хоста (state НЕ должен быть `unauthorized` или `offline`)
  > - Драйвер устройства установлен (Windows)
  >
  > Текущий вывод `adb devices -l`:
  > ```
  > <полный вывод>
  > ```

- **1 физическое** — использовать его, сохранить `SERIAL` и `MODEL` (из `model:` в выводе).

- **2+ физических** — `AskUserQuestion` с options = `<MODEL> (<SERIAL>)` для каждого.

## Шаг 4. Сборка debug APK

```bash
./gradlew :$MODULE:assembleDebug
```

На Windows, если `./gradlew` падает с `command not found` — повторить через `./gradlew.bat`.

Если сборка упала — вывести последние ~30 строк вывода gradle и завершить:
> ❌ Сборка упала. См. вывод выше. Команда не продолжается.

## Шаг 5. Найти собранный APK

`Glob` `<MODULE>/build/outputs/apk/debug/*.apk`.

- Если ноль — вывести:
  > ❌ Сборка прошла, но APK не найден в `<MODULE>/build/outputs/apk/debug/`. Проверь конфигурацию buildTypes.

- Если один — взять.

- Если несколько (flavors) — `AskUserQuestion` с списком имён файлов.

Сохранить как `APK_PATH`.

## Шаг 6. Установка

```bash
adb -s "$SERIAL" install -r "$APK_PATH"
```

Если упало с конкретной причиной — подсказать:

| Ошибка | Подсказка |
|---|---|
| `INSTALL_FAILED_VERSION_DOWNGRADE` | Установлена более новая версия. Удали: `adb -s $SERIAL uninstall <package>` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Подпись отличается. Удали старое приложение и установи заново. |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | На устройстве нет места. |
| `INSTALL_FAILED_USER_RESTRICTED` | Устройство блокирует установку из ADB — разреши на устройстве. |

## Шаг 7. (Опционально) Запуск приложения

Через `Read` или `Grep` найти `applicationId` в `<MODULE>/build.gradle.kts` или `<MODULE>/build.gradle`:
- Kotlin DSL: `applicationId\s*=\s*"([^"]+)"`
- Groovy: `applicationId\s+"([^"]+)"`

Если найден — запустить:

```bash
adb -s "$SERIAL" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1
```

Если не найден или команда упала — **пропустить молча**, это не ошибка.

## Шаг 8. Финальный отчёт

Вывести в чат:

```
✅ APK установлен
   Устройство: <MODEL> (<SERIAL>)
   Модуль:     <MODULE>
   APK:        <APK_PATH>
   Запуск:     <PACKAGE>   ← или: «запусти из лаунчера»
```

## Запреты

- ❌ Не использовать `./gradlew installDebug` — он ставит на ВСЕ подключённые устройства разом, контроль теряется.
- ❌ Не запускать `adb kill-server` / `adb start-server` без явной просьбы.
- ❌ Не удалять старые APK без подтверждения пользователя (через `AskUserQuestion`).
