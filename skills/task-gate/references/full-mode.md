# Только режим `full`

Читать, когда `gate-prep.py` вернул `mode.value: "full"` (критерий — `SKILL.md` 1.1). В `lite` эти пункты печатаются строкой `⏸ lite` и на следующий прогон не переносятся. Бухгалтерия вынесена сюда, потому что в `lite` она не нужна, а в SKILL.md она занимала место, которое после compaction должно достаться Step 6.

## 2.0 / 2.3b — второй ревьюер

Два агента вместо одного — только если `review.over_30_files` **или** дифф трогает деньги, безопасность, деплой. Правило и обоснование — `diff-review-axes.md` → «Две оси, один агент по умолчанию»; модель и effort — `diff-review-flow.md` → «Фан-аут (2.0)». Дифф без кода — всегда один агент.

## 2.4 — Active hygiene `[once]`

Раз за сессию, на первом `full`-прогоне (`state.once_done.activeHygiene` не `true`). Скан `docs/active/`:

- `**Статус:** Done` в шапке, а файл всё ещё в `docs/active/` → `mv docs/active/<f> docs/archive/<f>`;
- `In Progress` в шапке, но заполнены `## Выводы` и задача закрыта → шапку на `**Статус:** Done` и в `docs/archive/`.

В `docs/active/` остаются только `In Progress` / `Partially Done` / `Deferred` / `Planned` — иначе SessionStart-дайджест показывает ложный фронт работ. Сделано → `--once activeHygiene` в `gate-log.py`.

## 2.6 — Строка статистики задачи

В **конец** таблицы `## Session Log (с 2026-09-15)` файла `~/.claude/stats/doc-writer.md` (имя историческое):

```
| <дата> | <project> | <task — 1-2 строки факта: что сделали, корень, что осталось> | <Шагов: N> | <files> |
```

`Шагов: N` — по [`calibration.md`](calibration.md), шаги этой задачи от `BASE_SHA`; `files` — `task.files_excl_docs` из `gate-prep.py`. Несколько задач за сессию — несколько строк. Обновить `_Last updated:_`. Таблица ломается — `edge-cases.md` § 7.

## 2.9 — `[once]` rollup и hook setup

Раз за сессию, на первом `full`-прогоне:

- **Rollup** — `python ~/.claude/review-rules/stats.py`: читает `events.jsonl` и git-корреляцию, обновляет `~/.claude/stats/review-rules.md` (Counters / Per-rule / Выводы). → `--once rollup`.
- **Hook setup** — `python ~/.claude/review-rules/run.py --check-hook`. `NOT installed` → `⚠️ pre-commit not set` + строка `--ensure-hook`; `foreign` (чужой pre-commit) → `⚠️` + строка для ручной вставки, чужой hook не перезаписывать. SessionStart ставит pre-commit сам, поэтому в `lite` проверки нет. → `--once hookSetup`.

## Step 3 — сигналы по специалистам

Поверхностная проверка результатов специалистов **этой задачи**, 2-3 сигнала, не код-ревью. Метод: `Grep` (`import android.` в `commonMain`), `Glob` для файлов, первые 30 строк. Флаг → `⚠️`, не блокер. Блок `🤖 Sub-agent sanity:` со строками `<agent> <status>`.

- **`@feature-expert`** — `FEATURE_SPEC` с матрицей состояний; ViewModel/UiState/Navigation созданы, без TODO; `UI_SKELETON` закрыт `@compose-expert`; в `REVIEW` — `REVIEW_VERDICT` и находки с `file:line`.
- **`@compose-expert`** — Screen/Content stateless (данные и колбэки, не ViewModel); токены Material 3 (нет `Color(0xFF...)` вне brand-critical), обёртки дизайн-системы; PNG прочитаны и названы в отчёте.
- **`@android-platform-expert`** — androidMain: Hilt / Room driver / Media3 / Resources, без утечки в `commonMain`; installDebug smoke на новых DI-биндингах через интерфейс; KMP: `commonMain` без Android-импортов, `expect`/`actual` спарены, без заглушек Route/Screen.
- **`@react-ui-expert`** — компонент создан, type-check, Tailwind вместо inline.
- **`@nextjs-expert`** — API route: корректный тип и авторизация.
- **`@design-expert`** — отдал `DESIGN_SPEC` (описание, не прод-код); платформа и метод проставлены.
- **`@core-expert`** — Flow / runCatching / Duration, нет блокирующих вызовов в корутинах; core не импортирует из `feature/*`.
- **`@wasmjs-expert`** — `init.js` / `index.html` / wasmJs-стабы синхронны, нет `js("...")` в `commonMain`.

## 5.2 — строка `⏱`

`gate-log.py` возвращает поле `timings` (`⏱ Timings: gate 6м12с · review 5м04с · L1 3с`) — в `full` вставить его после вердикта. Числа — замер, а не оценка: `gate` — от запуска `gate-prep.py` до `gate-log.py`, `l1` — прогон `run.py` внутри `gate-prep.py`, `review` — из `--review-sec` (длительность самого долгого ревьюера из его результата), без флага — `—`. Скрипт пишет эти поля в лог в обоих режимах: снимать их больше нечем, кроме этих двух вызовов, поэтому отдельных `date +%s` нет.
