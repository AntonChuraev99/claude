---
date: 2026-10-22
slug: ast-index-worktree
status: applied
goal: ast-index в worktree отвечает из индекса основного checkout'а, а не «Index not found»
metric: доля вызовов ast-index в worktree-сессиях с ответом «Index not found» или текстовым fallback
baseline_date: 2026-10-22
target_date: 2026-11-05
---

# ast-index в worktree — индекс основного checkout'а

## Цель

Задача с правками идёт в worktree (`CLAUDE.md` → «Защищённая ветка и worktree»), а ast-index там не работает. Пользователь заметил это на Android-проекте: в worktree по индексу не искалось.

Причина. ast-index держит индекс вне репозитория, в `<cache>/<djb2 пути корня>/index.db`. У worktree `.claude/worktrees/<slug>` другой путь — значит, пустой каталог кэша. Индекс там никто не строит:

- SessionStart-хук плагина при отсутствии индекса только печатает подсказку, а на `EnterWorktree` посреди сессии не срабатывает вовсе;
- post-edit-хук плагина пропускает проект без индекса;
- `CLAUDE.md` и `hooks/bash-tool-discipline.js` запрещают агенту `rebuild`/`update`;
- `.worktreeinclude` не помогает: индекс лежит вне репозитория.

## Baseline (до изменений, на дату 2026-10-22)

Замер на `<your-project>` (ast-index 3.56.0): у основного checkout'а в индексе 2901 файл и 38 796 символов (источник: `ast-index stats`); у трёх его worktree индекса нет. Из worktree `stats` и `class` отвечают «Index not found», `usages` уходит в текстовый поиск: 54 совпадения вместо 12 точных, с комментариями и строками (источник: `ast-index usages` из worktree и из основного checkout'а, 2026-10-22).

Сколько вызовов ast-index в worktree-сессиях упало так за прошлые недели — не считали. Replay считает по транскриптам: tool_result с «Index not found» при `cwd` внутри `.claude/worktrees/`.

## Гипотеза

Полный `rebuild` на каждый worktree не нужен: ветка стартует копией транка, и индекс повторил бы индекс основного checkout'а. Достаточно направить ast-index в существующий индекс.

Проверены два способа:

- `--walk-up` находит индекс родителя, но корнем проекта становится основной checkout, и ast-index сужает выдачу `usages`/`class` до подкаталога вызова, то есть до `.claude/worktrees/<slug>`. Результат — 0 совпадений. Не годится;
- `AST_INDEX_DB_PATH=<индекс основного checkout'а>` оставляет корнем worktree. `usages` даёт те же 12 результатов, что из основного checkout'а; пути относительные и открываются в worktree. После серии чтений база не изменилась: 2901 файл, ноль строк из worktree, то же поколение индекса (источник: `ast-index query` по `files` и `metadata`).

Известный пробел: символов, которые ветка добавила или переименовала, в индексе основного checkout'а нет. Их агент ищет тулом `Grep`. Если основной checkout стоит на другой ветке, индекс отражает её код.

## Изменения

- `hooks/ast-index-worktree.js` — новый модуль префильтра. В worktree поисковый вызов ast-index получает `AST_INDEX_DB_PATH`: в bash префиксом каждого вызова, в PowerShell одной строкой `$env:…;` в начале команды. Не трогает: основной checkout, worktree со своим непустым индексом, основной checkout без индекса, команды с явной переменной или флагом, вызовы, которые управляют индексом или пишут в него (`rebuild`, `update`, `clear`, `watch`, `restore`, `subtree`, `graph build`, `--refresh`, `--collect`; в PowerShell — всю команду, где такое слово стоит в любом месте: переменная живёт до конца вызова, и `update` переписал бы индекс основного checkout'а), упоминания в тексте, кавычку в пути к индексу.
- `hooks/credentials-guard-prefilter.js` — подключает модуль. Подстановка индекса идёт первой, выравнивание аккаунта — в её результат, оба едут одним `updatedInput`.
- `hooks/bash-tool-discipline.js` — `hasAstIndex` проходит границу worktree (`.git`-файл), поэтому отказ `Grep` по символу в worktree снова ведёт в ast-index. Новый экспорт `astIndexDb`.
- `hooks/account-align.js` — экспорт `commandPositionRe`.
- `CLAUDE.md` → «Цена вызова инструмента» — одно предложение: в worktree индекс основного checkout'а, символы ветки — через `Grep`.
- Тесты: `hooks/ast-index-worktree.tests.js` (30 кейсов, включая сквозной прогон префильтра; источник: `node hooks/ast-index-worktree.tests.js`), кейс worktree в `hooks/bash-tool-discipline.tests.js`.

## Target

После 2026-11-05: в worktree-сессиях нет вызовов ast-index с ответом «Index not found», если у основного checkout'а индекс есть. Число вызовов ast-index в worktree-сессиях не ниже, чем в сессиях основного checkout'а.

## Replay (заполняется через N дней)

<!-- pending -->
