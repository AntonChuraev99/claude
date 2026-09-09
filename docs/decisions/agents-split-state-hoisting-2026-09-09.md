---
title: "Compose-фича разрезана на три агента по state hoisting"
summary: "Вместо одного compose-feature-expert три специалиста: feature-expert (поведение и ViewModel), compose-expert (вёрстка), core-expert (фундамент). Граница — state hoisting (Route → Screen(uiState, onAction) → Content). Контракт между ними — UiState + actions, матрица состояний × событий обязательна в REVIEW."
date: 2026-09-09
type: decision
modules: [agents, rules, memory]
keywords: [feature-expert, compose-expert, core-expert, state-hoisting, compose-multiplatform, delegation-chain, FEATURE_SPEC, agent-architecture]
project: claude-code-harness
---

# Compose-фича разрезана на три агента по state hoisting

> Объём: 889 слов — архитектурное решение о разрезе всех будущих фич и процессе багфиксов; без полного обоснования трёх отвергнутых альтернатив риск re-merge неправильного направления.

**Суть:** Один агент `compose-feature-expert` (90 строк тела, 129 файлов памяти) разрезан на трёх специалистов:
- `@feature-expert` — поведение фичи, матрица состояний × событий (`FEATURE_SPEC`), ViewModel, `UiState`, actions, навигация, repo
- `@compose-expert` — пиксели, stateless Screen / Content, layout, motion, вёрстка, скриншот-цикл
- `@core-expert` — фундамент, data / domain / network, общие Repository / UseCase, чистый Kotlin, корутины, Flow (поглотил `kotlin-expert`)

Граница между ними — state hoisting, уже стоящая в проектных конвенциях: `Route` → `Screen(uiState, onAction)` → `Content`.

## Проблема

Один `compose-feature-expert` держал весь вертикальный срез от ViewModel до пикселей. Две критические дыры:

1. **Никто не отвечал за полноту поведения.** `@design-expert` описывает, как выглядит; `@product-expert` — зачем; `compose-feature-expert` писал код; но вопрос «обработаны ли все переходы, есть ли выход из каждого состояния, что пережило поворот» никто структурно не проверял. Матрица состояний × событий нигде не была записана.
2. **Вёрстка и state жили в одном контексте.** Один агент держал и ViewModel, и Screen, и Content — запрос «сделай красиво» тянул за собой перечитывание ViewModel, а границы ответственности внутри одного промпта размывались.
3. **`kotlin-expert` дублировал будущего core-expert'а.** Чистая Kotlin-логика (корутины, Flow, обработка ошибок) не была специфична для одной фичи, но дополнительный агент за не-UI Kotlin означал недетерминированный роутинг: есть `feature-expert`, есть `kotlin-expert`, есть `core-expert` — кого выбрать для корутины в repository?

## Решение

Три агента разрезаны по границе, которая уже стоит в кодовых конвенциях:

