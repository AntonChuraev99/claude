# google-play-publisher — переиспользуемая публикация в Google Play

Эталонные ресурсы субагента `@google-play-publisher`. Цель — **один официальный механизм**
выкладки Android-сборок в Google Play, переносимый между проектами: и для отправки
из Claude Code локально, и для GitLab CI.

## Почему официальный Play Developer API (а не GPP / Fastlane)

- **Официального Gradle-плагина у Google НЕТ.** Официальный путь — Google Play Developer API v3
  + официальные client-библиотеки. `play_publish.py` использует именно их
  (`google-api-python-client` + `google-auth`).
- **Gradle Play Publisher (GPP)** — сторонний, в **maintenance mode** (последний релиз янв 2025,
  bus-factor=1, исторически отставал от новых AGP). Отвергнут как основной.
- **Fastlane** — куплен Google в 2017, **заброшен в 2021**, с 2023 под Mobile Native Foundation.
  Зрелый, но тянет Ruby и история надёжности неровная.
- Итог: только официальные библиотеки Google в виде переносимого скрипта → ноль зависимости
  от стороннего мейнтейнера, единый механизм для CLI и CI.

## Состав папки

```
google-play-publisher/
  scripts/
    play_publish.py     # publisher на официальном Play Developer API v3 (standalone)
    requirements.txt    # пинованные версии библиотек Google
  templates/
    gitlab-ci.play.snippet.yml   # пример build+publish jobs для .gitlab-ci.yml
  README.md             # этот файл
```

## Модель переиспользования

`scripts/` здесь — **эталон**. На конкретном проекте:

- **Локально (Claude Code):** можно запускать скрипт прямо отсюда
  (`python ~/.claude/agents/google-play-publisher/scripts/play_publish.py …`) — `~/.claude` доступен.
- **CI:** раннер клонирует только репозиторий проекта и **не видит `~/.claude`** →
  скопируй `play_publish.py` + `requirements.txt` в репо проекта (рекоменд. `ci/play/`) и
  закоммить. CI-job ссылается на `ci/play/play_publish.py`.

## Разовый setup: service account (ручной, делает владелец аккаунта)

1. **GCP Console → IAM → Service Accounts** → создать SA (напр. `play-publisher`).
2. SA → **Keys → Add key → JSON** → скачать. **Секрет — в репо/гит НЕ класть.**
3. **Play Console → Users & permissions → Invite new user** → email SA →
   роль **Release manager** (или права **Releases** на нужное приложение).
4. ⚠️ Права пропагируются **до 24–48 часов** — учитывай при первом запуске.
5. ⚠️ **Первый релиз приложения заливается вручную** через Play Console UI.
   API работает только для последующих публикаций (требование Google).

## Использование локально (из Claude Code)

```bash
pip install -r scripts/requirements.txt

python scripts/play_publish.py \
  --package com.example.app \
  --aab app/build/outputs/bundle/release/app-release.aab \
  --track internal \
  --service-account ~/secrets/play-sa.json \
  --release-notes "@release-notes.txt"
```

Сначала прогон с `--dry-run` (всё кроме commit — ничего не публикуется).

## Использование в GitLab CI

1. Скопируй `scripts/play_publish.py` + `requirements.txt` в `ci/play/` проекта, закоммить.
2. Скопируй нужные jobs из `templates/gitlab-ci.play.snippet.yml` в `.gitlab-ci.yml`, подставь
   `<APP_MODULE>` (для KMP — `androidApp`), `<APPLICATION_ID>`, `<RELEASE_BRANCH>`, `<ANDROID_CI_IMAGE>`.
3. Заведи CI/CD Variables (Protected): `UPLOAD_KEYSTORE_BASE64`, `KEYSTORE_*`, `PLAY_SERVICE_ACCOUNT_JSON`.
4. `publish_production` стоит за ручным гейтом (`when: manual`) — прод не уедет автоматически.

## Параметры play_publish.py

| Флаг | Назначение |
|---|---|
| `--package` | applicationId (обязателен) |
| `--aab` | путь к `.aab` (обязателен) |
| `--track` | `internal` (default) / `alpha` / `beta` / `production` |
| `--service-account` | путь к SA JSON; иначе env `PLAY_SERVICE_ACCOUNT_JSON` (содержимое) / `GOOGLE_APPLICATION_CREDENTIALS` (путь) |
| `--status` | `completed` (default) / `draft` / `inProgress` / `halted` |
| `--user-fraction` | доля раскатки 0..1 — обязателен при `--status inProgress` (staged rollout) |
| `--release-notes` | текст what's-new или `@путь_к_файлу` |
| `--release-notes-lang` | язык, default `en-US` |
| `--mapping` | путь к `mapping.txt` для деобфускации (опц) |
| `--dry-run` | пройти всё кроме commit — ничего не публикуется |

## Pitfalls (встроены в скрипт + расшифровка ошибок)

- **Первый релиз — вручную.** До первой ручной публикации API отдаёт ошибку.
- **`versionCode` уникален** — повтор того же кода → ошибка. Поднимай перед каждой публикацией.
- **AAB only** для новых приложений (APK не принимается).
- **Edit живёт ~7 дней** и один open-edit на пакет — параллельные CI-запуски конфликтуют.
- **Только официальный код Google** в зависимостях → supply-chain риск минимален; всё равно
  пинуй версии в `requirements.txt`.

## Безопасность

- Keystore (`.jks`) и SA JSON — **никогда в git**. Локально — вне репо; CI — Variables / Secure Files.
- SA — наименьшие права (Release manager на конкретное приложение).
- Прод — за ручным гейтом. По умолчанию трек `internal`.
- В CI — `set +x` перед операциями с секретами (Secure Files в логах не маскируются).
