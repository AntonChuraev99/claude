# Roborazzi: setup, матрица, грабли

Версии сверены 2026-08-13 по GitHub Releases API (первоисточник; mvnrepository и libraries.io отстают на несколько минорных). **Перед применением проверить актуальную версию заново** — линия движется быстро.

## Выбор инструмента (2026-08)

| Инструмент | Вердикт |
|---|---|
| **Roborazzi** 1.71.0 (2026-08-07) | Дефолт. Единственный, кто закрывает и Jetpack Compose, и Compose Multiplatform (Android/Desktop; iOS — experimental). |
| AGP Compose Preview Screenshot Testing (`com.android.compose.screenshot`) | Не брать основным: плагин 0.0.1-alpha15, API «subject to substantial change», полная IDE-интеграция требует AGP 9+. Только androidMain, не commonMain. |
| Paparazzi | Не брать на этом стеке: 2.0.0-alpha05 (2026-05-20), открытый блокер на Android SDK 36 с рандомными падениями CI, KMP/CMP официально не поддерживается. |

## Gradle

Root:

```kotlin
plugins { id("io.github.takahirom.roborazzi") version "1.71.0" apply false }
```

Модуль с UI:

```kotlin
plugins {
    id("io.github.takahirom.roborazzi")
}

android {
    testOptions.unitTests {
        isIncludeAndroidResources = true   // KMP/AKMP — внутри withHostTestBuilder {}
        all {
            it.systemProperties["robolectric.pixelCopyRenderMode"] = "hardware"
        }
    }
}

dependencies {
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.71.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.71.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose-preview-scanner-support:1.71.0")
    testImplementation("io.github.sergio-sastre.ComposablePreviewScanner:android:<latest>")
    testImplementation("org.robolectric:robolectric:<из libs.versions.toml>")

    // нужны, если пишутся ручные тесты (см. ниже); версии — из libs.versions.toml
    testImplementation("junit:junit:<version>")
    testImplementation("androidx.compose.ui:ui-test-junit4:<version>")
    // превью живут в main source set:
    implementation("androidx.compose.ui:ui-tooling-preview:<version>")
    debugImplementation("androidx.compose.ui:ui-tooling:<version>")
}
```

## Генерация тестов из @Preview — путь по умолчанию

Убирает тест-класс целиком: матрица живёт аннотациями рядом с UI.

```kotlin
roborazzi {
    generateComposePreviewRobolectricTests {
        enable = true
        packages = listOf("com.example.feature.profile")
        // generatedTestClassCount = 4   // распараллелить тяжёлую матрицу
    }
}
```

Дальше на превью-composable вешаются `@PreviewScreenSizes`, `@PreviewFontScale`, `@PreviewLightDark` (модуль `androidx.compose.ui:ui-tooling-preview`), и каждый вариант превращается в отдельный снимок.

**Куда падают PNG.** Каталог задаётся в build-файле модуля, не в `gradle.properties`:

```kotlin
roborazzi { outputDir.set(file("src/test/screenshots")) }
```

Не задан — снимки уходят в `build/outputs/roborazzi/`, то есть в `.gitignore`, и в коммит не попадут. Имена сгенерированных тестов и файлов делает плагин, поэтому **перед чтением находи снимки `Glob`'ом по `<outputDir>/**/*.png`**, а не угадывай имя.

**Превью должны быть `internal` или `public`.** Приватные сканер по умолчанию не берёт — прогон пройдёт зелёным и не снимет ничего. Либо `internal fun …Preview()`, либо включать приватные явно опцией сканера (сверить имя флага по `preview_support.md` текущей версии).

Ручные тесты писать только там, где превью не годится: нужен нестандартный qualifier, состояние собирается из fake-репозитория, снимок делается после действия.

## Ручной тест, когда он всё же нужен

```kotlin
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)      // MediumTablet, Pixel7Pro, …
class ProfileScreenScreenshotTest {

    @get:Rule val composeRule = createComposeRule()

    @Test
    fun profileScreen_success_tablet() {
        RuntimeEnvironment.setQualifiers("+w900dp-h1000dp-night")   // размер/тему можно менять по ходу
        composeRule.setContent { AppTheme { ProfileContent(state = SUCCESS_STATE, onAction = {}) } }
        composeRule.onRoot().captureRoboImage("src/test/screenshots/profile_success_tablet.png")
    }
}
```

Матрица размеров, если проект просит явные числа (совпадает со Step 8 скилла `testing-setup`): ширины 400 / 610 / 900 dp × высоты 400 / 500 / 1000 dp на экран, плюс на 400×500 — альтернативные темы и fontScale 1.5.

## Команды

```bash
./gradlew :module:recordRoborazziDebug     # записать/перезаписать golden
./gradlew :module:verifyRoborazziDebug     # сравнить с golden (CI)
./gradlew :module:compareRoborazziDebug    # отчёт с diff-картинками
```

