---
name: cloudflare-deploy-slack-notify
description: >
  Use this skill when the user wants Slack notifications about web/app deploys
  that ship through Cloudflare Workers Builds (the CI that builds & deploys a
  Worker on git push). It wires a post-deploy hook (`.cloudflare/notify-slack.sh`)
  into the Worker's Deploy command so that AFTER a successful deploy a Slack
  message is posted with the environment, deployed version and the list of
  commits since the previous deploy (via the Cloudflare Builds API + git log).

  The skill detects the project's Cloudflare setup (wrangler.jsonc/toml,
  account/worker ids, prod vs non-prod branches), generates the script from a
  template, and walks the user through the one-time dashboard setup (append
  `&& bash .cloudflare/notify-slack.sh` to the Deploy command; add
  SLACK_WEBHOOK_URL + optional CF_API_TOKEN secrets), then gives a verification
  recipe (local smoke + real push).

  Triggers (RU/EN): "отстук в слак по деплою через cloudflare",
  "уведомление в slack когда задеплоился сайт на cloudflare",
  "slack notification on cloudflare deploy", "notify slack on workers builds
  deploy", "список коммитов вошедших в деплой в slack", "cloudflare deploy
  slack hook", "/cloudflare-deploy-slack-notify".

  Do NOT use for: GitLab CI tag→release notifications (use gitlab-release-slack-ci),
  GitHub Actions release notes, generic Slack bots unrelated to deploys, Amplitude
  event→Slack payloads (use amplitude-slack-payload), or Cloudflare Pages projects
  that don't use Workers Builds (the deploy-hook wiring differs — see Edge cases).
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

# Cloudflare Workers Builds → Slack Deploy Notification

Скилл ставит в проект post-deploy hook, который **после успешного** деплоя Worker'а
(Cloudflare Workers Builds) шлёт в Slack-канал сообщение: окружение
(Production/Staging), задеплоенную версию, URL и список коммитов с прошлого деплоя.

Все ловушки из реального прецедента (2026-06-04) вшиты в шаблон:
exit-0 guard, `&&`-после-wrangler, PREV через CF Builds API, shallow-clone deepen,
и — главная боль — корректная передача UTF-8 (`String.fromCharCode` + payload через
stdin, а не `--data` аргумент).

## Когда скилл активируется

- «сделай отстук в slack когда сайт задеплоился на cloudflare»
- «пусть пишет в slack список коммитов вошедших в деплой» (для CF-деплоя)
- проект деплоится через **Cloudflare Workers Builds** (есть `wrangler.jsonc`/`wrangler.toml`,
  деплой триггерится git push, обычно есть `.cloudflare/build.sh`)
- слэш-команда `/cloudflare-deploy-slack-notify`

## Не активируется

- GitLab CI релизы по тэгам → `gitlab-release-slack-ci`
- GitHub Actions / Jenkins деплои (другой механизм — здесь только Workers Builds; для GHA
  см. Edge cases — паттерн похож, но шаг встраивания другой)
- Amplitude event → Slack → `amplitude-slack-payload`
- Cloudflare **Pages** без Workers Builds (нет отдельного Deploy command — см. Edge cases)

## Pre-requisites

1. **Cloudflare Workers Builds** настроен на репозиторий (Worker → Settings → Build, git-репо подключён).
2. Доступ к **Worker → Settings → Build** (изменить Deploy command, добавить секреты).
3. **Slack Incoming Webhook** для нужного канала (или право его создать).
4. Для списка коммитов — право создать **Cloudflare API token** (Workers Builds Configuration: Read).

Чего нет — скилл диагностирует и скажет явно.

## Workflow

```
Step 1 → Detect      (Workers Builds? wrangler.jsonc → account_id/worker; prod-ветка; git host)
Step 2 → Gather      (AskUserQuestion: окружения, webhook есть/создать, нужен ли список коммитов)
Step 3 → Generate    (notify-slack.sh из template, подставить CONFIG; git add; .gitattributes eol=lf)
Step 4 → Setup       (инструкции: Deploy command += hook; секреты; как создать CF token)
Step 5 → Verify      (локальный smoke + push; что проверить в Slack и логах)
```

На каждом шаге — короткий статус в чат.

---

### Step 1 — Detect

