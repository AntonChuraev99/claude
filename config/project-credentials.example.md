# Реестр кредов проектов — шаблон

Скопировать в `project-credentials.local.md` (gitignored) и заполнить своими значениями.

Файл читает `hooks/credentials-guard.ps1` перед выполнением команд, которые меняют состояние во внешних сервисах (`gcloud`, `wrangler`, `firebase`, `gh`, `adb`). Задача — не дать задеплоить в чужой аккаунт из соседнего проекта.

## Формат

Одна таблица, строка на репозиторий. `repo_path` — абсолютный путь к корню репозитория либо его последний сегмент (сравнение идёт по вхождению, регистр не важен). Пустая ячейка означает «сервис в этом проекте не используется».

| repo_path | account | gcp_project | cf_account_id | firebase_project | play_package | git_remote |
|---|---|---|---|---|---|---|
| C:\Users\YOUR_USERNAME\StudioProjects\<your-project> | personal@example.com | your-gcp-project-id | 0000000000000000000000000000000 | your-firebase-project | com.example.app | git@gitlab.com:org/repo.git |
| C:\Users\YOUR_USERNAME\Documents\<another-project> | work@example.com | another-gcp-id |  | another-firebase | com.example.other | git@github.com:org/other.git |

`account` — почта, под которой должен идти деплой этого проекта. Это главная колонка: остальные идентификаторы уточняют, но именно смена аккаунта приводит к необратимой ошибке.

## Как это работает

1. Команда матчит опасный шаблон — деплой, публикация, запись секрета, релиз. Обёртки (`npx`, `pnpm dlx`, `bash -c`, префикс `VAR=1`) распознаются: `npx wrangler deploy` — такой же деплой, как прямой вызов.
2. Хук определяет каталог команды: последняя `cd`/`pushd` в цепочке, иначе рабочий каталог сессии.
3. Ищет строку реестра с самым длинным `repo_path`, совпадающим по границе сегмента пути.
4. **Сам сверяет фактические значения** и при совпадении пропускает команду молча — штатный деплой не требует действий.
5. Расхождение либо невозможность сверить (строки нет, колонка пуста, инструмент не разобран, каталог не определён) → `deny` с обоими значениями. Снимает блокировку пользователь: `CLAUDE_ALLOW_DEPLOY=1`.

Источники сверки, все локальные и быстрые; CLI — только резерв, общий бюджет проб ограничен: Firebase — `.firebaserc`, затем `google-services.json` модуля приложения, затем `firebase use`; Cloudflare — `account_id` из `wrangler.jsonc/json/toml`, затем `wrangler whoami`; GCP — `gcloud config get-value project`; GitHub — `git remote get-url origin` (ssh и https сравниваются по `org/repo`); Play — package из самой команды.

Значения из конфигов сравниваются **строго**: `myapp` не совпадает с `myapp-staging`, иначе деплой в соседний проект того же семейства проходил бы молча. Сырой вывод CLI сверяется по границе токена.

## Что считается опасной командой

`deploy` · `publish` · `release` · `secret set|put` · `functions deploy` · `hosting:channel:deploy` · `run deploy` · `pages deploy` · `apps release` · `gh release create` · `gh repo delete` · `adb uninstall`.

Чтение (`list`, `describe`, `whoami`, `status`, `logs`) не блокируется.
