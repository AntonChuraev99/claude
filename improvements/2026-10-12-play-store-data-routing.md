---
date: 2026-10-12
slug: play-store-data-routing
status: applied
goal: данные Play Console главный агент берёт через @google-play-console-expert и API, а не браузером
metric: вызовы браузера в разделы Play Console, данные которых отдаёт API (scripts/replay-play-console-browser.py)
baseline_date: 2026-10-12
target_date: 2026-10-26
---

# Данные стора — через API-агента, а не браузер

## Цель

Пользователь просит «данные из стора», а главный агент открывает Play Console через
`claude-in-chrome`. Агент `@google-play-console-expert` описывал только публикацию и vitals,
поэтому запрос «сколько установок / какая конверсия листинга» с ним не связывался. Даже когда
агента звали, он не умел выгружать установки, acquisition, рейтинг и отзывы — и главный шёл
в браузер после него.

## Baseline (до изменений, на дату 2026-10-12)

`python scripts/replay-play-console-browser.py 60`:

- 61 вызов браузера на `play.google.com/console` в 7 транскриптах (источник: команда выше);
- из них 11 вызовов — в разделы, данные которых отдаёт API: statistics, acquisition, подписки (источник: команда выше);
- 24 вызова `@google-play-console-expert` в 20 транскриптах (источник: команда выше);
- раздел с API браузер открыл раньше агента в 1 транскрипте (источник: команда выше); в остальных
  браузер шёл после агента — агент не умел отдать эти данные.

Разделы консоли, которые открывал браузер: `statistics`, `reporting/acquisition/overview`,
`store-performance/store-analysis`, `store-listings`, `financial-reports/subscriptions`,
`reporting/subscriptions/cancellation`, `policy-center`, разделы App content, `experiments`
(это сегменты URL Play Console, а не пути репозитория).
Первые четыре группы покрывает GCS-экспорт; policy center, app content, experiments и
store analysis в API отсутствуют.

## Гипотеза

1. Триггеры и карта «данные → источник» в description свяжут формулировки пользователя с агентом.
2. Скрипт `play_stats.py` закроет пробел возможностей: без него триггер привёл бы к агенту,
   который вернёт «не умею», и главный снова пойдёт в браузер.
3. Предупреждающий (не блокирующий — решение пользователя) хук на первый браузерный вызов
   консоли напомнит про API в момент выбора инструмента, когда текст description уже не в фокусе.

## Изменения

- `agents/google-play-console-expert.md` — description: пункт (0) «данные стора», триггеры
  RU/EN, граница с `@marketing-expert` (цифры выгружает этот агент, выводы делает тот);
  тело: скоуп, бриф, метод шаг 5 с таблицей «данные → источник», формат вывода, доказательство.
- `agents/google-play-console-expert/scripts/play_stats.py` — новый: GCS-отчёты installs,
  ratings, crashes, store_performance, subscriptions, reviews; reviews API; `--local-dir` для
  CSV, скачанных `gcloud storage cp`, когда service account получает 403 на бакете.
- `agents/google-play-console-expert/scripts/test_play_stats.py` — тесты логики разбора и агрегации.
- `agents/google-play-console-expert/README.md` — раздел «Данные стора», имена бакета.
- `hooks/play-console-browser-hint.js` + `hooks/play-console-browser-hint.tests.js` — PreToolUse на `claude-in-chrome` и
  `playwright`: `additionalContext` без `permissionDecision`, один раз на агента.
- `settings.example.json` — регистрация хука.
- `scripts/replay-play-console-browser.py` — замер для baseline и replay.

## Target

К 2026-10-26 (`python scripts/replay-play-console-browser.py 14`):

- браузерных вызовов в разделы с API — 0 (baseline 11);
- транскриптов, где раздел с API открыт браузером раньше агента, — 0 (baseline 1);
- остальные браузерные вызовы консоли — только разделы без API (policy center, app content,
  experiments, store analysis, ручная настройка листинга).

## Replay (заполняется через N дней)

<pending>
