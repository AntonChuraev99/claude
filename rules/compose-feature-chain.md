---
paths:
  - "**/*.kt"
---

# Compose-фича: цепочка агентов и контракт между ними

Три агента на одну фичу в commonMain — разрез по state hoisting, который уже стоит в конвенциях (`Route` → `Screen(uiState, onAction)` → `Content`):

| Агент | Владеет | Контракт наружу |
|---|---|---|
| `@feature-expert` | поведение: `FEATURE_SPEC` (матрица состояний × событий), Route, ViewModel, `UiState`, actions, навигация, repo / use case фичи, аналитика | `UiState` + actions + `FEATURE_SPEC` → `@compose-expert` |
| `@compose-expert` | пиксели: stateless Screen / Content / компоненты, дизайн-система, layout, motion, perf, скриншот-цикл, UI-локальное состояние | «не хватило состояния или действия» → `@feature-expert` |
| `@core-expert` | фундамент: core/* (data / domain / network / storage), общие repo и use case, корутины, Flow, ошибки, идиоматика | изменение публичного API core → список фич-потребителей |

## Новый экран или фича — полная цепочка

`@feature-expert` `Mode: SPEC` (матрица + файлы `UiState`/actions) → `@design-expert` (`DESIGN_SPEC` под все состояния матрицы) → `@compose-expert` (Screen / Content по контракту, превью на каждое состояние, PNG) → `@feature-expert` `Mode: IMPLEMENT` (ViewModel, Route, навигация, repo) → `@feature-expert` `Mode: REVIEW` свежим контекстом. REVIEW — доменная проверка **поведения** по матрице; общий diff-review гейта (`/task-gate` 2.3b, корректность кода всех трёх агентов) остаётся и идёт перед мержем как обычно — REVIEW его не отменяет. Нужен core-слой (новый DataSource, общий repo) — `@core-expert` до `IMPLEMENT`, параллельно с `@compose-expert`: файловые зоны не пересекаются.

Маленький экран (одно-два состояния, без нового repo) — `SPEC` и `IMPLEMENT` одним вызовом `@feature-expert`: он сам напишет матрицу, контракт и минимальный компилируемый Screen (`UI_SKELETON`), `@compose-expert` доведёт вёрстку. Порядок design → compose при этом не меняется.

## Правка в существующем экране — один агент по симптому

Хопы не складываются: багфикс и точечная правка идут **одному** агенту, слой выбирается по корню симптома, а не по файлу — Screen и ViewModel могут лежать рядом:

- состояние неверное, экран не обновляется из VM, переход потерян, «кнопка ничего не делает», не пережило поворот, Repository или Flow **самой фичи** не эмитит → `@feature-expert`
- обрезано, съехало, перекрыто system bars, мигает, дёргается, цвет не из темы, ломается на размере или fontScale → `@compose-expert`
- данные неверные из **core**-repo или кеша, Flow в core/* завис, гонка в корутине вне фичи, ошибка проглочена в data-слое core/* → `@core-expert` (repo одной фичи — строкой выше, к `@feature-expert`)

Корень не виден по симптому — `systematic-debugging` у того, чей слой ближе, и `NEEDS_DELEGATION` при промахе, а не два агента «на всякий случай».

## Границы, которые чаще всего путают

- UI-локальное состояние (`remember`, `rememberSaveable`, sheet visible, scroll, expanded) — `@compose-expert`. Всё, что переживает экран или зависит от данных, — в `UiState` у `@feature-expert`.
- Repository / UseCase **одной** фичи — `@feature-expert`; тот же класс понадобился второй фиче — переезжает в core и в зону `@core-expert`.
- Компонент design-system-модуля — `@compose-expert` (вёрстка); логика внутри него (форматтер, вычисление) — `@core-expert`.
- Соблюдение дизайн-системы обеспечивает `@compose-expert` при письме; `@feature-expert` сверяет его только в `REVIEW`.
