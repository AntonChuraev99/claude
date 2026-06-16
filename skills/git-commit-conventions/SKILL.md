---
name: git-commit-conventions
description: Правила оформления git-коммитов по Conventional Commits. Используй при создании коммитов — типы, формат, примеры, breaking changes.
---

# Git Commit Conventions

Формат: [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)

```
<type>(<scope>): <description>
```

## Типы

| Тип | Описание |
|-----|----------|
| `feat` | Новая функциональность |
| `fix` | Исправление бага |
| `refactor` | Рефакторинг (без новой функциональности и фиксов) |
| `perf` | Улучшение производительности |
| `docs` | Только документация |
| `style` | Форматирование, стиль кода |
| `test` | Добавление/обновление тестов |
| `chore` | Обслуживание, зависимости, тулинг |
| `build` | Изменения системы сборки |
| `ci` | Конфигурация CI/CD |

## Правила

- **Без `Co-Authored-By`** — никогда не добавлять attribution trailers
- **Описание до 50 символов**
- **Без точки** в конце описания
- **Imperative mood** — "add", "fix", "update" (НЕ "added", "fixed")
- **Lowercase** — тип и scope в нижнем регистре
- **Scope опционален** — использовать когда добавляет ясность

## Примеры

```
feat(auth): add two-factor authentication
fix(api): resolve null pointer in user service
refactor(catalog): extract video player component
perf(db): optimize query for large datasets
docs(readme): update installation instructions
```

## Breaking changes

`!` после типа/scope:

```
feat(api)!: change authentication endpoint
```

## Тело коммита

Добавляй когда изменение затрагивает 3+ файлов или нужно объяснить мотивацию. Пустая строка между заголовком и телом обязательна. Строки до 72 символов:

```
feat(catalog): add infinite scroll pagination

Load next page when user reaches 80% of list.
Replaces manual "Load more" button.
```

## Footer токены

Добавляются после тела через пустую строку:

```
feat(api)!: change auth endpoint response format

BREAKING CHANGE: `jwt` field renamed to `accessToken`, update all clients
Fixes #248
```

- `BREAKING CHANGE:` — описание что сломалось и как мигрировать (подробнее чем `!`)
- `Fixes #123` / `Closes #123` — закрывает issue
- `Co-authored-by:` — **запрещён** в этом проекте

## Revert

```
revert: feat(catalog): add infinite scroll pagination

Refs: abc1234
```

- Тип всегда `revert:`
- Заголовок = заголовок откатываемого коммита
- `Refs:` — хэш откатываемого коммита
