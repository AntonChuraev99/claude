---
date: 2026-09-09
slug: split-compose-feature-expert
status: applied
goal: разрезать compose-feature-expert на feature / compose / core-expert по state hoisting, core-expert поглощает kotlin-expert
metric: доля вызовов трёх новых агентов без NEEDS_DELEGATION-отскока между ними; агентов на багфикс в существующем экране (target 1); хопов на новый экран
baseline_date: 2026-09-09
target_date: 2026-09-23
---

# Split: compose-feature-expert → feature-expert + compose-expert + core-expert

## Цель

Один агент `compose-feature-expert` держал весь вертикальный срез фичи — от матрицы состояний до пикселей. Две дыры: (1) никто не отвечал за **полноту поведения** — `@design-expert` описывает, как выглядит, `@product-expert` — зачем, а «обработаны ли все переходы, есть ли выход из каждого состояния» не проверял никто; (2) вёрстка и state жили в одном контексте, и «сделай красиво» тянуло за собой перечитывание ViewModel. Плюс `kotlin-expert` дублировал бы будущего `core-expert` по не-UI Kotlin — три агента на один слой дали бы недетерминированный роутинг.

Запрос пользователя: «feature-expert отвечает за фичи, видимые пользователю, продумывает фичу, проверяет соблюдение UI проекта и UX-путь, чтобы были продуманы все взаимодействия; core — за core-модули, невидимое; compose — за вёрстку, как правильно написать Compose-код, чтобы UI выглядел красиво».

## Baseline (до изменений, на дату 2026-09-09)

- Агентов 17; `compose-feature-expert` — 90 строк, `kotlin-expert` — 77. Сумма `description` всех агентов — 24 791 символ (замер 2026-09-01).
- Память: `agent-memory/compose-feature-expert/` — 129 файлов, индекс 151 строка, уже секционирован (фича / Compose UI / state / навигация / тулинг / данные / аналитика); `kotlin-expert` — 15 файлов.
- Хопов на новый экран: `@design-expert` → `@compose-feature-expert` → diff-review = 3 холодных контекста. Багфикс в экране — 1 агент.
- Метрика роутинга между агентами одного слоя — нечем измерить: отскоки `NEEDS_DELEGATION` в transcript'ах не считались. Лечится подсчётом строк `STATUS: NEEDS_DELEGATION` в результатах `Agent` за период replay.
- Официальных практик Anthropic (code.claude.com/docs/en/sub-agents, best-practices, «Building effective agents»), на которые опёрся разрез: агент = одна ось ответственности; `description` — routing-триггер; writer / reviewer в свежем контексте с порогом «only gaps that affect correctness or the stated requirements»; предупреждение «multiple phases sharing significant context → main conversation, not subagents» — отсюда правило схлопывания хопов.

## Гипотеза

1. Разрез по state hoisting (`Route` → `Screen(uiState, onAction)` → `Content`) уже стоит в конвенциях проекта, поэтому граница feature / compose естественная, а контракт между агентами — `UiState` + actions — уже существовал как «контракт для @test-expert».
2. `feature-expert` с обязательной матрицей состояний × событий (`FEATURE_SPEC`) и режимом `REVIEW` в свежем контексте закрывает дыру полноты поведения. REVIEW — доменная проверка по матрице и **отдельный** хоп: общий diff-review гейта остаётся (ревью 2.3b этой задачи: правило в `rules/` не может отменить инвариант `CLAUDE.md`, а REVIEW не смотрит корректность кода `@core-expert`).
3. `core-expert` = `kotlin-expert` + владение `core/*`: 17 → 18 агентов вместо 19, роутинг не-UI Kotlin остаётся двухсторонним (core-expert ↔ kmp-expert), а не трёхсторонним.
4. Цена — +1-2 холодных хопа на **новый** экран — окупается только при правиле «правка в существующем экране идёт одному агенту по симптому»; без него split дороже прежнего на каждом багфиксе. Правило вынесено в `rules/compose-feature-chain.md` (`paths: **/*.kt`) с указателем из `CLAUDE.md`.

## Изменения

- `agents/feature-expert.md` (новый, 68 строк / 8 413 символов тела): `Mode: SPEC | IMPLEMENT | REVIEW`, матрица состояний × событий, `UI_SKELETON`, порог REVIEW по Anthropic.
- `agents/compose-expert.md` (новый, 77 / 8 951): stateless Screen / Content по контракту, таблицы скиллов вёрстки, скриншот-цикл, запрет менять контракт без `NEEDS_DELEGATION @feature-expert`.
- `agents/core-expert.md` (новый, 72 / 8 366): тело `kotlin-expert` + владение `core/*`, инвариант «core не импортирует feature/*», обязательный `usages` по всем фичам при смене публичного API.
- Удалены `agents/compose-feature-expert.md`, `agents/kotlin-expert.md`.
- `rules/compose-feature-chain.md` (новый): таблица зон, полная цепочка для нового экрана, схлопывание хопов, спорные границы.
- `CLAUDE.md`: § «Дизайн-фаза» — указатель на цепочку и правило «одному агенту по симптому» (без роста числа строк); § «Вёрстка» — исполнитель скриншот-цикла `@compose-expert`.
- Взаимные `DO NOT use for:` и тела 12 агентов: android-platform, best-practices-scout, design, google-play-console, jira, kmp, marketing, nextjs, product, react-ui, test, wasmjs — каждый адрес разведён по смыслу (вёрстка → compose, ViewModel/state → feature, core/чистый Kotlin → core).
- `skills/task-gate/SKILL.md` (sanity-строки трёх агентов), `skills/screenshot-driven-ui/SKILL.md`, `README.md`, `doc-writer-update-reminder.ps1` (список специалистов), `review-rules/insets-spacing.yaml` (путь к памяти).
- `skills/subagent-authoring/SKILL.md`: сверка с официальной докой 2026-09-09 — `effort` принимает `xhigh | max`; `memory` — дока советует `project`, для `~/.claude/agents/` верен `user`; пример имени. Официального скилла или визарда для авторинга субагентов нет: `/agents` с 2.1.198 печатает подсказку, оф. путь — «попроси Claude или правь файл».
- Память (gitignored, не в MR): `agent-memory/compose-feature-expert/` разрезана скриптом по секциям индекса — строки индекса **перенесены, не переписаны** (прецедент 2026-09-01); 13 файлов сборки/тестов/мутаций скопированы всем троим; `kotlin-expert/` целиком → `core-expert/`; для `compose-expert` из конвенций выделен `conventions_compose_ui.md`. Бэкап старых каталогов — в scratchpad сессии.

## Target

К 2026-09-23 по transcript'ам:
- ни одного вызова `Agent` с `subagent_type` ∈ {`compose-feature-expert`, `kotlin-expert`} — мёртвые имена означают, что где-то остался старый адрес;
- отскоков `STATUS: NEEDS_DELEGATION` между `feature-expert` / `compose-expert` / `core-expert` — ≤1 на 10 вызовов тройки (роутинг детерминирован);
- багфикс в существующем экране — ровно 1 агент из тройки на задачу (правило схлопывания работает);
- у каждой новой фичи в результате `feature-expert` есть `FEATURE_SPEC` с матрицей и хотя бы одна ячейка «невозможно, потому что» (матрица заполняется, а не декорируется);
- метрика `delegation-rule-erosion` (список из 8 код-специалистов) при replay считается по 9: `feature-expert`, `compose-expert`, `core-expert` вместо `compose-feature-expert`, `kotlin-expert`.

## Replay (заполняется через N дней)

_pending_
