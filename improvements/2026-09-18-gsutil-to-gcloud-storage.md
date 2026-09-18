---
date: 2026-09-18
slug: gsutil-to-gcloud-storage
status: applied
goal: харнесс не зависит от gsutil — Cloud Storage только через gcloud storage, которое покрыто account-align
metric: число команд gsutil, которые агент предложил или исполнил за период (ожидается 0)
baseline_date: 2026-09-18
target_date: 2026-10-02
---

# gsutil → gcloud storage

## Цель

Письмо Google от 2026-09-18: после марта 2027 `gsutil` не входит в состав Google Cloud CLI, дальше — только standalone через PyPI ([Install gsutil](https://docs.cloud.google.com/storage/docs/gsutil_install)). Убрать зависимость харнесса от `gsutil` заранее, пока апдейт SDK его ещё не выбросил.

## Baseline (до изменений, на дату 2026-09-18)

- Локально Cloud SDK 560.0.0, `gsutil 5.36` как бандл-компонент; `gcloud storage` доступен.
- В `~/.claude` ни один хук и скрипт `gsutil` не исполняет. Исполняемые инструкции — 2 команды в `agents/google-play-console-expert/README.md` (GCS-экспорт Play Console). Ещё 6 мест в доках и SessionStart-дайджесте говорят «`gsutil` не покрыт `account-align`» — то есть агент, выбравший `gsutil`, шёл бы мимо подстановки аккаунта и упирался в guard.
- В проектах пользователя `gsutil` — только в комментариях и solution-доках (`gsutil cors set`, `gsutil cp`), исполняемого нет.

## Гипотеза

`gcloud storage` — обычный `gcloud`: хук `account-align` уже подставляет ему `--account`/`--project` (`hooks/account-align.tests.js:61-66`), а `credentials-guard` ловит `gcloud storage rm -r` тем же `rm\s+-r`. Замена команд в README и явная пометка «`gsutil` — legacy, не использовать» в скилле `claude-profiles`, примере реестра и дайджесте закрывает и письмо, и дыру покрытия одним ходом. Детект `gsutil` в guard оставлен: стоит ноль, ловит отдельно установленный бинарь.

## Изменения

- `agents/google-play-console-expert/README.md` — `gsutil ls/cp` → `gcloud storage ls/cp`, wildcard в кавычках, пояснение почему.
- `CLAUDE.md` («Автономность») — `gsutil` убран из фразы про покрытие; фраза стала короче (файл над лимитом).
- `skills/claude-profiles/SKILL.md`, `config/project-credentials.example.md`, `hooks/credentials-digest.ps1` — «`gsutil` — legacy, для Cloud Storage `gcloud storage`» (в дайджесте — той же строкой, без второй: #24 его урезал).
- Попутно по ревью 2.3b — дрейф доки, вскрытый переписыванием той же фразы: три файла (`CLAUDE.md`, `SKILL.md`, `project-credentials.example.md`) обещали, что MCP-тулы «сверяет и блокирует `credentials-guard`», а `hooks/credentials-guard.ps1:103` выходит на любом `tool_name`, кроме `Bash`/`PowerShell`; теперь — «MCP не видит ни хук, ни guard, сверять самому». `SKILL.md` описывал матчер `Bash` и 7 глаголов при фактических `Bash|Grep|PowerShell` и 11 глаголах из `config/credentials-guard-patterns.json` — заменено ссылкой на файл-источник.
- `hooks/credentials-guard.ps1` — комментарий, почему детект `gsutil` остаётся.
- `hooks/credentials-guard-prefilter.tests.js` — кейс `gcloud storage rm -r` (30/30 зелёные).
- `docs/decisions/credentials-account-injection-2026-09-07.md` — граница покрытия актуализирована.
- `hooks/account-align.js` — баг, вскрытый коммитом этой задачи: `commandPositionRe` считал любую `(` позицией команды, и `git commit -m "chore(gcloud): …"` получил `chore(gcloud --account=<почта>): …` — почта в публичном репозитории (коммит amend'нут до push). Три итерации, каждую следующую вскрывало ревью 2.3b: (1) скобка — позиция команды только не после буквы — закрыла экземпляр, не класс (`(` после пробела, `;`, `&&` в теле сообщения); (2) маска кавычек — текст в `"…"`/`'…'` пробелами той же длины — применяла escape-правила bash и PowerShell разом, и `\"` в PS-пути или `` `" `` в bash съедали закрывающую кавычку: чётность инвертировалась, следующая строка оказывалась «снаружи»; heredoc и PS here-string `@'…'@` (форма commit-message из описания тула PowerShell) не знала вовсе; (3) `maskText(command, shell)` — шелл-зависимые правила (bash: `\` в `"…"`, `$'…'`; PowerShell: `` ` ``, `""`, `''`), heredoc `<<WORD` до строки-терминатора, here-string `@"…"@`/`@'…'@`, комментарии, `$(…)` внутри `"…"` разбирается как код, чтобы его кавычки не закрыли внешнюю строку. Шелл префильтр берёт из `tool_name`. Цена — `"$(gcloud …)"` внутри кавычек не выравнивается (как и `bash -c "…"` до этого; guard при расхождении блокирует). Красные репро (фактические прогоны): lookbehind на старом регексе — 2 падения из 40; маска v1 на lookbehind-версии — 3 из 47; `maskText` на маске v1 — 8 падений из 60 плюс отсутствующий экспорт; итог 61/61.
- `hooks/credentials-guard.ps1` — тот же неквалифицированный `(` в `$posRe` давал ложный deny на `git commit -m "fix(firebase): deploy …"` (S-1 ревью); lookbehind `(?<![\w)])\(`. Маску кавычек guard'у не давать: `bash -c "wrangler deploy"` обязан ловиться. Красный репро в `credentials-guard-prefilter.integration.tests.js`: на старом ps1 кейс `fix(gcloud): deploy --project <чужой>` → deny, с фиксом → allow (29/29).

## Target

К 2026-10-02: ни одной предложенной или исполненной команды `gsutil` в транскриптах; `gcloud storage …` в проектных каталогах проходит с подставленным `--account` без вмешательства пользователя.

## Replay (заполняется через N дней)

pending
