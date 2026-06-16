---
name: gitlab-release-slack-ci
description: >
  Use this skill when the user wants to set up a GitLab CI pipeline that
  automatically (a) creates a GitLab Release object when an annotated semver
  tag is pushed, and (b) notifies a Slack channel about the release.

  The skill writes `.gitlab-ci.yml` with a `release:create` + `notify:release`
  job pair, walks the user through the one-time setup (Slack Incoming Webhook,
  GitLab CI variable, Protected tag pattern), optionally backfills existing
  tags into Release objects via `glab`, and shows a verification recipe.

  Triggers (RU/EN): "сделай ci для отстука релизов в slack",
  "настрой автоматический релиз в gitlab + slack",
  "gitlab release slack notification ci", "release notification setup",
  "автоматизируй уведомления о релизах", "/gitlab-release-slack-ci".

  Do NOT use for: GitHub Actions (other tool), Jenkins, generic Slack bot
  setup unrelated to releases, GitLab integrations other than CI-driven
  release notifications.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

# GitLab Release → Slack Notification CI

Скилл собирает в репозитории GitLab CI pipeline, который при пуше annotated-тэга вида `vX.Y.Z`:

1. Создаёт **GitLab Release object** (Deploy → Releases) из tag annotation
2. Шлёт **Slack-нотификацию** в канал через Incoming Webhook

Все ловушки из реального прецедента вшиты — образ `alpine`, `CI_COMMIT_TAG_MESSAGE`, `jq` для безопасной сборки JSON, two-stage pipeline через `needs:`, backfill для существующих тэгов через `glab`.

## Когда скилл активируется

- Пользователь говорит «сделай ci для отстука в slack при релизах», «настрой автоматические уведомления о релизах», «gitlab release slack notification»
- В репозитории есть GitLab origin и тэги начинают накапливаться, но нет автоматизации
- После создания первого ручного релиза пользователь хочет автоматизировать процесс
- Слэш-команда `/gitlab-release-slack-ci`

## Не активируется

- Если remote — GitHub/Bitbucket (этот скилл — только GitLab)
- Если нужен Slack-бот, не связанный с релизами — используй `amplitude-slack-payload` или другие
- Если CI/CD уже есть и пользователь хочет лишь поправить (это — обычная работа без скилла)

## Pre-requisites (что должно быть у пользователя)

1. **GitLab репозиторий** (git remote ведёт на `gitlab.com` или self-hosted GitLab)
2. **Maintainer-доступ** к Settings → CI/CD → Variables и Settings → Repository → Protected tags
3. **Slack workspace** с правом создавать Incoming Webhooks (или существующий webhook URL)
4. **Канал** Slack, в который должны прилетать сообщения

Если что-то из этого отсутствует — скилл это диагностирует и явно скажет.

## Workflow

Скилл проходит 6 шагов последовательно. На каждом — короткий статус в чат.

```
Step 1 → Detect project state        (GitLab? существующий .gitlab-ci.yml?)
Step 2 → Gather requirements         (AskUserQuestion: pattern, format, backfill)
Step 3 → Generate .gitlab-ci.yml     (write/merge)
Step 4 → Setup instructions          (Slack webhook, GitLab variables)
Step 5 → Optional backfill           (glab release create для существующих тэгов)
Step 6 → Verification recipe         (тестовый patch-тэг, что проверить)
```

---

### Step 1 — Detect project state

1. **Подтвердить GitLab remote**:
   ```bash
   git remote get-url origin
   ```
   - Если `gitlab.com` или self-hosted GitLab → OK, продолжаем
   - Если `github.com` → STOP, печатать `❌ GitHub repo detected — this skill is GitLab-only` и предложить альтернативы
   - Если remote вообще нет → STOP, `❌ no git remote — push your repo to GitLab first`

