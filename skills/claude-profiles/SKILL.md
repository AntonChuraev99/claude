---
name: claude-profiles
description: Профили и креды. Два профиля Claude Code на одной машине (claude / claude-work) и правила линковки между ними; реестр кредов проектов и защита от деплоя в чужой аккаунт; source of truth ~/.claude/; диагностика «MCP или скилл не установлен» до вывода о переустановке.
when_to_use: правка симлинков и junction между профилями, «MCP не установлен», ToolSearch не нашёл ожидаемый тул, скилл не отрабатывает, деплой или публикация во внешний сервис, сработал creds guard, новый проект нужно завести в реестр кредов
---

# Профили Claude Code и линковка

## Две независимые подписки на одной машине

Изолированы по `CLAUDE_CONFIG_DIR`:
- `claude` — personal, без env-var, config dir `~/.claude/`;
- `claude-work` — work, alias `claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'` (проверка: `type claude-work`).

Профили **обязаны оставаться независимыми по логину** — раздельный OAuth и подписка. Аудит изоляции: `fsutil hardlink list ~/.claude-work/.claude.json` должен вернуть один путь; то же для `.credentials.json`.

Перед любой правкой линковки — прочитать `~/.claude/improvements/2026-05-04-claude-work-hardlink-account-leak.md`: прецедент и команды восстановления.

## Source of truth — `~/.claude/`

Все правки `CLAUDE.md`, `agents/*`, `skills/*`, `rules/*`, `improvements/*`, `settings.json` — только по пути `%USERPROFILE%\.claude\...`, не по `.claude-work\...`.

