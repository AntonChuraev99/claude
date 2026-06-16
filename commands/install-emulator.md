---
allowed-tools: Bash(adb:*), Bash(./gradlew:*), Bash(./gradlew.bat:*), Bash(emulator:*), Bash(*emulator.exe*), Bash(*emulator -*), Bash(ls:*), Bash(file:*), Bash(until:*), Glob, Grep, Read, AskUserQuestion
description: Build debug APK and install on running Android emulator (auto-detects app module, handles multi-emulator, KMP-aware, auto-launches AVD if none running)
---

# Install APK on Emulator

Собрать debug APK текущего Android/KMP-проекта и установить на запущенный **эмулятор** Android. Если эмулятор не запущен — предложить запустить и дождаться загрузки.

Команда выполняется только при явном запуске пользователя. Все шаги — последовательно. На любом fail — понятное сообщение и stop.

## Шаг 1. Проверить, что мы в Gradle-проекте

Через `Glob` найти в текущей рабочей директории `settings.gradle.kts` или `settings.gradle`. Если ни одного нет — вывести и завершить:

> ❌ Не похоже на Gradle-проект (нет `settings.gradle[.kts]` в текущей директории). Запусти команду из корня Android/KMP проекта.

## Шаг 2. Auto-detect app-модуля (KMP-aware)

В KMP-проектах модуль с именем `app/` часто **НЕ** содержит `com.android.application` — он KMP-обёртка с `wasmJs`/`androidMain`, а Android APK собирает отдельный модуль вроде `androidApp/`. Поэтому НЕЛЬЗЯ доверять имени папки — нужно проверять плагин.

Алгоритм:

1. Сформировать список кандидатов из приоритетных имён, у которых есть `build.gradle[.kts]`:
   - `androidApp/`
   - `composeApp/`
   - `app/`
2. Для каждого кандидата `Grep` по его `build.gradle[.kts]` паттерна `com\.android\.application` (любой формат: `id("...")`, `alias(libs.plugins....android.application...)`, `apply plugin:`).
3. Если ровно один прошёл проверку — это `MODULE`.
4. Если **ни один не прошёл** или приоритетных кандидатов нет — fallback: `Glob` `**/build.gradle*` и `Grep` `com\.android\.application` по всем найденным; собрать список модулей.
5. Если кандидатов несколько (приоритетных или fallback) — `AskUserQuestion` с options = найденные модули. Если есть `androidApp` среди них — поставить первым с пометкой `(Recommended)`.
6. Если ноль кандидатов:
   > ❌ Не найден модуль с плагином `com.android.application`. Проверь, что это Android-проект.

Сохранить как `MODULE`.

> **Примечание про KMP `:app`-обёртку.** Если в проекте `:app` без `com.android.application`, а рядом есть `:androidApp` с ним — выбирай `:androidApp`. Команда `./gradlew :app:assembleDebug` упадёт с `task 'assembleDebug' not found in project ':app'`. Если есть проектный `CLAUDE.md` с пометкой про правильный модуль — он приоритетнее этой эвристики (прочитай через `Read`).

## Шаг 3. Найти запущенный эмулятор

```bash
adb devices -l
```

Если `adb` не найден:
> ❌ `adb` не найден в PATH. Установи Android SDK Platform-Tools и добавь в PATH (`$ANDROID_HOME/platform-tools`).

**Парсинг.** Игнорировать `List of devices attached` и пустые строки.

**Эмулятор** = `state == "device"` И **serial начинается с `emulator-`** (типично `emulator-5554`).

Случаи:

- **0 эмуляторов запущено** — переход к **Шагу 3a** (предложить запустить).
- **1 эмулятор** — использовать его. `MODEL` вытащить из `model:` в выводе или через `adb -s $SERIAL shell getprop ro.product.model`.
- **2+ эмуляторов** — `AskUserQuestion` с options = `<MODEL> / AVD: <AVD_NAME> (<SERIAL>)`. AVD name можно получить через `adb -s $SERIAL emu avd name | head -1`.

## Шаг 3a. Auto-launch AVD (если нет запущенных эмуляторов)

`AskUserQuestion`:
- **Question:** `Запущенных эмуляторов нет. Запустить AVD сейчас?`
- **Header:** `Эмулятор`
- **Options:**
  - `Да, запустить (Recommended)` — продолжить ниже
  - `Нет, я запущу сам` — завершить с инструкцией (оригинальный текст ниже) и stop

Если выбрано «Нет» — вывести стандартную инструкцию и завершить:
> ❌ Запущенный эмулятор не найден.
>
> Запусти эмулятор одним из способов:
> - Android Studio → Device Manager → Run на нужном AVD (для Google Sign-In выбирай образ с **Google Play**, не «Google APIs»)
> - Из терминала: `emulator -list-avds`, затем `emulator -avd <NAME>`
>
> После загрузки запусти `/install-emulator` заново.

Если выбрано «Да»:

### 3a.1 Найти `emulator` бинарь

Порядок поиска:

1. `emulator` в PATH — попробовать `emulator -list-avds`. Если работает — `EMULATOR=emulator`.
2. `$ANDROID_HOME/emulator/emulator` (Linux/macOS) или `$ANDROID_HOME/emulator/emulator.exe` (Windows).
3. `$ANDROID_SDK_ROOT/emulator/emulator[.exe]`.
4. **Windows fallback:** `$LOCALAPPDATA/Android/Sdk/emulator/emulator.exe` (типичный путь Android Studio на Windows).
5. **macOS fallback:** `$HOME/Library/Android/sdk/emulator/emulator`.
6. **Linux fallback:** `$HOME/Android/Sdk/emulator/emulator`.

