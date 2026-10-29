# `android preview render` — снимок Compose без эмулятора и без инфраструктуры

Команда Android CLI рендерит `@Preview` в PNG на машине: без устройства, без Android Studio, без Roborazzi и Robolectric в модуле. Для Android это **инструмент цикла по умолчанию**. Roborazzi остаётся для baseline и регрессии там, где он уже заведён: `preview render` golden'ы не хранит и не сравнивает.

Сверено 2026-10-29 на Android CLI 1.1.16717390 (Windows) на двух проектах: обычный Android-модуль и KMP на AGP 9. Документация команды — [preview render](https://developer.android.com/tools/agents/android-cli/commands/preview_render), требований к AGP/KMP там нет, ниже — замеры.

## Команды

```bash
android --version                                   # CLI в PATH; нет — установка в скилле android-cli (плагин)
android preview list :feature:profile > <scratchpad>/previews.txt 2>&1
android preview render :feature:profile \
  -o <scratchpad>/shots/after \
  --fqn=<пакет>.<Файл>Kt.<ФункцияПревью> \
  --fqn=<пакет>.<Файл>Kt.<ДругоеПревью> \
  > <scratchpad>/render.log 2>&1
```

- Первый аргумент — Gradle-путь модуля. `--fqn` обязателен, повторяется; FQN — из `preview list`.
- Выход: `<out>/<пакет>/<Файл>Kt/<Функция>_<i>.png`. Multipreview раскрывается сам: каждый вариант `@PreviewLightDark`, `@PreviewScreenSizes`, `@PreviewFontScale`, `@PreviewParameter` — свой индекс `_<i>`. Абсолютные пути команда печатает в stdout, то есть в лог.
- `--component-tree` кладёт рядом JSON: bounds, имена компонентов, source locations, semantics, modifiers. Это замер размеров и отступов без глаз; `--no-image` — только JSON.
- `--daemon` держит рендерер живым 10 минут: серия прогонов идёт быстрее.

## Ловушки (замерено)

1. **Вывод — только в файл, не в pipe.** `android preview ... | tail` (или `| Select-Object`) висит до 10+ минут при уже готовых PNG: дочерний процесс (демон рендера, Gradle-демон) наследует pipe и держит его открытым. Замер: PNG готовы через ~1 мин, команда с pipe вернулась через 724 с. С `> file 2>&1` команда возвращается сразу.
2. **KMP-модуль на AGP 9 напрямую не поддерживается.** Модуль с `com.android.kotlin.multiplatform.library` (id плагина AGP 9 для KMP, источник: `libs.versions.toml` проверенного проекта) падает: `Project ':core:designsystem' is not an Android application or library project`. Обход — app-модуль, который от него зависит:
   ```bash
   android preview list :androidApp --all > <scratchpad>/previews.txt 2>&1
   android preview render :androidApp -o <scratchpad>/shots/after --fqn=<FQN превью из KMP-модуля> > <scratchpad>/render.log 2>&1
   ```
   Проверено на превью из `androidMain` KMP-модулей: рендер чистый, шрифты и ресурсы на месте.
3. **Превью в `commonMain` с `org.jetbrains.compose.ui.tooling.preview.Preview` CLI не находит** (источник: замер 2026-10-29, импорт в проверенном проекте; аннотация deprecated с CMP 1.10 — источник: kotlinlang.org, «Compose previews» в документации KMP). androidx `@Preview` в `commonMain` не проверялся: после переноса — сверить `preview list`. Надёжный путь сейчас — превью-файл в `androidMain` с обёртками над commonMain-Content; его пишет UI-специалист (`@compose-expert`) как часть цикла.
4. **Время.** Первый прогон — полная компиляция модуля (минуты; на большом проекте 10+). Дальше ~50 с Gradle up-to-date плюс компиляция правки; сам рендер — секунды (15 вариантов ≈ 2 с на тёплом демоне). Заводить в модуле ничего не надо.
5. **«До» и «после» — разные каталоги `-o`** (`shots/before`, `shots/after`): имена детерминированные, один каталог затирается.

## Скилл `android-cli`

В Claude Code скилл `android-cli` приходит из плагина `android-cli@android-cli-plugin` (marketplace `android/android-cli-plugin`). Версия плагина 1.0.16625370 про `preview` ещё не знает — поэтому команды и ловушки записаны здесь. `android init` и `android skills add|update` без `--agent` кладут вторую копию в `~/.claude/skills/android-cli`: в контексте появляется дубль. После таких команд — `android skills remove --agent=claude-code android-cli`.

## Когда не годится

- В модуле нет `@Preview`, а app-модуля, через который видно превью, нет — писать превью (это прод-код UI-специалиста) или идти веткой Roborazzi из `SKILL.md` шага 0.
- Нужен baseline и `verify` в CI — Roborazzi (`roborazzi-setup.md`).
- Превью ходит в DI, сеть или ViewModel — рендер упадёт или нарисует пустоту; это дефект превью, а не инструмента: Content должен принимать состояние параметром.