Системный контекст показывает `Contents of %USERPROFILE%\.claude-work\CLAUDE.md` — это проекция через junction, а не источник. Правка формально сработает (один inode), но при сбое линка уйдёт не туда и не попадёт в `.claude\`.

## Что можно и нельзя линковать

**Можно** (junction `mklink /J`): папки общей инфраструктуры — `agents/`, `commands/`, `skills/`, `rules/`, `plugins/`, `agent-memory/`, `config/`, `improvements/`, `stats/`. `CLAUDE.md` — symlink. `settings.json` — symlink только если нет per-account хуков.

**Категорически нельзя** (никаким способом): `.claude.json`, `.credentials.json`, `todos/`, `statsig/`, `shell-snapshots/` — линковка сломает раздельный логин.

**Hard link (`mklink /H`) запрещён для любых JSON-конфигов CLI.** Claude Code пишет атомарно (write-temp → rename), это разрывает hard link и сливает `oauthAccount` обоих профилей. Нужна общая копия — symlink, но для `.claude.json` и `.credentials.json` запрещён и он.

**MCP-сервер в обоих профилях:** не линковать `.claude.json`, а добавить отдельно `claude mcp add` в каждом профиле.

## Креды проектов — защита от деплоя в чужой аккаунт

Один CLI обслуживает несколько проектов, а активный аккаунт живёт в глобальном конфиге инструмента, не в репозитории. Поэтому `wrangler deploy` из проекта A может уехать в аккаунт проекта B — и это необратимо.

**Реестр:** `~/.claude/config/project-credentials.local.md` (gitignored, шаблон рядом — `project-credentials.example.md`). Строка на репозиторий: `repo_path` → ожидаемые `gcp_project`, `cf_account_id`, `firebase_project`, `play_package`, `git_remote`. Пустая ячейка означает, что сервис в этом проекте не используется.

**Два хука.** `hooks/credentials-digest.ps1` на `SessionStart` печатает таблицу кредов текущего проекта в начале сессии: аккаунт, GCP, Cloudflare, Firebase, Play package, git remote. Репозиторий в списке «не наши» — предупреждает, что деплой отсюда не выполняется. Репозитория нет в реестре, но каталог под git — напоминает сверить аккаунт вручную и завести запись. Вне git молчит.

**Хук-гейт:** `hooks/credentials-guard.ps1`, зарегистрирован на `PreToolUse` с матчером `Bash`. Срабатывает, когда команда содержит инструмент внешнего сервиса (`gcloud`, `wrangler`, `firebase`, `gh`, `adb`, `gsutil`) **и** глагол, меняющий состояние (`deploy`, `publish`, `release create`, `secret set/put`, `apps release`, `repo delete`, `uninstall`). Чтение — `list`, `describe`, `whoami`, `status`, `logs` — не трогает.

Что делает хук: находит строку реестра по каталогу команды (учитывает `cd <path> &&`, иначе берёт `cwd` сессии), **сам сверяет фактические креды** и при совпадении пропускает команду молча — штатный деплой не требует никаких действий.

Источники сверки, все локальные и быстрые (~300 мс), CLI — только как резерв: Firebase — `.firebaserc`, затем `google-services.json` модуля приложения, затем `firebase use`; Cloudflare — `account_id` из `wrangler.jsonc/json/toml`, затем `wrangler whoami`; GCP — `gcloud config get-value project`; GitHub — `git remote get-url origin` (ssh и https формы сравниваются по `org/repo`); Play — package из самой команды.

`deny` выдаётся в двух случаях: фактическое значение разошлось с реестром, либо сверить нечем (репозитория нет в реестре, нужная колонка пуста, инструмент не распознан). Тогда порядок такой: показать пользователю расхождение и остановиться. Снять блокировку разово может только он — `CLAUDE_ALLOW_DEPLOY=1`; агенту выставлять её нельзя, это обход проверки, ради которой хук существует.

До 2026-08-04 хук возвращал `ask`, а CLI при `bypassPermissions` его молча проглатывал — то есть защита не работала вовсе, см. `improvements/2026-08-04-credentials-guard-was-inert.md`. Записи нет — предупреждает, что репозиторий не заведён. Реестра нет вовсе — предупреждает и отправляет создать его из шаблона.

**Что делать, когда хук сработал:**

1. Запустить проверку из его текста: `gcloud config get-value project` · `wrangler whoami` · `firebase use` · `git remote -v`.
2. Совпало с реестром — подтвердить и выполнять.
3. **Не совпало — остановиться и сказать пользователю.** Не «переключусь на нужный аккаунт и продолжу»: расхождение означает, что либо активен чужой аккаунт, либо реестр устарел, и решать это пользователю. Переключение аккаунта вслепую — тот же класс ошибки, что и деплой не туда.
4. Проект новый и записи нет — дописать строку в реестр после того, как пользователь подтвердил значения.

Хук намеренно не дёргает сеть сам: проверку запускает агент, поэтому каждый `Bash` не оплачивается лишними секундами. Любая внутренняя ошибка хука — тихий `exit 0`, работу он не ломает.

## Диагностика «MCP / плагин / скилл не установлен»

**Триггер:** `ToolSearch` не нашёл ожидаемый MCP-тул, скилл не отрабатывает, «вчера работало».

**До** вывода «не установлено», переустановки или отказа от использования выполнить (одним `Bash`):

1. `claude mcp list` — `✓ Connected` ≠ `! Needs authentication` ≠ отсутствие в списке. В списке и Connected → проблема **не в сервере**.
2. `cmd //c "dir %USERPROFILE%\.claude-work /AL"` — увидеть junction'ы и понять, где реальный источник.
3. `find %USERPROFILE%\.claude\plugins\cache\<plugin>` — наличие `.mcp.json` или `.claude-plugin/plugin.json` значит, что плагин на диске стоит.
4. `claude mcp list` показывает `✓ Connected`, а `ToolSearch` пуст — это расхождение каталога клиента с живым состоянием сервера, не «не установлено». Лечится рестартом самой сессии Claude Code; команды `claude mcp restart` не существует. Опционально прозвонить сервер напрямую: `npx -y mcp-remote <url> --header "Authorization: Bearer $TOKEN"` + `tools/list` JSON-RPC — непустой `result.tools[]` значит, что сервер живой и проблема на клиенте.

**Запрещено без шагов 1-3:** говорить «MCP не установлен», предлагать `claude mcp add`, советовать переустановку плагина, объявлять fallback (WebSearch/WebFetch) единственным путём. «Не вижу в ToolSearch» ≠ «не установлено».
