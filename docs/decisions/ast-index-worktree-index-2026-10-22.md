---
title: "ast-index в worktree читает индекс основного checkout'а через AST_INDEX_DB_PATH"
summary: "В worktree у ast-index нет индекса; префильтр подставляет AST_INDEX_DB_PATH с индексом основного checkout'а. --walk-up не годится: выдача сужается до подкаталога."
date: 2026-10-22
type: decision
modules: [hooks, CLAUDE.md]
keywords: [ast-index, worktree, AST_INDEX_DB_PATH, walk-up, cache, credentials-guard-prefilter, updatedInput, PreToolUse]
project: claude-code-harness
---

# ast-index в worktree — индекс основного checkout'а

**Суть:** `hooks/ast-index-worktree.js` (модуль `credentials-guard-prefilter.js`) дописывает к поисковым вызовам ast-index внутри `.claude/worktrees/<slug>` переменную `AST_INDEX_DB_PATH` с путём к индексу основного checkout'а. `rebuild` в worktree не делается.

## Проблема / Контекст

ast-index хранит индекс в `<cache>/<djb2 пути корня>/index.db`, вне репозитория. У worktree другой путь, значит индекса нет: `class` и `stats` отвечают «Index not found», `usages` уходит в текстовый поиск. Хуки плагина индекс не строят, `CLAUDE.md` запрещает агенту `rebuild`/`update`.

## Решение

- bash: `AST_INDEX_DB_PATH='<db>' ast-index …` перед каждым поисковым вызовом;
- PowerShell: `$env:AST_INDEX_DB_PATH='<db>'; ` в начале команды; команда, где в любом месте стоит слово записи (`update`, `restore`, `subtree`, `graph build`, `--collect`…), не меняется целиком;
- вызовы, которые пишут в индекс, префикса не получают и в bash;
- не трогаются: основной checkout, worktree со своим непустым индексом, основной checkout без индекса, явная переменная или `--walk-up`, упоминания в тексте;
- `hasAstIndex` в `hooks/bash-tool-discipline.js` проходит границу worktree, поэтому отказ `Grep` по символу ведёт в ast-index и там.

Пробел: символов, созданных в ветке, в индексе нет — `CLAUDE.md` велит искать их `Grep`.

## Почему именно так

- `rebuild` повторил бы индекс транка: ветка стартует его копией.
- С `--walk-up` корнем становится основной checkout, и ast-index сужает выдачу до подкаталога вызова. `usages` из worktree: с `--walk-up` — 0, с `AST_INDEX_DB_PATH` — 12, как из основного checkout'а (источник: `ast-index usages` на `<your-project>`, 2026-10-22).
- Чтение базу не меняет: те же 2901 файл и `index_generation` 61 (источник: `ast-index query` по `metadata` и `files`).

## Связанные файлы

- `hooks/ast-index-worktree.js`, `hooks/ast-index-worktree.tests.js`
- `hooks/credentials-guard-prefilter.js`, `hooks/bash-tool-discipline.js`, `hooks/account-align.js`
- `improvements/2026-10-22-ast-index-worktree.md`