2. **Существующий `.gitlab-ci.yml`**:
   ```bash
   ls .gitlab-ci.yml 2>/dev/null
   ```
   - Нет файла → будем создавать с нуля
   - Файл есть → читать содержимое, искать `stages:` и `release:create` / `notify:release` jobs
     - Если jobs уже есть → STOP, `✅ already configured — open .gitlab-ci.yml to tweak`
     - Если других CI jobs нет → можно перезаписывать после подтверждения
     - Если есть другие jobs → MERGE, не перезапись: добавить новые stages и jobs к существующим, спросить пользователя через AskUserQuestion перед изменением

3. **Проверить наличие annotated тэгов** (для backfill в Step 5):
   ```bash
   git tag -l --sort=-creatordate | head -10
   ```

4. **Проверить `glab` CLI** (для backfill):
   ```bash
   command -v glab && glab auth status 2>&1 | head -3
   ```
   - Установлен и авторизован → backfill доступен
   - Установлен, но токен истёк / не авторизован → backfill потребует `glab auth login`
   - Не установлен → backfill через REST API или через GitLab UI (инструкция)

Печатать:

```
🔍 Project state:
  Remote:      gitlab.com/<group>/<project>
  CI config:   <new | existing N jobs | already configured>
  Tags found:  <N> (latest: <tag>)
  glab CLI:    <ok | expired | not installed>
```

### Step 2 — Gather requirements

Через `AskUserQuestion` (группами по 2-4):

**Вопрос 1 — Tag pattern**:

- `Strict semver (^v\d+\.\d+\.\d+$)` (Recommended) — только `v1.2.3`
- `Semver with pre-releases (^v\d+\.\d+\.\d+(-[a-z0-9]+)?$)` — `v1.2.3` + `v1.2.3-rc1`, `v1.2.3-beta`
- `Custom regex` — пользователь укажет в follow-up

**Вопрос 2 — Slack message format**:

- `Block Kit (rich, recommended)` — заголовок, поля Tag/Author, code-block с release notes, ссылки на commit и pipeline
- `Simple text` — одна строка с тэгом, автором и ссылкой
- preview (см. шаблон ниже) для каждого варианта в `preview` поле опции

**Вопрос 3 — Backfill** (только если в Step 1 нашлись тэги без Release объектов):

- `Backfill latest N tags into Releases (Recommended)` — N = min(найденных, 5), уточнить через follow-up если > 5
- `Backfill all annotated tags` — все найденные
- `Skip backfill` — только новые тэги после установки CI

**Вопрос 4 — Channel binding** (информативный, не диагностический):

- `New webhook (I'll create it)` — пользователь создаст webhook сам после Step 4
- `Existing webhook URL` — пользователь уже имеет URL

Без этого вопроса — Step 4 будет полнее. На действия скилла не влияет, но определяет тон Step 4-инструкций.

### Step 3 — Generate .gitlab-ci.yml

Использовать шаблон `templates/gitlab-ci.yml` из этой же папки скилла. Подставить:
- `<TAG_PATTERN>` — выбранный regex
- `<MESSAGE_STYLE>` — block kit или simple

Если файл уже существует и содержит другие jobs — добавить недостающие stages (`release`, `notify`) и jobs **в конец** файла, не трогая существующие. Использовать `Edit` с точечным append.

После Write/Edit — показать пользователю diff:

```bash
git diff --stat .gitlab-ci.yml
```

Печатать:

```
📝 .gitlab-ci.yml: <created | merged> 
  Stages added:  release, notify
  Jobs added:    release:create, notify:release
  Tag pattern:   <pattern>
  Message style: <style>
```

### Step 4 — Setup instructions

Печатать пользователю **полные инструкции** (не сокращать — это разово, через сутки забудется). Без AskUserQuestion — это плоский чеклист, который пользователь выполняет руками в браузере.

