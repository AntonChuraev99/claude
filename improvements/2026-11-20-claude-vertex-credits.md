---
date: 2026-11-20
slug: claude-vertex-credits
status: applied
goal: после лимита подписки claude.ai продолжать работу в Claude Code через Vertex AI на кредитах Google Cloud из подписки Google AI
metric: число запусков scripts/vertex.sh по командам и их коды выхода в JSONL сессий
baseline_date: 2026-11-20
target_date: 2026-12-04
---

# claude-vertex-credits — Claude Code на кредитах Google Cloud

## Цель
Подписки Google AI Pro и Ultra дают ежемесячный кредит Google Cloud ($10 / $40 / $100). Когда кончается лимит подписки Claude, работа встаёт. Скилл переключает Claude Code на Claude в Vertex AI отдельным settings-файлом, чтобы потратить этот кредит, а подписку оставить режимом по умолчанию.

## Baseline (до изменений, на дату 2026-11-20)
Механизма не было: ноль вызовов (скилла до этого PR не существовало). Встроенный `/setup-vertex` переключает провайдера навсегда через пользовательский `settings.json`.

## Гипотеза
Отдельный файл для `claude --settings` (проверено: его `env` переключает провайдера на Vertex) плюс проверка кредита и бюджет на первый реальный платёж дают переход без риска незаметных трат.

## Изменения
- `skills/claude-vertex-credits/SKILL.md` — деньги, шаги, модели, продолжение сессии, сбои.
- `skills/claude-vertex-credits/scripts/vertex.sh` — `doctor`, `setup`, `smoke`, `budget`, `launch`.
- `skills/claude-vertex-credits/README.md` — для тех, кто ставит скилл отдельно.
- `.gitignore` — whitelist каталога скилла.

Не проверено на 2026-11-20: покрывает ли кредит Developer Program партнёрские модели (Google об этом не пишет) и переносится ли `--continue` между провайдерами.

## Target
К 2026-12-04: хотя бы один полный цикл `setup` → `smoke` → `launch` без кода 5; подтверждено в Billing Reports, покрыл ли кредит строки Claude.

## Replay (заполняется через N дней)
