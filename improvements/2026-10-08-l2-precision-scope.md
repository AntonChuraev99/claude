---
date: 2026-10-08
slug: l2-precision-scope
status: applied
goal: вернуть точность L2 bug-pattern — судить только добавленные строки и сузить шумные правила
metric: точность L2 по static (confirmed / judged), объём runtime-срабатываний, доля static-триггеров L2 от одного правила
baseline_date: 2026-10-08
target_date: 2026-10-22
---

# L2 bug-pattern: скоуп добавленных строк и сужение 6 правил

## Цель
Replay записи [review-threshold](2026-08-31-review-threshold.md): точность L2 упала с 29% до 5.7%. Пользователь: «давай уточним правила, чтобы норм было».

## Baseline (2026-09-08 … 2026-10-08)
- 3 492 прогона L1, 7 прогонов L2: 6 confirmed / 100 dismissed (5.7%).
- 90 из 100 dismissed — runtime-хиты; 63 из них — два прогона, где бриф просил «оцени runtime».
- `run.py` применял `--changed-only` только к static: runtime бил по нетронутым строкам тронутых файлов (27 из 30 и 38 из 43 срабатываний в двух прогонах).
- 834 из 893 static-триггеров L2 дало одно правило `live-harness-outbound-bridge-guard-missing` на одном untracked-файле проекта.

## Гипотеза
Точность падала не из-за суждения L2, а из-за двух вещей: L2 судил runtime-хиты на легаси-строках, и одно шумное static-правило поднимало L2 почти на каждом прогоне.

## Изменения
- `review-rules/run.py` — `--changed-only` режет строки у всех правил (файловые `lacks`/`requires` читают файл целиком, как раньше).
- `agents/bug-pattern-reviewer.md` — вердикт только по хитам на добавленных строках, остальное строкой `pre-existing: N`; в телеметрии `judged.mode` и новое поле `own` (находки L2 без хита L1).
- `skills/task-gate/SKILL.md` §2.9 — бриф L2 не просит оценивать runtime-находки.
- `review-rules/stats.py` — `l2_precision`: точность отдельно по static / runtime / own.
- Сужены с `narrowed_since: '2026-10-08'`: `live-harness-outbound-bridge-guard-missing`, `padding-outside-scroll-clips-viewport` (только `horizontalScroll`), `raw-material-textfield-outside-designsystem`, `web-react-static-guard-asserts-source-not-bundle`, `toast-crashes-on-background-thread`, `wasmjs-nonemoji-symbol-glyph-tofu`.
- Новый `review-rules/run.tests.py` (22 теста): скоуп `--changed-only`, пары положительных и отрицательных контролей по сужённым правилам, парсинг YAML.
- Положительные контроли на исторических коммитах: `edge-to-edge-bar-tint` и подтверждённый хит `web-react-static-guard` остались.

## Target (2026-10-22)
- точность static ≥ 30%;
- объём runtime-срабатываний упал в 5–10 раз;
- confirmed не меньше 2 за 2 недели (правила не ослепли);
- доля static-триггеров L2 от `live-harness-outbound-bridge-guard-missing` < 10%.
- `textalign-center-without-fillwidth`: снова ≥ 200 срабатываний при 0 confirmed — удалить.

Anti-target: confirmed = 0 за 2 недели при живых задачах — сужение перекрутили, откатить правило, которое молчит на своём положительном контроле.

## Replay (заполняется 2026-10-22)