```
🔧 One-time setup (≈3 минуты):

1. Slack — create Incoming Webhook
   - Open https://api.slack.com/apps
   - "Create New App" → "From scratch" → name "GitLab Release Bot" → workspace
   - Sidebar → "Incoming Webhooks" → toggle ON
   - "Add New Webhook to Workspace" → выбрать канал → Allow
   - Скопировать webhook URL (вид: https://hooks.slack.com/services/T.../B.../...)

   Если webhook уже есть — пропустить шаг.

2. GitLab — add CI/CD variable
   - Open <repo URL>/-/settings/ci_cd → expand "Variables"
   - "Add variable"
   - Key:   SLACK_WEBHOOK_URL
   - Value: <webhook URL из шага 1>
   - Type:  Variable
   - Flags: ✅ Masked, ✅ Protected
   - Environments: All
   - "Add variable"

3. GitLab — protect tag pattern
   - Open <repo URL>/-/settings/repository → expand "Protected tags"
   - Pattern: v*
   - Allowed to create: Maintainers (или Developers, на твой выбор)
   - "Protect"

   Это нужно, чтобы Protected variable из шага 2 был доступен job'у при push тэга.
```

Заменить `<repo URL>` на реальный URL из `git remote get-url origin` (с обработкой ssh→https преобразования).

### Step 5 — Optional backfill

Если в Step 2 пользователь выбрал backfill — выполнить через `glab` для каждого тэга:

```bash
git tag -l --format='%(contents:body)' <tag> > /tmp/notes_<tag>.md
glab release create <tag> --name "<tag>" -F /tmp/notes_<tag>.md --ref <tag>
```

**Важно:** флаг для notes file — `-F`, не `--notes-file` (последнего в `glab` не существует, упадёт с `Unknown flag`). `glab release create` на существующем тэге работает как **upsert** — создаст Release или обновит существующий, отдельной команды `update` нет.

**Если в annotation тэга `#`-заголовки уже потерялись** (типичный случай при `git tag -a -m "..."` без `--cleanup=verbatim`) — `git tag -l --format='%(contents:body)'` отдаст уже урезанный текст. В этом случае пиши release notes в `/tmp/notes_<tag>.md` руками или сгенерируй из `git log` между тэгами:

```bash
git log --pretty=format:'- %s' <prev-tag>..<tag> > /tmp/notes_<tag>.md
```

Если `glab` не авторизован → STOP backfill, печатать:

```
⚠️ glab is not authenticated. Backfill skipped.
   Run `glab auth login --hostname gitlab.com` in your regular terminal,
   then re-run /gitlab-release-slack-ci with "Only backfill" option.
```

Если `glab` отсутствует — предложить backfill через GitLab UI:

```
📦 Manual backfill via GitLab UI (per tag):
   - Open <repo URL>/-/releases/new
   - Tag name: <tag>
   - Release title: <tag>
   - Release notes: paste contents from `git tag -l --format='%(contents:body)' <tag>`
   - "Create release"
```

Печатать прогресс:

```
🔁 Backfilling existing tags into Releases:
  v1.0.0  ✅ created
  v1.1.0  ✅ created
  v1.1.2  ✅ created
```

### Step 6 — Verification recipe

Не запускать ничего автоматически — пользователь должен сам убедиться. Дать ему точный рецепт:

```
✅ Verification:

1. Напиши release notes в файл (НЕ через git tag -m! см. Pitfalls §6):
   cat > /tmp/notes.md <<'EOF'
   # v<next-patch> — Test: CI release automation

   ## What changed
   - Add release notify CI
   EOF

2. Создай annotated tag из файла и пуш:
   git tag -a v<next-patch> -F /tmp/notes.md
   git push origin v<next-patch>

3. Открой <repo URL>/-/pipelines
   - Должен появиться pipeline на тэге v<next-patch>
   - Stage release → release:create job → success (~10-20s)
   - Stage notify → notify:release job → success (~30-40s, образ alpine качается)

4. Открой <repo URL>/-/releases
   - Должен быть новый Release с tag_name = v<next-patch> и notes из annotation
   - Markdown заголовки (#/##/###) должны рендериться — если их нет, см. Pitfalls §6

5. Открой свой Slack-канал
   - Должно прилететь сообщение "🚀 <project> v<next-patch>"
   - С полями Tag, Author, Release notes в code-block, ссылками на commit и pipeline

Если pipeline failed — открой job log и проверь:
- "SLACK_WEBHOOK_URL is not set" → переменная не добавлена или не протектована для tag pattern
- HTTP 400 от Slack → невалидный webhook URL
- Не появляется Release объект → пользователь не Maintainer / job 'release:create' не сматчился по rules
```