```bash
git remote get-url origin          # git host (для ссылок; GitHub/GitLab оба ок)
ls wrangler.jsonc wrangler.toml 2>/dev/null
ls .cloudflare/build.sh 2>/dev/null
```

Из `wrangler.jsonc`/`wrangler.toml` вытащить `name` (worker) и `account_id`. **Worker tag id**
(нужен для Builds API, ≠ name) — НЕ в wrangler-конфиге; получить позже через API или из
URL дашборда (`dash.cloudflare.com/<account>/workers/services/view/<name>/...` — tag в Settings),
либо оставить плейсхолдер и сказать пользователю заполнить.

Определить prod-ветку и URL: обычно `main` → custom domain; прочие ветки → `*.workers.dev` alias.
Если есть `.cloudflare/build.sh` — посмотреть как там ветвится окружение (`WORKERS_CI_BRANCH`).

Печатать:
```
🔍 Cloudflare setup:
  Worker:       <name> (account <account_id>)
  Prod branch:  <main>
  Prod URL:     <custom domain | *.workers.dev>
  Build script: <.cloudflare/build.sh | none>
  Git host:     <github | gitlab>
```

Если `wrangler.*` нет или Workers Builds не используется → STOP, объяснить (этот скилл — про Workers Builds).

### Step 2 — Gather requirements (AskUserQuestion)

**Окружения:** `Только prod (main)` / `Prod + staging` / `Только staging`.
(staging = любая не-prod ветка; develop пушится часто → канал шумный — предупредить.)

**Slack webhook:** `Уже есть — предоставлю URL` / `Нужна инструкция как создать`.

**Список коммитов:** `Полный список с прошлого деплоя (нужен CF_API_TOKEN)` (Recommended) /
`Только последний коммит (без токена)`. Объяснить: без токена граница «предыдущего деплоя»
неоткуда взять → только HEAD-коммит.

### Step 3 — Generate

Скопировать `templates/notify-slack.sh` (из папки скилла) в `.cloudflare/notify-slack.sh`,
заполнить CONFIG-блок: `ACCOUNT_ID`, `SCRIPT_ID` (worker tag — если не известен, оставить
плейсхолдер + пометить пользователю), `PROD_BRANCH`, `PROD_URL`, `STAGING_URL_FMT`, `get_version()`.

`get_version()` — project-specific: где взять версию (распарсить сгенерированный build-flags файл,
`package.json` `version`, git describe). Если негде — оставить `:` (версия не показывается).

После Write:
```bash
git add .cloudflare/notify-slack.sh
# .gitattributes: гарантировать LF для .sh (иначе CRLF ломает скрипт на Linux CI)
grep -q '\*.sh.*eol=lf' .gitattributes 2>/dev/null || echo '*.sh text eol=lf' >> .gitattributes
git add .gitattributes
git ls-files --eol .cloudflare/notify-slack.sh   # подтвердить i/lf w/lf
```

Проверить скрипт: `bash -n .cloudflare/notify-slack.sh` + что pure ASCII
(`LC_ALL=C grep -nE $'[^\t\x20-\x7e]' .cloudflare/notify-slack.sh` → пусто).

Печатать diff/стат и краткий итог (что подставлено).

### Step 4 — Setup instructions (полные, не сокращать — разово, забудется)

```
🔧 One-time setup (Cloudflare Dashboard → Worker <name> → Settings → Build):

1. Deploy command — дописать вызов хука к существующей команде:
   Production:      npx wrangler deploy           && bash .cloudflare/notify-slack.sh
   Non-production:  npx wrangler versions upload  && bash .cloudflare/notify-slack.sh
   (если команда другая — просто добавь `&& bash .cloudflare/notify-slack.sh` в конец)

2. Variables & Secrets → Add → type "Secret":
   - SLACK_WEBHOOK_URL = <твой webhook https://hooks.slack.com/services/...>   (обязательно)
   - CF_API_TOKEN      = <см. шаг 3>                                            (для списка коммитов)

3. CF_API_TOKEN (если нужен список коммитов):
   - Открой https://dash.cloudflare.com/profile/api-tokens  (User API tokens —
     на странице Account API tokens кнопки Create может не быть при ограниченной роли)
   - Create Token → Custom token → Get started
   - Permissions: Account → Workers Builds Configuration → Read
     (если нет такого пункта — Account → Workers Scripts → Read)
   - Account Resources: Include → <твой аккаунт>
   - Continue to summary → Create Token → скопировать → вставить секретом CF_API_TOKEN
```

