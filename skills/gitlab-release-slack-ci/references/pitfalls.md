# GitLab Release → Slack — Pitfalls

Детальный каталог граблей (все закодированы в `templates/gitlab-ci.yml`, но важно понимать при отладке).

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