| Агент | Владеет | Контракт |
|---|---|---|
| `@feature-expert` | `FEATURE_SPEC` (матрица состояний × событий), Route, ViewModel, `UiState`, actions, навигация, Repository/UseCase фичи, аналитика | выдаёт `UiState` + actions + спеку → `@compose-expert` |
| `@compose-expert` | Composable-код, Screen / Content, layout, modifiers, дизайн-система, motion, реcomposition, скриншот-цикл | получает контракт, возвращает `NEEDS_DELEGATION` если состояния не хватило |
| `@core-expert` | core/* (data / domain / network / storage), общие Repository / UseCase, Kotlin-идиоматика, корутины, Flow, обработка ошибок | выдаёт список фич-потребителей если меняется публичный API |

**Контракт между агентами** — `UiState` (sealed) + actions + `FEATURE_SPEC` — письменное соглашение, по которому `@compose-expert` верстает, не читая ViewModel, а `@feature-expert` подключает готовый Screen, не трогая вёрстку. Хопы между ними остаются, но каждый получает ровно свой вход.

**Обязательный режим `REVIEW`** у `@feature-expert` — свежим контекстом проверить, что каждое состояние из матрицы достижимо, у каждого есть выход, взаимодействия продуманы, дизайн-система соблюдена. Дополняет общий diff-review гейта, не заменяет его: тот смотрит корректность кода всех трёх агентов, REVIEW — полноту поведения по матрице.

**Правило схлопывания хопов для правок:** багфикс и точечная правка в существующем экране идут **одному** агенту по симптому:
- состояние неверное, экран не обновляется → `@feature-expert`
- обрезано, неверный отступ, мигает → `@compose-expert`
- данные неверные из кеша, гонка в корутине → `@core-expert`

Без этого правила split дороже прежнего на каждом багфиксе; с ним окупается.

## Почему именно так

- **State hoisting — не новое изобретение.** Это основная конвенция Compose: данные текут вверх, события вниз. Граница между agent'ами совпадает с этой конвенцией, значит не требует переучивания или выдумки новых соглашений.
- **Матрица состояний × событий** — единственный честный способ доказать полноту поведения. Её SPEC-режим пишет до кода, REVIEW-режим проверяет, что код соблюдает матрицу. Когда матрица становится явной, дыры видны сразу (ячейка без ответа = bug); когда она в head, bugs проявляются в production.
- **REVIEW в свежем контексте** — общая рекомендация Anthropic (code.claude.com/docs/en/best-practices): writer и reviewer в отдельных вызовах, чтобы не слепнуть от знания собственных предположений. Порог выбран по документации: репортировать только то, что задевает **корректность или заявленные требования**.
- **core-expert поглотил kotlin-expert** — двухсторонний роутинг (core-expert ↔ kmp-expert) проще и детерминированнее, чем трёхсторонний (feature/kotlin/core).

## Альтернативы (отвергнуты)

**1. `feature-expert` только планирует и ревьюит, весь код (ViewModel + UI) пишет `compose-expert`**

Проблема: `compose-expert` получает две оси ответственности — state и пиксели — то есть ровно то смешение, ради устранения которого затевался split; Anthropic советует агента на одну ось. Плюс ViewModel-логика снова живёт в одном контексте с вёрсткой. **Отвергнуто.** Код feature-слоя остаётся у `feature-expert`.

**2. `kotlin-expert` остаётся четвёртым агентом**

Проблема: три агента на слой чистого Kotlin (core-expert, kotlin-expert, плюс может быть routed в kmp-expert на жёсткие source-set вопросы). Корутина в repository — кого выбрать? Недетерминизм роутинга и снижение autonomy каждого agent'а. **Отвергнуто.** core-expert один и он достаточен.

**3. Буквальный split без правила схлопывания (каждый багфикс может идти в любого из трёх)**

Проблема: багфикс в существующем экране пойдёт по той же цепочке, что и новый экран, — несколько холодных контекстов там, где раньше хватало одного агента; правок в существующих экранах больше, чем новых экранов, поэтому split стал бы дороже прежнего состояния. **Отвергнуто.** Правило схлопывания обязательно.

## Последствия

**Цена:** +1-2 холодных контекста на **новый** экран (`SPEC → design → compose → IMPLEMENT → REVIEW` против прежних `design → compose-feature → diff-review`). Окупается правилом схлопывания на багфиксах и правках в существующих экранах (остаётся один агент).

**Память:** 129 файлов `agent-memory/compose-feature-expert/` разрезаны по секциям индекса (перенесены, не переписаны); 13 файлов сборки / тестов / мутаций скопированы всем троим; `agent-memory/kotlin-expert/` целиком перенесена в `core-expert/`.

**Метрика `delegation-rule-erosion`** при replay считается по 9 специалистам (`feature-expert`, `compose-expert`, `core-expert` вместо `compose-feature-expert`, `kotlin-expert`). Целевой уровень: ≤1 отскок `STATUS: NEEDS_DELEGATION` на 10 вызовов тройки.

**Порядок** для новой фичи: `@feature-expert` `Mode: SPEC` → `@design-expert` → `@compose-expert` → `@feature-expert` `Mode: IMPLEMENT` → `@feature-expert` `Mode: REVIEW`. Маленький экран (1-2 состояния, без нового repo) — SPEC + IMPLEMENT одним вызовом `@feature-expert`, порядок design → compose не меняется.

## Граница по state hoisting и спорные точки

Таблица `rules/compose-feature-chain.md` разрешает спорные границы:
- UI-локальное состояние (`remember`, sheet visible, scroll, expanded) — `@compose-expert`; всё, что переживает экран или зависит от данных, — в `UiState` у `@feature-expert`
- Repository **одной** фичи — `@feature-expert`; нужна вторая фича — переезжает в core
- Компонент design-system-модуля — `@compose-expert` (вёрстка); логика внутри него — `@core-expert` (форматтер, вычисление)

## Связанные файлы

- **Таблица агентов и цепочки:** `rules/compose-feature-chain.md`
- **Новые агенты:** `agents/feature-expert.md` (68 строк тела), `agents/compose-expert.md` (77), `agents/core-expert.md` (72)
- **Исходная гипотеза и базовые цифры:** `improvements/2026-09-09-split-compose-feature-expert.md`
- **Официальные источники:** code.claude.com/docs/en/sub-agents, anthropic.com/engineering/building-effective-agents, code.claude.com/docs/en/best-practices