Webhook создаётся в `https://api.slack.com/apps` → Create App → Incoming Webhooks → Add to Workspace → канал.

⚠️ Если пользователь присылал webhook URL в чат — напомнить **Reset URL** в Slack (засветился).

### Step 5 — Verify

**Локальный smoke** (мгновенно, без CI; шлёт реальное сообщение в канал):
```bash
SLACK_WEBHOOK_URL="<webhook>" \
WORKERS_CI_BRANCH="<non-prod-branch>" \
WORKERS_CI_COMMIT_SHA="$(git rev-parse HEAD)" \
bash .cloudflare/notify-slack.sh
# ждём "notify-slack: sent (...)" + глазами проверить рендер в Slack (•/— не должны быть ? или \u)
```
Версия будет `unknown`/пустой и только HEAD-коммит (CF_API_TOKEN локально нет) — это норма для smoke.
**Глаза обязательны:** проверять рендер символов именно в Slack — локальный stdout это не покажет.

**Dry-run с полным диапазоном** (без отправки и без CF_API_TOKEN — проверка сортировки/чанкования):
```bash
SLACK_WEBHOOK_URL="dummy" NOTIFY_DRY_RUN=1 \
NOTIFY_FAKE_PREV="$(git rev-parse HEAD~50)" \
WORKERS_CI_BRANCH="<branch>" WORKERS_CI_COMMIT_SHA="$(git rev-parse HEAD)" \
bash .cloudflare/notify-slack.sh
# печатает готовый Block Kit JSON + "notify-slack: DRY RUN, not sent"
```

**Полный e2e:** commit + push в нужную ветку → Workers Builds сам соберёт и задеплоит → придёт
сообщение с реальной версией и полным списком коммитов (с CF_API_TOKEN). В логе деплоя — строка
`notify-slack: sent (...)`.

⚠️ Скрипт обязан быть в репо ДО того, как изменён Deploy command — иначе билд не найдёт файл и
пометится failed (сам деплой пройдёт, шаг хука упадёт). Поэтому push скрипта — первым делом.

Что проверить:
- сообщение пришло **после** успешного деплоя (не при failed);
- список коммитов = коммиты с прошлого деплоя (если пусто/один, а ждали больше — см. Pitfall про fallback);
- сломанный билд → Slack молчит, CI помечает FAILED.

---

## Pitfalls (вшиты в шаблон — но знать обязательно)

1. **UTF-8 в цепочке bash → curl → Slack — главная боль (реальный прецедент, 4 итерации).** Символы
   `•`/`—` приходят как `?` или literal `•`. Два независимых слоя:
   - **Генерация:** literal не-ASCII в `.sh` бьётся о локаль (msys/Windows codepage при `node -e`),
     а `\u`-escape хрупок к слоям экранирования редактора (легко получить двойной backslash → literal
     текст `•`). **Решение:** `String.fromCharCode(0x2022)` — исходник чисто ASCII, node считает codepoint
     в рантайме. Скрипт держать **pure ASCII** (проверка `LC_ALL=C grep`).
   - **Передача:** `curl --data "$PAYLOAD"` (аргумент) калечит multibyte на msys/Windows. **Решение:**
     `printf '%s' "$PAYLOAD" | curl --data-binary @-` (stdin — байт-в-байт, кросс-платформенно).
2. **Скрипт ВСЕГДА `exit 0` + `&&` после wrangler.** `set -uo pipefail` без `-e`; все падающие шаги
   guarded; финальный `exit 0`. Иначе сбой Slack пометит успешный деплой как failed. `|| true` на
   ВСЮ deploy-команду нельзя — замаскирует и реальный провал деплоя.
3. **Build command идёт ДО deploy command.** `curl` в `.cloudflare/build.sh` сработает до фактического
   деплоя → «успешно залилось» ещё неизвестно. Хук обязан висеть на **Deploy command**, после wrangler.
4. **`build_outcome` vs `status` (CF Builds API).** Фильтровать предыдущий деплой по
   `build_outcome=="success"`, НЕ по `status` (там `running`/`stopped`).
