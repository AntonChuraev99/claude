---
name: setup
description: Подключает проект к харнессу ~/.claude одной командой — определяет стек, ставит недостающие CLI под этот стек (ast-index, gh, jq, uv, android CLI, adb, firebase-tools, glab, gitleaks — через winget/npm), строит индекс ast-index, заносит проект в реестр защищённых веток и в реестр кредов, дописывает .worktreeinclude и .gitignore для worktree, затем прогоняет harness-doctor. Используй на «/setup», «настрой проект», «подключи проект к харнессу», «поставь ast-index и остальное», «установи инструменты для проекта», «новый проект — настрой всё», после клонирования репозитория на новую машину. НЕ использовать для: проверки уже настроенного проекта и конфликтов инструкций (это harness-doctor), установки самого Claude Code и его MCP (встроенные /doctor и /mcp), установки сторонних скиллов (find-skills), сборки и запуска приложения (run, install-device).
allowed-tools: Bash, PowerShell, Read, Edit, Write, AskUserQuestion, Skill, EnterWorktree
---

# setup

Источник проверок и починки — `~/.claude/skills/harness-doctor/scripts/doctor.py`.
Список CLI, winget id и минимальные версии живут там, в `TOOLS`. Здесь — порядок
шагов и то, что скрипт не делает.

Пользователь вызвал `setup` — это согласие ставить CLI и строить индекс. По шагам
не переспрашивай. Единственный вопрос — почта аккаунта для деплоя (шаг 2).

## 1. Разведка

```bash
python "$HOME/.claude/skills/harness-doctor/scripts/doctor.py" --project "<корень проекта>" --json
```

Из JSON возьми: `project.stacks`, `project.is_worktree`, проверки со статусом
`fail`. Каталог не git-репозиторий — реестр веток, worktree и PR-флоу к нему не
применяются, ставь только CLI.

Одна строка в чат: стек, сколько CLI ставим, что регистрируем.

## 2. Аккаунт для деплоя

Есть проверка `project-credentials` с `fix.kind: input` — у проекта есть
Firebase, Cloudflare или Android-приложение, а строки в реестре кредов нет.
Спроси через `AskUserQuestion`: «Под какой почтой деплоится <проект>?», варианты —
почты из колонки `account` в `~/.claude/config/project-credentials.local.md`.
Почту из git-конфига и из окружения не подставляй.

## 3. Установка и регистрация

```bash
python "$HOME/.claude/skills/harness-doctor/scripts/doctor.py" --project "<корень>" --fix [--account <почта>] --json
```

Скрипт ставит недостающие CLI, строит индекс ast-index, заносит проект в оба
реестра. Индекс строится в основном checkout'е: из worktree ast-index читает его
через хук `ast-index-worktree`.

**Ограничение.** `gcloud` скрипт не ставит: установщик просит UAC. Он идёт в
`## 👉 Сделай руками` командой `winget install -e --id Google.CloudSDK`.

Установка упала — покажи последние строки ошибки из `message`. Не ставь тот же
пакет другим способом без вопроса.

## 4. Файлы проекта

Проверки `worktreeinclude` и `gitignore-worktrees` с `fix.kind: edit` правят
tracked-файлы проекта. Делай это в worktree проекта (`EnterWorktree`, slug
`setup-harness`): допиши строки из `append` в `.worktreeinclude` и `.gitignore`.
Коммит и PR — через `/task-gate`.

`.claude/rules/ast-index.md` и `.claude/settings.json` от `ast-index:initialize`
не создавай. Плагин уже включён глобально, правила поиска даёт глобальный
CLAUDE.md, а шаблон плагина велит `rebuild`/`update` и противоречит ему.

## 5. Проверка

Вызови скилл `harness-doctor`. Он перепроверит всё и разберёт конфликты
инструкций проекта с глобальными.

## Отчёт

- Стек и маркеры.
- Поставленные CLI с версиями; индекс ast-index — файлы и символы.
- Записи в реестрах и правки файлов проекта.
- Итог `harness-doctor`.
- `## 👉 Сделай руками`: `gcloud`, логины (`! gh auth login`, `! gcloud auth login <почта>`,
  `! firebase login`), перезапуск терминала, если CLI не виден в PATH.
