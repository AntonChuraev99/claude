# Шаблоны документов задачи

Читать по условию из `SKILL.md`: INIT — «Документ задачи»; COMPLETE — «Постоянный документ», «Правила `keywords:`», «Строка INDEX». Заголовки секций — дословно, по-русски: по ним ищут агенты следующих задач.

## Документ задачи (`docs/active/<slug>-<YYYY-MM-DD>.md`)

```markdown
# <Название задачи>

**Статус:** In Progress
**Дата старта:** <YYYY-MM-DD>
**Start SHA:** <sha | none>
**Project:** <project-slug>
**Тип:** feature | bug-fix | refactor | architecture
**Затронутые модули:** <module1>, <module2>

## Цель (продуктовая)

## Технический план

## Лог итераций

## Выводы

## Предложения по улучшению агентов
```

Статус только в шапке: второй `**Статус:**` в теле собьёт SessionStart-дайджест. Документ уходит в `docs/archive/` только при `Done`; `Partially Done` / `Deferred` / `Planned` остаются в `active/`.

## Постоянный документ (`docs/solutions/` или `docs/decisions/`)

Куда: решение технической проблемы или workaround → `docs/solutions/<slug>-<YYYY-MM-DD>.md`; архитектурное или продуктовое решение → `docs/decisions/<slug>-<YYYY-MM-DD>.md`.

````markdown
---
title: "Краткое название решения"
summary: "Одно предложение: что было сломано или нужно и чем закрыто. ≤200 символов."
date: YYYY-MM-DD
type: bug-fix | feature | architecture | pattern | decision
modules: [module1, module2]
keywords: [keyword1, keyword2, keyword3, keyword4, keyword5]
project: <project-slug>
---

# [Название проблемы или решения]

**Суть:** 1-3 строки — ответ, а не подводка. Что делать тому, кто пришёл с той же
проблемой, и где это лежит. Контекст, история и обоснование — ниже.

## Проблема / Контекст
## Решение
## Почему именно так
## Примеры          ← опционально, потолки — ~/.claude/references/doc-length-budget.md
## Связанные файлы
````

YAML frontmatter обязателен: по нему специалисты грепают при старте задачи. `summary:` и блок `Суть` обязательны — по ним читающий агент решает, открывать ли файл; дублировать в них `title` нельзя: `title` называет тему, эти два поля дают решение. Порядок изложения — ответ, потом контекст.

### Секции для fix-after-deploy

Задача была фиксом после выкатки на production (rollback или follow-up commit; баг platform-specific и локально не воспроизводился; между первым «готово» и финальным фиксом был диагностический цикл через пользователя) — добавить обязательно:

```markdown
## История            — хронология: что было, что пошло не так на проде, как обнаружили
## Production Bug     — точный симптом у пользователей; версия / платформа / масштаб; как репортилось
## Root Cause         — почему первое решение не сработало, без оправданий
## Lessons Learned    — конкретные правила для следующего агента, не пожелания
```

## Правила `keywords:`

- Минимум 5, максимум 15.
- Включать: API, классы, функции (`StateFlow`, `graphicsLayer`), технологии (`wasmJs`, `Koin`, `Firebase`), паттерны (`bottomsheet`, `race-condition`), ошибки (`NoSuchMethodError`).
- Не включать общие слова (`code`, `bug`, `issue`, `feature`) — они не дают сигнала при поиске.
- **Domain umbrella term — минимум один в первых трёх**: `video|audio|image|gif` · `auth|login|signin|permission|gdpr|consent` · `crash|npe|oom|anr|memory-leak` · `payment|subscription|purchase|paywall|billing` · `navigation|deeplink|routing` · `theme|darkmode|dynamic-color|material3` · `analytics|telemetry|tracking` · `storage|database|cache|persistence` · `network|api|retry|offline` · `notification|push|messaging` · `migration|compat|upgrade` · `accessibility|a11y|rtl|localization|i18n` · `performance|startup|baseline-profile`.
- **Имя компонента или фичи — обязательно**, если работа шла над переиспользуемым компонентом: скаут ищет повторную работу по имени.
- **Оба платформенных тега для кросс-платформенной фичи** — `android` и `wasmjs`/`web`: версии одной фичи обязаны находить друг друга.

## Строка INDEX (`docs/solutions/INDEX.md`, наверх таблицы)

```
| <YYYY-MM-DD> | <category> | <kw1>, <kw2>, <kw3> | [<title>](<path-from-INDEX>) |
```

`category` — `bug-fix | feature | architecture | pattern | decision`; путь — от `docs/solutions/INDEX.md`, без `../`. Колонка keywords — 3–8 термов через запятую, ≤120 символов, дословно из `keywords:` frontmatter: это единственное, по чему индекс грепается, поэтому термы не сокращать; пересказ решения сюда не писать — для него есть `summary:` в файле. Файла нет → создать: заголовок `# Solutions INDEX` + таблица `| дата | категория | keywords | путь |`.
