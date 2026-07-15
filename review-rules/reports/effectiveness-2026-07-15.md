# Bug-pattern review — эффективность и новизна (2026-07-15)

Разбор самодельной системы `review-rules/` (L1 static-гейт + L2 LLM-судья + L3 process-gate):
что реально ловит, насколько это ново, куда тянуть. Санитизированная публичная версия —
имена проектов и инциденты живут в gitignored `stats/` (телеметрия) и `stats/review-rules-incidents.md` (ledger).

- **Полный визуальный отчёт (приватный, реальные имена):** `stats/reports/bug-pattern-review-2026-07-15.html` (gitignored) + hosted artifact (private).
- **Источник данных:** `stats/review-rules-events.jsonl` (L1/L2/L3 events) → `stats.py` → `stats/review-rules.md`.
- **Окно:** 29 июн – 15 июл 2026, 17 дней, 14 проектов, 653 уникальных состояния кода.

## Вердикт

**Окупается.** Ловит дорогой класс «green-but-broken» (компилится, тесты зелёные, ломается
в release / на вебе / на девайсе) — мимо которого проходит generic-ревью (`/code-review`, `ce-*`).

## «Ловит 1 из 5» — реконсиляция felt vs logged

Ощущение владельца «ловит ~1 из 5 сессий» **подтверждается**, с оговоркой о том, *когда* считать:

| Срез | Частота | Смысл |
|---|--:|---|
| По всем прогонам L1 | ~1% confirmed | Система намеренно молчит: diff не задел область → правило не бежит |
| Прогон с любой находкой | 42.6% | Почти всё — runtime-WARN, в основном шум |
| **Прогон L2 с подтверждённой находкой** | **24%** (11/46) | **Это и есть ощущаемое «1 из ~4-5»** |

Вывод: интуиция точна — она про моменты, когда система *включается* (L2 реально запущен),
а не про фоновые тихие прогоны. Ключевую метрику ценности (24% confirmed-per-L2-run)
`stats.py` сейчас **не выводит** — репортит только по-находочный FP 90%, из-за чего система
недооценивает себя. См. continuation-doc, P1.

## Метрики

**L1 (детерминированный гейт):** 1347 прогонов. Entry: stop 1078 / precommit 173 / endsession 96.
Static-HIGH блокировок: **1** — статика бьёт узко и точно, почти без ложных.

**L2 (LLM-судья):** 46 прогонов. 14 confirmed / 122 dismissed (90% по-находочный FP);
но 11/46 прогонов (24%) дали ≥1 подтверждённый баг.

**L3 (process-gate):** вооружался 64 раза — subagent-scope 28, anti-regression 22,
deploy-verify 9, repro-on-unreproduced 5. Исход (`armed → resolved`) сейчас не логируется.

## Что именно поймано (15 подтверждённых)

Концентрация в дорогих классах:
- `cloud-functions-deploy-skew` ×3 — деплой не в тот регион / stale-ревизия = прод-даун (404/CORS).
- `web-shell-mirror-state-lags-host-push` ×2 — рассинхрон web-shell state.
- `cancellationexception-swallowed-before-crash-report` — отмена корутины летит в crash-report как краш.
- Единичные: `edge-to-edge-bar-tint`, `localized-text-clipping-fixed-container`,
  `wasmjs-nonemoji-symbol-glyph-tofu`, `react-shell-overlay-pointer-events`,
  `anchored-dock-content-drop-on-targetvalue-midcrossfade`, `web-share-transient-activation-lost-after-await`,
  `web-shell-width-272-cross-lang-coupling`, `wrangler-account-and-workers-dev`.

Все — класс «прошло бы generic-ревью и тесты».

## Шум (главная точка роста)

5 runtime-правил дают ~6757 срабатываний и **0** подтверждений (100% est-FP):
`initjs-window-sentry-dead-channel` (2299×), `boot-resource-retry-no-terminal-spinner-state` (1486×),
`css-border-on-rounded-pill-artifacts` (1155×), `double-system-bar-padding` (1039×),
`textalign-center-without-fillwidth` (777×). Топят сигнал судьи → кандидаты №1 на ужесточение
`detect` или понижение в не-эскалируемый advisory.

**Покрытие:** 55/89 правил ни разу не сработали — часть просто не трогали область (dormant, ок),
часть — потенциально мёртвые детекторы (regex-опечатка / устаревший путь). Нужен smoke на каждое.

## Новизна (сверено веб-разведкой, июль 2026)

Не новый примитив — у каждого слоя есть именованный предок. Но **сборка** редка.

| Аналог | Что общего | Ключевое отличие системы |
|---|---|---|
| Cursor Bugbot (learned rules) | Полный цикл «инцидент → авто-правило → энфорс → disable по телеметрии» | Team/cloud, чисто-LLM на PR; нет static-гейта, нет разделения на 3 режима, нет process-gate |
| Semgrep Assistant + Memories | Static-гейт + FP-память из инцидентов | Enterprise CI, security-фокус, memories давят FP а не кодируют «green-but-broken»; один режим |
| Compound engineering (Every) | Философия «научи один раз» | Знание пассивное (промпт), team-scope; у нас — исполняемое + телеметрия |
| CodeRabbit / Qodo / Greptile | Learnings из прошлых ревью | Серверные, непрозрачные, без детерминированного гейта и own-FP |
| Cursor/Cline rules, Copilot instructions | Правила из проекта, glob-scoped | Только LLM-контекст, без энфорса и FP-замера |
| Checklist-based review / SRE postmortem | Предок L3 | Про код-чеклист, не про поведение агента; редко привязан к diff-условию |

**Редкое/своё:** (1) **process/behavior-gate** — ревью *как агент себя вёл* (молча выпилил фичу,
слепой патч, subagent-scope), аналогов не найдено; (2) **роутинг по режиму провала**
(static / runtime / process) в одном личном реестре; (3) **собственная FP-телеметрия на правило**,
ведущая прунинг; (4) всё на **single-dev масштабе поверх терминального агента**, не CI/PR-сервер.

**Статья-угол (самый свежий):** «process-gate — ревью поведения AI-агента, а не кода» +
«compound engineering, но с цифрами» (17 дней телеметрии против постулатов).

⚠️ Для публичной статьи обобщить все имена проектов (`<your-project>`, `com.example.*`) по анти-утечка-правилу.
