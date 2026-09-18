---
date: 2026-09-18
slug: branch-guard-deny-once
status: applied
goal: protected-branch-guard перестаёт быть стеной — блокирует первую правку в транке, повтор пропускает с напоминанием
metric: число deny в транскриптах за период · доля deny, за которыми последовал повтор в транке (пропуск) vs переход в worktree · срабатывания L3 no-code-on-protected-branch
baseline_date: 2026-09-18
target_date: 2026-10-02
---

# Branch guard: deny один раз, повтор проходит

## Цель

Пользователь попросил ослабить `hooks/protected-branch-guard.ps1`: «предупреждал, но не блочил, чтобы агенты могли нарушать, если им нужно». Безусловный `deny` упирал агента в стену там, где правка в транке нужна (hotfix по согласованию, конфиг, явная просьба), а единственный выход — просить пользователя выставить escape-hatch.

## Baseline (до изменений, на дату 2026-09-18)

- Deny-сообщение хука (`setx CLAUDE_ALLOW_PROTECTED_BRANCH 1`) в транскриптах `~/.claude-work/projects` за 45 дней: **27 строк в 20 сессиях** (источник: `Select-String` по `*.jsonl` с mtime за 45 дней, 2026-09-18), первая 2026-08-19; часть строк — чтение самого файла хука в сессиях, которые его правили (2026-09-18: 4 — эта задача), реальных срабатываний ≈ 20. Что делал агент после deny (worktree / просьба снять блокировку) — из транскриптов не считалось.
- Таймауты хука: `branch guard` pwsh — 28 за 45 дней (`improvements/2026-09-15-hook-timeouts-are-paging.md`), к решению не относятся — подкачка.
- Escape-hatch выставлял только пользователь; агенту самому — запрещено (`CLAUDE.md`).

## Гипотеза

Из двух вариантов «предупреждать» выбран не warn-only (правка уже сделана к моменту, когда агент читает предупреждение — решение постфактум), а **deny один раз, повтор проходит** — паттерн `bash-tool-discipline` для `Grep`. Первый Write/Edit на защищённой ветке блокируется с текстом правила и worktree-процедуры; повтор того же вызова (тот же агент, репозиторий, ветка) проходит, хук добавляет `additionalContext` в контекст и `systemMessage` пользователю. Агент нарушает правило сознательно и обязан назвать причину в отчёте; L3 `no-code-on-protected-branch` в `process-gate.yaml` спрашивает, было ли исключение согласовано, — «хук пропустил» ≠ «согласовано».

Ключ состояния — `transcript_path` (у каждого субагента свой), откат на `session_id`; файл `%TEMP%\claude-branch-guard\<sha1>.json`, TTL сутки. Состояния нет — снова deny: деградация в сторону блокировки, не пропуска.

## Изменения

- `hooks/protected-branch-guard.ps1` — состояние «уже предупреждал» (`Get-StateFile`/`Read-State`/`Write-State`, sweep протухших при первой записи), ветка pass-through без `permissionDecision`, текст deny переписан (EnterWorktree первым, «повтори тот же вызов» вместо «попроси снять блокировку»), override'ы для тестов `CLAUDE_BRANCH_GUARD_STATE_DIR` / `CLAUDE_BRANCH_GUARD_REGISTRY`.
- `hooks/protected-branch-guard.tests.ps1` — новый, 23 проверки: deny → pass-through → другой агент deny → другая защищённая ветка deny → обратно pass → незащищённая/escape-hatch/Read молчат → имя state-файла sha1 → стёртое состояние снова deny → запись старше TTL снова deny. `pwsh -NoProfile -File hooks/protected-branch-guard.tests.ps1` → 23/23.
- Ревью диффа (2.3b) дало три подтверждённые находки, все закрыты до коммита: возраст записи не проверялся на чтении (собственная запись не истекала — `claude --resume` через сутки пропускал бы первую правку без текста правила; теперь TTL сверяется при чтении, тест 11); вакуумный assert в тесте 5b (`$null -eq $null` на пустом stdout — добавлена позитивная проверка `additionalContext`); унаследованная подсказка `setx … на сессию` — `setx` не меняет env запущенного CLI, текст заменён на файл-флаг (сразу) / env при перезапуске.
- `CLAUDE.md` «Защищённая ветка и worktree» — «блокирует первый Write/Edit; повтор проходит с напоминанием — сознательное исключение, причина в отчёт».
- `config/protected-branches.example.json`, `skills/doc-task/SKILL.md`, `docs/backlog/protected-branch-bash-writes.md`, `review-rules/process-gate.yaml` (`no-code-on-protected-branch` → message + source) — синхронизированы с новой семантикой.

Контракт `additionalContext` для PreToolUse сверен по документации code.claude.com/docs/en/hooks и по бандлу CLI 2.1.276 (источник: строки `claude.exe` — схема `hookEventName:"PreToolUse"` содержит `additionalContext`, значение собирается в поле `additionalContexts` → «Text injected into model context»). Живой прогон из worktree невозможен (приватный `settings.json` профиля зовёт хук по пути главного checkout) — первый пропуск в реальной сессии после merge подтвердит, что напоминание видно в tool result.

## Target

К 2026-10-02: deny-сообщений в транскриптах не меньше, чем раньше (первое срабатывание сохранилось); появились pass-through (`пропущена как сознательное исключение`), и у каждого в отчёте задачи названа причина; L3 `no-code-on-protected-branch` не пропустил ни одного пропуска без причины. Пропуск на автопилоте (повтор без причины в отчёте) — откат к безусловному deny.

## Replay (заполняется через N дней)

_pending_
