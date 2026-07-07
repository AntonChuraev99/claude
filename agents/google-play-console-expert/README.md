# google-play-console-expert — публикация и статистика Google Play

Эталонные ресурсы субагента `@google-play-console-expert` (бывший `google-play-publisher`,
поглотил его функционал). Цель — **официальные механизмы** работы с Google Play Console,
переносимые между проектами: публикация сборок + выгрузка crash/ANR vitals и отчётов.

## Почему официальные API (а не GPP / Fastlane)

- **Официального Gradle-плагина у Google НЕТ.** Официальный путь — Google Play Developer API v3
  + официальные client-библиотеки. `play_publish.py` использует именно их
  (`google-api-python-client` + `google-auth`).
- **Gradle Play Publisher (GPP)** — сторонний, в **maintenance mode** (последний релиз янв 2025,
  bus-factor=1, исторически отставал от новых AGP). Отвергнут как основной.
- **Fastlane** — куплен Google в 2017, **заброшен в 2021**, с 2023 под Mobile Native Foundation.
  Зрелый, но тянет Ruby и история надёжности неровная.
- Статистика: **Play Developer Reporting API v1beta1** — единственный официальный программный
  доступ к Android vitals (crash/ANR rate, error issues).

## Состав папки

```
google-play-console-expert/
  scripts/
    play_publish.py     # публикация: Play Developer API v3 (standalone)
    play_vitals.py      # статистика: Reporting API v1beta1 — crash/ANR rate, error issues (standalone)
    requirements.txt    # пинованные версии библиотек Google
  templates/
    gitlab-ci.play.snippet.yml   # пример build+publish jobs для .gitlab-ci.yml
  README.md             # этот файл
```

## Модель переиспользования

`scripts/` здесь — **эталон**. На конкретном проекте:

- **Локально (Claude Code):** можно запускать скрипты прямо отсюда
  (`python ~/.claude/agents/google-play-console-expert/scripts/<script>.py …`) — `~/.claude` доступен.
- **CI:** раннер клонирует только репозиторий проекта и **не видит `~/.claude`** →
  скопируй нужный скрипт + `requirements.txt` в репо проекта (рекоменд. `ci/play/`) и
  закоммить. CI-job ссылается на `ci/play/<script>.py`.

## Разовый setup: service account (ручной, делает владелец аккаунта)

1. **GCP Console → IAM → Service Accounts** → создать SA (напр. `play-automation`).
2. SA → **Keys → Add key → JSON** → скачать. **Секрет — в репо/гит НЕ класть.**
3. **Play Console → Users & permissions → Invite new user** → email SA →
   роль **Release manager** (публикация) или право **View app information** (только stats/vitals).
4. В GCP-проекте SA включить нужные API:
   `gcloud services enable androidpublisher.googleapis.com playdeveloperreporting.googleapis.com --project <SA_PROJECT>`.
5. ⚠️ Права пропагируются **до 24–48 часов** — учитывай при первом запуске.
6. ⚠️ **Первый релиз приложения заливается вручную** через Play Console UI.
   API работает только для последующих публикаций (требование Google).

## Публикация (play_publish.py)

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

## Статистика / vitals (play_vitals.py)

```bash
python scripts/play_vitals.py \
  --package com.example.app \
  --service-account ~/secrets/play-sa.json \
  --days 14 --by-version --issues 10
```

| Флаг | Назначение |
|---|---|
| `--package` | applicationId (обязателен) |
| `--service-account` | путь к SA JSON; иначе env `GOOGLE_APPLICATION_CREDENTIALS` |
| `--days` | окно timeline в днях, default 14 |
| `--by-version` | user-weighted разбивка crash/ANR по versionCode (последняя неделя) |
| `--issues N` | топ-N error-issue кластеров по report count, со ссылками в Play Console |
| `--json` | дополнительно вывести сырые данные JSON |

Что показывает: DAILY timeline `crashRate` / `userPerceivedCrashRate` / `distinctUsers`
(и то же для ANR) с флагом превышения **bad behaviour threshold** (user-perceived crash
≥ 1.09%, ANR ≥ 0.47% — за это Google режет видимость в сторе).

Особенности API (учтены в скрипте):
- DAILY-агрегация принимает **только** timezone `America/Los_Angeles`.
- Скрипт сам читает freshness и не запрашивает дни, которых ещё нет (DAILY отстаёт ~1-2 дня).
- `distinctUsers` округлён (приватность) — маленькие числа грубые.
- Для vitals достаточно права **View app information** (Release manager не нужен).

## GCS-экспорт (месячные CSV, второй путь к статистике)

Play Console сам складывает отчёты в бакет `pubsite_prod_rev_<developer_id>`
(URI: Play Console → **Download reports** → Copy Cloud Storage URI).

```bash
gsutil ls gs://pubsite_prod_rev_<id>/stats/crashes/
gsutil cp gs://pubsite_prod_rev_<id>/stats/crashes/crashes_<package>_202606*.csv .
```

- Годится для: исторические месячные агрегаты, bulk-выгрузки, финансовые отчёты.
- Для оперативной статы — Reporting API выше (свежее, гранулярнее).
- CSV — **UTF-16 с BOM** (легаси), парсить с `encoding='utf-16'`.

## Использование в GitLab CI

1. Скопируй `scripts/play_publish.py` + `requirements.txt` в `ci/play/` проекта, закоммить.
2. Скопируй нужные jobs из `templates/gitlab-ci.play.snippet.yml` в `.gitlab-ci.yml`, подставь
   `<APP_MODULE>` (для KMP — `androidApp`), `<APPLICATION_ID>`, `<RELEASE_BRANCH>`, `<ANDROID_CI_IMAGE>`.
3. Заведи CI/CD Variables (Protected): `UPLOAD_KEYSTORE_BASE64`, `KEYSTORE_*`, `PLAY_SERVICE_ACCOUNT_JSON`.
4. `publish_production` стоит за ручным гейтом (`when: manual`) — прод не уедет автоматически.

## Pitfalls публикации (встроены в скрипт + расшифровка ошибок)

- **Первый релиз — вручную.** До первой ручной публикации API отдаёт ошибку.
- **`versionCode` уникален** — повтор того же кода → ошибка. Поднимай перед каждой публикацией.
- **AAB only** для новых приложений (APK не принимается).
- **Edit живёт ~7 дней** и один open-edit на пакет — параллельные CI-запуски конфликтуют.
- **Только официальный код Google** в зависимостях → supply-chain риск минимален; всё равно
  пинуй версии в `requirements.txt`.

## Безопасность

- Keystore (`.jks`) и SA JSON — **никогда в git**. Локально — вне репо; CI — Variables / Secure Files.
- SA — наименьшие права (Release manager / View app information на конкретное приложение).
- Прод — за ручным гейтом. По умолчанию трек `internal`.
- В CI — `set +x` перед операциями с секретами (Secure Files в логах не маскируются).
