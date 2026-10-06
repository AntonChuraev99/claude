---
date: 2026-10-06
slug: revenuecat-plugin-rename
status: applied
goal: product-expert keeps RevenueCat MCP and skills after the upstream plugin rename RevenueCat → revenuecat (2.0.0 → 2.3.0)
metric: product-expert resolves mcp__plugin_revenuecat_RevenueCat__* and revenuecat:revenuecat-charts without "tool not found"
baseline_date: 2026-10-06
target_date: 2026-10-20
---

# RevenueCat plugin rename

## Цель
Маркетплейс `RevenueCat/ai-toolkit` переименовал плагин `RevenueCat` в `revenuecat` (`"renames"` в `marketplace.json`) и выпустил 2.3.0. `claude plugin update RevenueCat@RevenueCat` падает с `Plugin "RevenueCat" not found`. После переустановки меняются префиксы: MCP-тулы — `mcp__plugin_revenuecat_RevenueCat__*`, скиллы — `revenuecat:*`. Старые имена в харнессе перестают резолвиться.

## Baseline (до изменений, на дату 2026-10-06)
- Установлен `RevenueCat@RevenueCat` 2.0.0; обновление невозможно.
- `agents/product-expert.md`: allowlist `tools:` и тело ссылаются на `mcp__plugin_RevenueCat_RevenueCat` и `RevenueCat:revenuecat-charts`.
- `settings.example.json`: `enabledPlugins` содержит `RevenueCat@RevenueCat`.
- Метрика бинарная (резолвится тул или нет), числа нет. Ключ сервера в `.mcp.json` 2.3.0 остался `RevenueCat`, поэтому префикс MCP — `mcp__plugin_revenuecat_RevenueCat` (сверено 2026-10-06: `claude mcp list` → `plugin:revenuecat:RevenueCat`).

## Гипотеза
Замена префиксов на новые сохраняет доступ product-expert к RevenueCat MCP и скиллу чартов после перехода на 2.3.0.

## Изменения
- `agents/product-expert.md` — `mcp__plugin_RevenueCat_RevenueCat` → `mcp__plugin_revenuecat_RevenueCat`, `RevenueCat:revenuecat-charts` → `revenuecat:revenuecat-charts`.
- `settings.example.json` — `RevenueCat@RevenueCat` → `revenuecat@RevenueCat` в `enabledPlugins`.
- Локально (не в репо): `skillOverrides` `RevenueCat:*` → `revenuecat:*` в `settings.json`; плагин переустановлен.
- Ловушка CLI: `uninstall RevenueCat@RevenueCat` резолвит алиас и удаляет новый `revenuecat`. Для миграции достаточно `claude plugin install revenuecat@RevenueCat` в каждом scope, без uninstall.

## Target
К 2026-10-20 вызовы product-expert к RevenueCat (чарты, overview metrics) проходят без «tool not found».

## Replay (заполняется через N дней)
pending