Подставить `<next-patch>` через парсинг последнего тэга (если есть): `vX.Y.(Z+1)` или `v0.1.0` если тэгов нет.

---

## Writing release notes

### Команда

Annotated tag создавать **только** через `-F notes.md`:

```bash
git tag -a vX.Y.Z -F /tmp/notes.md
git push origin vX.Y.Z
```

Не использовать `git tag -a -m "..."` — режутся строки начинающиеся с `#` (см. Pitfall §6).

### Язык release notes

**Auto-detect** при первом релизе скиллом в проекте — пользователю задавать вопрос **не нужно**, если есть сигналы. Порядок проверки:

1. **Project memory** (если main-агент видит claude-memory dir) — искать `release_notes_language.md` или похожее. Прямое указание побеждает.
2. **Existing tag annotations** — `git for-each-ref --format='%(contents)' refs/tags/v* | head -200` → определить язык по UTF-8 кириллице vs ASCII. Если ≥ 2 тэгов на одном языке — использовать его.
3. **Recent commit messages** — `git log -50 --pretty=%s%n%b` → если 80%+ commits на одном языке, использовать его.
4. **Fallback** — если все сигналы пусты или противоречивы, спросить через `AskUserQuestion` с двумя опциями (Russian / English) и одной рекомендацией на основе CLAUDE.md проекта или user-level memory.

**Записать решение** в project memory `release_notes_language.md` сразу после первого релиза — чтобы следующий запуск скилла не передопределял заново.

**Важно: commit messages и release notes — разные артефакты, могут быть разных языков.** Например, commit messages — EN imperative (Conventional Commits convention в коде), release notes — RU (читают product / стейкхолдеры). Так в [[release-notes-language]] memory clauderules-worktree.

**Прецедент:** clauderules-worktree v1.1.0–v1.1.3 написаны на русском, v1.1.5–v1.1.7 в одной сессии 2026-05-14 уехали на английский по дефолту LLM (правила не было) → пользователь вручную попросил исправить на следующий раз. После добавления auto-detect — следующие тэги в этом репо без явного запроса должны быть на русском.

### Структура

Шаблон для release notes (markdown, который пройдёт через transform в Slack mrkdwn в notify:release):

```markdown
# vX.Y.Z — короткий title (1 строка)

## Главный раздел (например, «Что изменилось»)

Параграф контекста...

- **Bold title.** Описание пункта в один-два предложения, безopaсно для Slack
  (Slack mrkdwn внутри bullet будет с indent после split title/description).
- Второй пункт без bold-title — просто bullet.

## Второй раздел (например, «Прецедент»)

...
```

После transform в `notify:release`:
- `# H1` → `🔶 *H1*` с пустой строкой выше → главный визуальный маркер
- `## H2` → `▎ *H2*` с пустой строкой → подзаголовок с левой полосой
- `- **Title.** desc` → `• *Title.*` на строке + 3-space indent description

---

## Templates

### `templates/gitlab-ci.yml`

См. файл `templates/gitlab-ci.yml` в этой же папке. Это — production-ready шаблон с двумя stages, двумя jobs, payload через `jq`, и пояснениями inline.

## Pitfalls (закодированы в шаблоне, но важно знать)

1. **annotated tag ≠ Release object.** В GitLab git tag — это git-понятие, а Release — отдельная GitLab-сущность. Push annotated тэга **не** создаёт Release сам по себе. Нужен либо `release-cli` через `release:` keyword в CI, либо REST API, либо UI. Шаблон использует `release-cli`.

2. **`curlimages/curl:latest` не содержит git.** Если в job нужны git-команды — взять `alpine:latest` + `apk add --no-cache curl jq git`, либо избавиться от git вообще через `CI_COMMIT_TAG_MESSAGE` (GitLab 15.5+). Шаблон использует второй путь — git не нужен.

