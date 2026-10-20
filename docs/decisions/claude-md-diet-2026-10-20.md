---
title: "Глобальный CLAUDE.md сокращён вдвое: инварианты остаются, процедуры уходят к носителям"
summary: "CLAUDE.md сокращён с 34 553 до 16 801 символа. Граница — по механизму: в файле только инвариант на каждую сессию, процедура живёт в скилле, правило по типу файлов — в rules/ с paths, безусловное — в хуке, который сам печатает свои границы. Порог claude-md-size-guard опущен до 17 500."
date: 2026-10-20
type: decision
modules: [claude-md, hooks, agents]
keywords: [claude-md, resident-context, instruction-routing, claude-md-size-guard, agent-description, context-budget]
project: claude-code-harness
---

# Глобальный CLAUDE.md сокращён вдвое

> Объём: 460 слов — таблица «что убрано → где живёт» нужна целиком: по ней следующая правка проверяет, не теряет ли она носитель правила.

**Суть:** `CLAUDE.md` сокращён с 34 553 до 16 801 символа (источник: `python -c "len(open('CLAUDE.md').read())"` до и после). Убраны обоснования и пересказ процедур, у которых уже есть носитель. Порог хука `hooks/claude-md-size-guard.py` опущен с 37 000 до 17 500, чтобы рост снова был виден. Описания четырёх агентов сокращены (сумма description 27 408 → 23 890 символов, источник: тот же замер по `agents/*.md`).

## Проблема

Сверка с документацией Anthropic на 2026-10-20 (страницы memory и best-practices на code.claude.com): длинный CLAUDE.md снижает соблюдение правил, `@import` стоимость не снижает, потому что импорт грузится при старте. Наш файл формально укладывался в рекомендацию «до 200 строк» (источник: code.claude.com/docs/en/memory) — 196 строк (источник: `s.count('\n')` по версии на `origin/main`), но средняя строка была ~175 символов. Прошлые сокращения (`improvements/2026-09-23-claude-md-char-trim.md`) снимали по несколько процентов и выбирали абзацы по длине, а не по тому, есть ли у правила другой носитель.

## Решение

Каждое правило проверяется вопросом «если убрать — Claude ошибётся?» и затем вопросом «где ещё оно живёт?». Убирается то, у чего есть носитель:

| Что убрано из CLAUDE.md | Носитель |
|---|---|
| Вливание транка перед MR, исключение транк→транк, команды merge | `skills/task-gate/references/mr-merge.md` |
| Мутация, режимы `@test-expert`, строка `Mode:` | `rules/testing.md` |
| Кадр «до» снимается до первой правки | `skills/screenshot-driven-ui/SKILL.md` |
| Порядок цепочки Compose-фичи | `rules/compose-feature-chain.md` |
| `invalid_rapt`, команды логина | `hooks/credentials-digest.ps1` (печатает на SessionStart) |
| Повторный Grep, `CLAUDE_ALLOW_CODE_GREP`, пороги sleep | `hooks/bash-tool-discipline.js` (печатает в отказе) |
| ARTEMIS как дефолт, запасной `mobile` | `hooks/artemis-default-guard.js`, скилл `mcp-mobile-test` |
| Поля записи `improvements/` | `improvements/README.md`, скилл `harness-contributing` |
| `runtime`-срабатывания не поднимают L2 | `skills/task-gate/SKILL.md` (п. 2.9) |

Что осталось в CLAUDE.md в сокращённом виде: роль главного и три условия «пишет сам», правила брифа субагента, цена инструмента, git и анти-утечка, Prompt Contract с прежней нумерацией шагов, worktree, деньги и креды, Iron Law и 3 fail-loop'а, Definition of Done, признаки документирования.

Сохранены все якоря, на которые ссылаются агенты, скиллы, оверлеи и `review-rules/process-gate.yaml` — заголовки и жирные фразы вида «Цена вызова инструмента», «Тесты», «Багфикс», «Git-коммиты». Нумерация шагов Prompt Contract не менялась: на «шаг 3» ссылаются `agents/knowledge-scout.md` и `agents/best-practices-scout.md`.

## Почему именно так

- Граница по механизму, а не по длине. Ревью диффа нашло два правила без носителя (исключение для merge-коммита базы, на которое ссылается `mr-merge.md`, и граница «проектные правила → `docs/decisions/` проекта») — оба возвращены в файл. Правило, которое срабатывает вне скилла, не выносится, даже если оно длинное.
- Цель разбора была 10-12 тыс. символов. Ниже 16,8 тыс. резать не стал: оставшееся — инварианты на каждую сессию и закрытые списки (перечень расширений прод-кода, список запрещённых «четвёртых попыток»).
- Описания агентов сокращались только за счёт английских дублей русских триггеров и формата вывода, который есть в теле агента. Скилл `subagent-authoring` запрещает сокращать триггеры и границы `DO NOT use for:`, поэтому выигрыш скромнее, чем по CLAUDE.md.

## Связанные файлы

- `CLAUDE.md`
- `hooks/claude-md-size-guard.py`, `hooks/claude-md-size-guard.tests.py`
- `skills/instruction-routing/SKILL.md`
- `agents/marketing-expert.md`, `agents/product-expert.md`, `agents/google-play-console-expert.md`, `agents/best-practices-scout.md`
- `improvements/2026-10-20-claude-md-diet.md`
