---
title: "Аккаунт CLI подставляется в команду, а не переключается в конфиге"
summary: "PreToolUse-хук дописывает --account/--project из реестра проекта в команды gcloud и firebase, вместо переключения глобального состояния CLI."
date: 2026-09-07
type: decision
modules: [hooks, skills, config]
keywords: [gcloud, firebase, credentials, account-align, PreToolUse, worktree, updatedInput, authentication]
project: claude-code-harness
---

# Аккаунт CLI подставляется в команду, а не переключается в конфиге

**Суть:** `hooks/account-align.js` (модуль внутри `credentials-guard-prefilter.js`, событие `PreToolUse`) находит строку реестра `config/project-credentials.local.md` по каталогу команды и дописывает глобальные флаги: `gcloud` → `--account --project`, `firebase` → `--account`. Глобальное состояние CLI не меняется.

## Проблема

Просьбы «залогинься заново» приходили почти каждую сессию — но **не из-за токенов**: `print-access-token` и `projects:list` для обоих аккаунтов отработали без запроса логина.

Причина — потеря привязки по пути. `firebase-tools` хранит её в `~/.config/configstore/firebase-tools.json` (`activeAccounts`) по **абсолютному пути** каталога, а каждая задача идёт в новом worktree; оттуда `firebase login:list` показывает глобальный дефолт. У `gcloud` активная конфигурация одна на машину и остаётся от прошлой задачи.

Сколько времени это стоило — не измерялось.

## Решение

`PreToolUse` заменяет параметры тула через `hookSpecificOutput.updatedInput` (проверено на Claude Code 2.1.263: `echo PROBE_ORIGINAL` исполнился подменённым):

```
firebase deploy               →  firebase --account=<почта> deploy
gcloud run deploy --region X  →  gcloud --account=<почта> --project=<id> run deploy --region X
```

Каталог — последняя `cd` в цепочке (относительный путь резолвится от `cwd`), иначе `cwd`. Строка реестра выбирается по границе сегмента пути; из подходящих — самая длинная.

Не подставляется: `gcloud auth login|revoke|application-default`, `firebase login|logout` (ими чинят токен), команды с явным `--account`/`--configuration`, каталоги вне реестра. Явный `--project` отменяет подстановку только проекта — учётка им не названа.

## Почему именно так

- `configurations activate` / `login:use` — мутируют состояние, общее для всех сессий; `login:use` вдобавок пишет привязку по абсолютному пути, воспроизводя исходную проблему.
- Прямая запись `activeAccounts` — внутреннее состояние CLI, не публичный контракт.
- Переменные окружения — работают, но в PowerShell присваивание отделяется `;` и **разрывает `&&`-цепочку**: `cd X && $env:A='v'; gcloud deploy` выполнит деплой даже после провала `cd`. Отвергнуто по итогам ревью диффа.
- Флаги CLI ✅ — одинаковы в обоих шеллах и живут внутри своей команды.

## Как это уживается с credentials-guard

Guard судит **уже выровненную** команду, и проект, названный прямо в ней, для него приоритетнее `gcloud config get-value project`: исполнится именно он. Подстановка из реестра — работа хука; снятие выданного `deny`, ручное переключение и логин остаются за пользователем.

## Границы покрытия

`gsutil` (нет своего флага аккаунта), MCP-тулы Firebase, и жёсткие запреты `bash-tool-discipline` на тул `PowerShell` — см. `docs/backlog/powershell-tool-discipline.md`.

## Связанные файлы

- Реестр и описание механизма: `config/project-credentials.example.md`
- Код и тесты: `hooks/account-align.js`, `hooks/account-align.tests.js`, `hooks/credentials-guard-prefilter.js`, `hooks/credentials-guard.ps1`
- Правила: `CLAUDE.md` → «Автономность»; `skills/claude-profiles/SKILL.md`
- Гипотеза и replay: `improvements/2026-09-07-account-align.md`