3. **JSON для Slack — только через `jq`.** Release notes могут содержать кавычки, backticks, переносы. Heredoc-подстановка ломает payload на спецсимволах. `jq -n --arg x "$VAR"` экранирует автоматически. Тот же принцип «не передавать notes через shell» применяется к release-cli `description:` — см. §10.

4. **`needs:` между jobs.** `notify:release` зависит от `release:create` через `needs: ['release:create']` — если Release не создался, Slack не должен сообщить о «релизе». Без `needs:` jobs запускаются параллельно и notify может опередить release.

5. **Protected variable требует Protected tag.** `SLACK_WEBHOOK_URL` с флагом Protected доступен только в job'ах на protected ref (branch/tag). Без Protected tags pattern `v*` job увидит variable как пустую и тихо скипнется (по if-check в скрипте).

6. **`#`-заголовки в `git tag -a -m` режутся.** Default `core.commentChar = #` → все строки, начинающиеся с `#`, удаляются из tag message. Markdown release notes с `## What's new` теряют структуру → GitLab Release description и Slack-сообщение приходят без заголовков. Решение — `git tag -a -F notes.md` (или `--cleanup=verbatim`). Полный разбор — раздел «Writing release notes» выше. Прецедент: clauderules-worktree v1.1.0-v1.1.3 (май 2026) — пришлось переписывать описания всех 3 Release через `glab release create -F`.

7. **`glab release update` не существует.** На update'е существующего Release использовать `glab release create <tag> -F notes.md` — она работает как upsert. Флаг для notes file — `-F`, не `--notes-file`.

8. **`CI_COMMIT_TAG_MESSAGE` — только с GitLab 15.5+.** Self-hosted на 15.4 и старее — фоллбэк на `git tag -l --format='%(contents:body)' "$CI_COMMIT_TAG"` + `apk add git`. Скилл по умолчанию использует CI_COMMIT_TAG_MESSAGE — если у пользователя self-hosted, спросить версию через AskUserQuestion и выбрать вариант.

9. **`release-cli` image требует CI_JOB_TOKEN scope для Release API.** С GitLab 14+ это работает по умолчанию для всех проектов. Если задизейблен — `Settings → CI/CD → Token Access`, включить.

10. **`description: '$CI_COMMIT_TAG_MESSAGE'` пропускает release notes через shell eval.** Любые shell-метасимволы в annotation тэга (`${var}`, backticks ` `` `, вложенные скобки `(... (foo))`, двойные кавычки внутри fenced code-block) ломают job с `/bin/sh: eval: syntax error: unexpected word (expecting ")")`. Решение в шаблоне: записать `$CI_COMMIT_TAG_MESSAGE` в файл через `printf '%s' "$CI_COMMIT_TAG_MESSAGE" > release_notes.md` в `script:`, потом передать `description: ./release_notes.md` — release-cli читает файл напрямую через Release API без eval. Прецедент: clauderules-worktree v1.1.4 (2026-05-14) — release notes содержали `${input.app_version!}`, backticks вокруг inline code и вложенные скобки → `release:create` упал, `notify:release` skipped. Фикс: переход на file-based description.

11. **Slack возвращает HTTP 200 с body `ok` на success, но HTTP 400 с body `invalid_blocks` на превышение лимита блока.** Лимит `section.text.text` — 3000 codepoints. На Windows annotated тэги от `git tag -a -F notes.md` хранят notes с CRLF — `$CI_COMMIT_TAG_MESSAGE` приходит в job уже с CR, что почти удваивает размер и тихо переваливает за лимит. `curl -sS` молча возвращает `0` (HTTP-OK), job в pipeline зелёный, в канал ничего не пришло — **false-positive success**. Шаблон лечит сразу три класса проблем:
   - `tr -d '\r'` перед jq — убирает CRLF inflate.
   - jq-truncate `if ($notes | length) > 2700 then $notes[:2700] + "_…truncated_" else …` — гарантия в пределах лимита.
   - `curl -w 'HTTP_STATUS:%{http_code}'` + проверка `STATUS=200 AND BODY=ok` — без неё success silent-passes.

   Прецедент: clauderules-worktree v1.1.5 (2026-05-14, `notify:release` job 14367150307) — Slack ответил `invalid_blocks` HTTP 400, job показал success, сообщение не пришло. v1.1.6 с диагностикой раскрыла HTTP-код, v1.1.7 пришёл в канал с правильным форматированием.

