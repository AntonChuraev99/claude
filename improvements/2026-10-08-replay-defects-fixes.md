---
date: 2026-10-08
slug: replay-defects-fixes
status: applied
goal: убрать дефекты хуков и скриптов, найденные replay-аудитом 2026-10-08
metric: ложные deny credentials-guard; reauth-отказы у субагентов посреди работы; ошибки «No such tool: TaskCreate»; сессии со сменой модели без оверлея; бесполезные повторы Grep после отказа; записи субагента мимо worktree
baseline_date: 2026-10-08
target_date: 2026-10-22
---

# Дефекты харнесса из replay 2026-10-08

## Цель
Replay 25 записей (PR #45) нашёл дефекты вне своих записей. Пользователь: «дефекты харнесса, которые нашли попутно, поправь тоже».

## Baseline (2026-09-08 … 2026-10-08)
| Дефект | Замер |
|---|---|
| `credentials-guard` ложные deny | 28 deny, ни одного на команде под чужим аккаунтом: глагол деплоя искался по всей строке, текст heredoc/issue считался командой, `cd /c/...`, `~`, переменные не разбирались |
| субагент без вердикта gcloud-сессии | 6 отказов `Reauthentication failed` у субагентов посреди работы; дайджест приходит только на SessionStart |
| `TaskCreate` недоступен | 6 сессий, 30 ошибок; CLI с v2.1.268 включает Task-тулы по умолчанию не на всех моделях, Opus 5.x в их числе нет |
| оверлей не видит `/model` | 4 сессии на Fable получили оверлей Opus: хук был только на SessionStart |
| отказ `Grep` по символу | 725 отказов, 472 повтора тем же паттерном; 203 — у проекта нет индекса ast-index, 86 — поиск в одном файле |
| субагент пишет в главный checkout | 1 случай (10-08): повтор после deny-once прошёл |
| сообщение коммита не проверяется на утечку | 1 случай (09-18): почта в сообщении коммита |
| `session-stages.py` | ревью гейта 2.3b с описанием «Diff review …» считалось «fresh» (68 за 14 дней) |
| `task-gate-timings.jsonl` | нет `branch`, строка `NOT READY` не писалась — две метрики гейта не считались |

## Гипотеза
Каждый дефект — узкий корень в одном хуке или скрипте; починка на этом слое с red-репро снимает шум без ослабления защиты.

## Изменения
- `hooks/credentials-guard.ps1`, `hooks/credentials-guard-prefilter.js` — глагол деплоя засчитывается в той же команде, что и инструмент; маска неисполняемого текста (heredoc, тело сообщения), кроме `bash -c` / `eval` / `| bash` / `iex` / `ssh` / `--exec`; разбор `cd` с `/c/...`, `~`, переменными из той же команды; scratchpad как cwd — по имени проекта. Попутно закрыты две дыры: `firebase deploy --project <чужой>` и второй пакет в `adb uninstall A && adb uninstall B`. Нераскрываемая переменная перед firebase/wrangler/gh — по-прежнему deny. Новый `hooks/credentials-guard.tests.js`.
- `hooks/credentials-digest.ps1` — SessionStart пишет вердикт пробы в файл; на SubagentStart хук отдаёт одну строку о сессии gcloud/firebase без сетевой пробы. Регистрация — `settings.example.json`.
- `settings.example.json` — `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; событие `PostModelSwitch` для `model-overlay.ps1`; SubagentStart для `credentials-digest.ps1`; `revenuecat@RevenueCat: false`.
- `hooks/model-overlay.ps1` — обработка `PostModelSwitch`: оверлей один раз на смену файла оверлея.
- `hooks/bash-tool-discipline.js` — отказ `Grep` только при непустом индексе ast-index у каталога поиска и не для поиска в одном файле.
- `hooks/protected-branch-guard.ps1` — только комментарий: фоновые субагенты PreToolUse получают (в транскрипте 10-08 есть `hook_success`). Случай 10-08 — субагента запустили до `EnterWorktree`, его cwd был главный checkout. Жёсткий deny для субагентов не вводится: решение пользователя — и главному, и субагенту deny-once («пусть предупреждает, но даёт править»), см. [branch-guard-deny-once](2026-09-18-branch-guard-deny-once.md).
- `CLAUDE.md` («Защищённая ветка и worktree») — неверная фраза «`run_in_background` не наследует PreToolUse» заменена на «пишущего субагента до `EnterWorktree` не спавнить»; длина не выросла.
- `agents/product-expert.md` — RevenueCat через авторизованный коннектор `mcp__claude_ai_RevenueCat` вместо плагина; скилл плагина `revenuecat:revenuecat-charts` убран из списка (0 вызовов за месяц).
- `hooks/commit-msg` (новый), `hooks/pre-commit` (`--print-pattern`), `README.md` — проверка сообщения коммита тем же denylist.
- `scripts/session-stages.py` — «Diff review …» относится к гейту 2.3b.
- `skills/task-gate/SKILL.md` §5.2 — в строке тайминга поле `branch`, `repo` — имя главного checkout, строка пишется и при `NOT READY`.
- `config/optional-capabilities.md` — дубли RevenueCat и Atlassian.
- `README.md` — убрано упоминание выключенного `git-worktree-env`.

## Target (2026-10-22)
- ложных deny `credentials-guard` ≤ 3 за 2 недели, deny на реальном расхождении аккаунта — не меньше, чем раньше;
- reauth-отказов у субагентов посреди работы — 0, если вердикт «ПРОСРОЧЕНА» был на старте;
- ошибок «No such tool: TaskCreate» — 0;
- сессий со сменой модели и чужим оверлеем — 0;
- повторов `Grep` тем же паттерном после отказа — не больше 1/4 от прежних 472 в пересчёте на месяц;
- записей субагента в главный checkout из worktree-сессии — 0 (правило в `CLAUDE.md`, не хук);
- product-expert достаёт данные RevenueCat через коннектор без отказа «нет тула».

## Replay (заполняется 2026-10-22)
