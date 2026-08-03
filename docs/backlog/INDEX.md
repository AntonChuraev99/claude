# Backlog — `~/.claude`

Отложенное по своей воле: полировка, техдолг, идеи по глобальным правилам и агентам. Внешней блокировки нет — запись берут руками, когда решили заняться.

Заблокированное внешним событием с проверяемым триггером сюда не кладём — для этого `docs/todos/` (правила — `~/.claude/rules/docs-structure.md`).

## Open

| дата | запись | область | суть |
|---|---|---|---|
| 2026-08-03 | [review-rules-noise-reduction](review-rules-noise-reduction.md) | review-rules | 98 runtime-правил дают тысячи срабатываний при est-FP 88-100%; прополоть, сменить триггер L2 с «L1 непуст», добавить автогигиену в stats.py |

## Done

| дата | запись | итог |
|---|---|---|
| 2026-08-03 | [subagent-docs-ship-with-mr](subagent-docs-ship-with-mr.md) | вариант B: `DOCS_WRITTEN:` от `@doc-writer` + проверка 2.7b в `/task-gate`; hard scope субагентов не тронут |