5. **In-flight билд ≠ success.** В момент выполнения хука текущий билд ещё не `success`, поэтому
   верхний `success` в списке = предыдущий деплой. PREV = он.
6. **CI клонирует shallow.** `git log PREV..HEAD` упадёт `bad object` если PREV вне глубины. Перед
   range: `git cat-file -e PREV`, при отсутствии — `git fetch --deepen=300 || --unshallow`; иначе fallback на HEAD.
7. **`SCRIPT_ID` = worker tag, не имя.** Endpoint `/builds/workers/{tag}/builds`. Неверный id → 404 →
   PREV пусто → тихий fallback на один коммит. Если список всегда из одного коммита — первый подозреваемый.
8. **`.gitattributes *.sh eol=lf`.** Без него Windows-редактирование уносит CRLF в репо → на Linux CI
   `\r` ломает переменные/команды. Проверять `git ls-files --eol`.
9. **CF token: User token, не Account.** На `dash.cloudflare.com/<acc>/api-tokens` кнопки Create может
   не быть (роль) → `dash.cloudflare.com/profile/api-tokens`.
10. **Slack section text лимит 3000 — это лимит НА БЛОК, не на сообщение.** Шаблон НЕ режет список:
    коммиты группируются по типу Conventional Commits под заголовками `:sparkles: *Features*` /
    `:bug: *Bugs and Fixes*` / `:memo: *Docs*` / `:package: *Other*` (внутри группы хронология
    git log сохраняется, пустые группы скрыты) и раскладываются чанками ≤2900 по section-блокам
    (сообщение вмещает до 50 блоков → 1 deploy-header + ≤46 коммит-блоков + overflow-хвост
    «… +N more» только за пределами ~3000 коммитов). Заголовок прилипает к первому блоку группы.
11. **Fallback неотличим на range=1.** Если реальный диапазон = 1 коммит, корректный путь и fallback
    (PREV не найден) дают одинаковый результат. Чтобы проверить что токен работает — нужен деплой с
    range ≥2 ИЛИ проверка истории билдов через Builds API / CF Builds MCP.

## Edge cases

- **Worker tag id неизвестен.** Оставить плейсхолдер `<WORKER_TAG_ID>` — скрипт это детектит и
  пропускает список коммитов (fallback на HEAD), не падает. Заполнить позже из Builds API
  `GET /accounts/{id}/workers/scripts` → `.id`, или из дашборда.
- **Несколько окружений на одном Worker.** Скрипт ветвит prod/staging по `WORKERS_CI_BRANCH` (как
  `build.sh`). Разные домены — `PROD_URL` + `STAGING_URL_FMT`.
- **GitHub Actions вместо Workers Builds.** Логика та же (после `wrangler deploy` exit 0 → notify), но
  встраивается шагом в workflow, не в Deploy command; `WORKERS_CI_*` заменить на `github.sha`/`GITHUB_REF_NAME`,
  PREV — из git tag предыдущего деплоя или GH API. Скилл по умолчанию это НЕ генерит — предупредить.
- **Cloudflare Pages.** У Pages нет отдельного Deploy command поля; нотификацию вешать через Pages
  build hook / Deploy notifications или GH Action. Этот скилл — про Workers Builds.
- **Ручной `wrangler deploy` (вне CI).** Хук не вызывается (он на Deploy command CI). Можно дёрнуть
  вручную: `SLACK_WEBHOOK_URL=... bash .cloudflare/notify-slack.sh` после деплоя.

## Что скилл НЕ делает

- Не создаёт Slack webhook (нужен логин в Slack UI) — даёт инструкцию.
- Не меняет Deploy command и не добавляет секреты в CF (нужен доступ к дашборду) — даёт инструкцию.
- Не создаёт CF API token — даёт точные permissions и URL.
- Не делает `git commit`/`push` сам — это решение пользователя (но напоминает, что скрипт нужен в репо
  до смены Deploy command).

## Related files

- `templates/notify-slack.sh` — production-ready хук с CONFIG-блоком и вшитыми граблями.
- Реальный прецедент: 2026-06-04 — `.cloudflare/notify-slack.sh`,
  `docs/solutions/ci-deploy/slack-deploy-notification-cloudflare-2026-06-04.md`.