Сохранить рабочий путь как `EMULATOR` (квотировать при вызове, если есть пробелы).

Если ни один не найден:
> ❌ Не нашёл `emulator` бинарь. Проверил PATH, `$ANDROID_HOME/emulator/`, `$LOCALAPPDATA/Android/Sdk/emulator/` (Win), `~/Library/Android/sdk/emulator/` (mac), `~/Android/Sdk/emulator/` (linux). Установи Android Emulator из SDK Manager или укажи путь явно.

### 3a.2 Получить список AVD

```bash
"$EMULATOR" -list-avds
```

Случаи:

- **0 AVD** —
  > ❌ Ни одного AVD не настроено. Создай AVD через Android Studio → Device Manager. Для Google Sign-In выбирай system image с **Google Play** (иконка с Play Store), не «Google APIs».
- **1 AVD** — использовать его (`AVD_NAME`).
- **2+ AVD** — `AskUserQuestion` с options = имена AVD; первой пометить ту, что максимально похожа на `Pixel_*` (если есть) с пометкой `(Recommended)`. Подсказать в `description` каждой опции, что для Google Sign-In нужен образ с Google Play.

### 3a.3 Запустить эмулятор в фоне

```bash
"$EMULATOR" -avd "$AVD_NAME"
```

Запуск **строго через `run_in_background: true`** — иначе процесс блокирует Bash на всю сессию.

### 3a.4 Дождаться полной загрузки

```bash
until adb devices | grep -q "^emulator-"; do sleep 2; done
SERIAL=$(adb devices | awk '/^emulator-/ {print $1; exit}')
until [ "$(adb -s $SERIAL shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
echo "BOOTED $SERIAL"
```

Запускать тоже в фоне (`run_in_background: true`, `timeout: 300000` = 5 мин). Когда команда завершится — `SERIAL` готов.

Если за 5 минут не загрузился:
> ❌ Эмулятор не загрузился за 5 минут. Возможно, не хватает RAM/CPU или образ повреждён. Проверь Android Studio → Device Manager → ⋮ → Cold Boot Now.

После загрузки — **продолжить как при «1 эмулятор» в Шаге 3** (получить MODEL).

## Шаг 4. Сборка debug APK

```bash
./gradlew :$MODULE:assembleDebug
```

На Windows, если `./gradlew` падает с `command not found` — повторить через `./gradlew.bat`.

Если упало — вывести последние ~30 строк вывода gradle и завершить:
> ❌ Сборка упала. См. вывод выше. Команда не продолжается.

## Шаг 5. Найти собранный APK

`Glob` `<MODULE>/build/outputs/apk/debug/*.apk`.

- Ноль:
  > ❌ Сборка прошла, но APK не найден в `<MODULE>/build/outputs/apk/debug/`. Проверь конфигурацию buildTypes.
- Один — взять.
- Несколько (flavors) — `AskUserQuestion`.

Сохранить как `APK_PATH`.

## Шаг 6. Установка

```bash
adb -s "$SERIAL" install -r "$APK_PATH"
```

При ошибке `INSTALL_FAILED_*` — действовать по таблице:

| Ошибка | Действие |
|---|---|
| `INSTALL_FAILED_VERSION_DOWNGRADE` | Выяснить package name из `applicationId` (см. Шаг 7), `adb -s $SERIAL uninstall <package>`, retry install. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | То же — uninstall и retry (подпись отличается). |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | Завершить: APK содержит native libs, несовместимые с архитектурой эмулятора (нужен AVD x86_64/arm64). |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | Auto-retry: 1) `adb -s $SERIAL shell pm trim-caches 1000G` 2) retry install. Если снова ошибка — сообщить пользователю: «Эмулятор почти забит. Сделай Wipe Data в Device Manager или увеличь Internal Storage в AVD config». |

Все auto-retry — максимум 1 раз. Если retry тоже упал — завершить с понятным сообщением.

## Шаг 7. (Опционально) Запуск приложения

Через `Read`/`Grep` вытащить `applicationId` из `<MODULE>/build.gradle.kts` или `<MODULE>/build.gradle`:
- Kotlin DSL: `applicationId\s*=\s*"([^"]+)"`
- Groovy: `applicationId\s+"([^"]+)"`

Если найден:

```bash
adb -s "$SERIAL" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1
```

Если не найден или команда упала — **пропустить молча**.

## Шаг 8. Финальный отчёт

```
✅ APK установлен на эмулятор
   Эмулятор:  <MODEL> (<SERIAL>)   ← пометить "(новый)" если был запущен на Шаге 3a
   Модуль:    <MODULE>
   APK:       <APK_PATH>
   Запуск:    <PACKAGE>   ← или: «запусти из меню эмулятора»
```

## Запреты

- ❌ Не использовать `./gradlew installDebug` — он ставит на ВСЕ подключённые устройства/эмуляторы.
- ❌ Не запускать `adb kill-server` / `adb start-server` без явной просьбы.
- ❌ Не запускать AVD без подтверждения пользователя (Шаг 3a — `AskUserQuestion` обязателен).
- ❌ Не делать `adb shell rm -rf /data/...` для освобождения места — только `pm trim-caches`. Если не помогло — пользователь сам решит про Wipe Data.