12. **Markdown release notes не рендерятся как форматирование в Slack.** Slack mrkdwn — это **не** Markdown: нет `# H1`, нет `**bold**` (используется одна звёздочка), нет `[text](url)` (используется `<url|text>`), нет автоматических буллетов от `- item`. Без transform release notes отображаются как plain text с literal `##` и `**` символами — теряется иерархия, всё сливается в одно «месиво» (прецедент: clauderules-worktree v1.1.7-preview итерации, скриншоты пользователя).

    Шаблон содержит awk-блок markdown → Slack mrkdwn:
    - `# H1` → пустая строка + `🔶 *H1*` (главный визуальный маркер раздела)
    - `## H2` → пустая строка + `▎ *H2*` (Slack рендерит `▎` как левую «цитата»-полосу — отлично подходит для подзаголовка)
    - `### H3` → `▸ *H3*`
    - `**bold**` → `*bold*` (двойные → одинарные звёздочки)
    - `- item` → `• item` (Unicode bullet)
    - `- **Title.** description` → `• *Title.*` (на отдельной строке) + 3-space indent description (visual list of titled items)

    Плюс блочная структура для polished look:
    - `attachments` с `color: "#36C5F0"` (Slack blue) — левая цветная полоса, делает release-message сразу узнаваемым.
    - `header` block с emoji rocket + project/tag.
    - `section` с `fields` (📦 Release / 👤 Author) — две колонки.
    - `divider` сверху и снизу от notes — воздух.
    - `context` block с маленьким текстом-footer (🔖 commit · ⚙ pipeline).

    Эмодзи **Unicode** (🚀 📦 👤 📝 🔖 ⚙), не `:custom_name:` — custom emoji могут не существовать в чужом workspace и отрендерятся literal `:gear:`. Стандартный `:gear:` работает, но Unicode `⚙` надёжнее на 100%.

## Edge cases

- **Pre-release tags (v1.2.3-rc1).** Если пользователь выбрал regex с pre-releases в Step 2 — `release-cli` справится, но в Slack лучше добавить пометку «pre-release». Шаблон содержит закомментированный блок для этого.
- **Self-hosted GitLab < 15.5.** Использовать fallback вариант шаблона с `git` командой. Скилл это диагностирует через `glab api version` (если glab есть) или спросит у пользователя.
- **Несколько каналов.** Один webhook = один канал. Для нескольких — несколько `notify:release-<channel>` jobs, каждый со своей переменной `SLACK_WEBHOOK_URL_<CHANNEL>`. Не предлагается в Step 2 по умолчанию (KISS), но если пользователь спросит — добавить.
- **Уже есть Release объекты для всех тэгов.** В Step 5 backfill пропустить с пометкой `✅ all tags already have Release objects`.
- **Pipeline уже отрабатывает на push branch.** Шаблон триггерится **только** на тэги (`if: $CI_COMMIT_TAG =~ ...`), на branch push не сработает, конфликта нет.

## Что скилл НЕ делает

- Не создаёт Slack-app или webhook сам — это требует логина в Slack UI
- Не добавляет CI/CD variable в GitLab — это требует Settings → CI/CD доступа
- Не configures Protected tags — это требует Settings → Repository доступа
- Не делает `git tag` или `git push` — это решение пользователя
- Не настраивает другие GitLab integrations (issues, MR, comments) — только релизы → Slack

Эти шаги — ответственность пользователя, скилл даёт точные инструкции и проверяет результат через verification recipe.

## Related files

- `templates/gitlab-ci.yml` — production-ready CI config
- Реальный прецедент использования: clauderules-worktree, май 2026 — см. git history `.gitlab-ci.yml`
