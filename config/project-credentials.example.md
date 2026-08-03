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

1. Команда матчит опасный шаблон — деплой, публикация, запись секрета, релиз.
2. Хук ищет строку реестра, чей `repo_path` совпадает с текущим рабочим каталогом.
3. Строка найдена → хук показывает ожидаемые значения и требует подтверждения перед выполнением.
4. Строки нет → предупреждение «для этого репозитория креды не заданы». Не блокирует, но видно, что реестр неполон.

Проверка фактического активного аккаунта (`gcloud config get-value project`, `wrangler whoami`, `firebase use`) — на агенте: хук печатает, что именно надо сверить, агент запускает и сравнивает. Так хук остаётся быстрым и не дёргает сеть на каждый Bash.

## Что считается опасной командой

`deploy` · `publish` · `release` · `secret set|put` · `functions deploy` · `hosting:channel:deploy` · `run deploy` · `pages deploy` · `apps release` · `gh release create` · `gh repo delete` · `adb uninstall`.

Чтение (`list`, `describe`, `whoami`, `status`, `logs`) не блокируется.