KMP/AKMP-модуль: те же таски с суффиксом source set — `recordRoborazziAndroidHostTest` / `verifyRoborazziAndroidHostTest`.

`roborazzi.test.record=true` в `gradle.properties` включает запись при запуске теста кнопкой из IDE.

Порог сравнения, когда verify шумит на антиалиасинге:

```kotlin
val options = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(
        changeThreshold = 0.01F,
        imageComparator = SimpleImageComparator(maxDistance = 0.007F, vShift = 2, hShift = 2),
    ),
)

// ручной тест — параметром снимка:
composeRule.onRoot().captureRoboImage(filePath = "…", roborazziOptions = options)
```

Для тестов, сгенерированных из превью, точка подключения другая — общая настройка задаётся в блоке `roborazzi { }` модуля; конкретное имя свойства сверить по `preview_support.md` своей версии, не подставлять по аналогии.

## KMP / Compose Multiplatform

- UI из `commonMain` снимается через Android-таргет: тесты в `androidUnitTest` / `androidHostTest` обычной Android-библиотеки или `com.android.kotlin.multiplatform.library`. Официальный путь, есть сэмпл `sample-android-multiplatform` в репозитории Roborazzi.
- Desktop/JVM: `roborazzi-compose-desktop`.
- iOS — experimental, имя файла не генерится автоматически, путь задаётся явно.
- **wasmJs Roborazzi не покрывает** (инструмент JVM/Robolectric-only). Рабочий путь для web-таргета CMP — Playwright поверх canvas. Вариант `runComposeUiTest {}` + `captureToImage()` в `wasmJsBrowserTest` не подтверждён: на браузерном таргете захват кадра исторически не работал — проверить в сети до того, как закладывать его в план, а не после.

  Практически: вёрстку общего UI дешевле снимать Roborazzi на Android-таргете, а браузер оставить на то, что бывает только там.

## Грабли

Этот раздел — канон по Roborazzi. Проектные грабли того же стека лежат в `agent-memory/test-expert/reference_kmp_test_stack_and_pitfalls.md`; расходятся — прав этот файл, там правится ссылкой.

- **Тёмная тема может дать ложно-зелёный.** `@PreviewLightDark` переключает `uiMode`, но тема нарисует тёмный вариант, только если читает `isSystemInDarkTheme()`. Тема управляется настройкой из DataStore/ViewModel — оба снимка выйдут светлыми, а агент отчитается «тёмная проверена». Признак: light и dark попиксельно одинаковы. Лечится передачей `darkTheme` в тему параметром внутри превью.
- **`roborazzi.outputDir` в `gradle.properties` — нельзя**, если корневой `gradle.properties` в `.gitignore`: на CI baseline уедет в `build/` и verify сломается. Путь — в `.kt`-хелпере.
- **Первый `verify` без записанного baseline падает** — сначала `record`.
- **Software-рендер Robolectric расходится с устройством по пикселям** → `@GraphicsMode(NATIVE)` + `robolectric.pixelCopyRenderMode=hardware`.
- **Бесконечная анимация подвешивает или мигает golden** (indeterminate-прогресс, `rememberInfiniteTransition`, курсор в сфокусированном текстовом поле): `composeRule.mainClock.autoAdvance = false` **до** `setContent`, затем `advanceTimeBy(700)`.
- **Coil3 `AsyncImage` под Robolectric рисует пусто**: подменить `LocalAsyncImagePreviewHandler` и обязательно выставить `LocalInspectionMode provides true`. Такой снимок доказывает layout/clip/ContentScale, но не декодинг — помечать комментарием.
- **Стоимость CI**: Robolectric стартует на каждый тест; полная матрица размеров × тем × шрифтов на каждый экран измеряется минутами. Компонентам — усечённая матрица; `record` локально, `verify` в CI.
- **Вес golden'ов** растёт быстро — при распухании каталога Git LFS.
- Тест-зависимости класть строго в андроидный тестовый sourceSet: `robolectric`/`mockk`/`junit` в `commonTest` ломают сборку web-таргета.

## Источники

- https://github.com/takahirom/roborazzi/blob/main/docs/topics/build_setup.md
- https://github.com/takahirom/roborazzi/blob/main/docs/topics/how_to_use.md
- https://github.com/takahirom/roborazzi/blob/main/docs/topics/preview_support.md
- https://github.com/takahirom/roborazzi/blob/main/docs/topics/compose_multiplatform.md
- https://api.github.com/repos/takahirom/roborazzi/releases — версия и дата
- https://developer.android.com/studio/preview/compose-screenshot-testing — статус AGP-плагина
- https://developer.android.com/develop/ui/compose/tooling/previews — multipreview-аннотации
- https://github.com/android/nowinandroid/wiki/Testing-strategy-and-how-to-test — живой пример матрицы
