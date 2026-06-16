---
name: ab-test-dashboard
description: Build an Amplitude dashboard that shows whether an A/B test is winning. Triggers on phrases like "построй ab дашборд", "сделай дашборд для ab теста", "запустили аб тест построй дашборд", "amplitude ab test", "/ab-test-dashboard". The skill identifies what the test is about (pricing/UI/copy/feature/onboarding/retention), figures out which metric truly answers "успех или нет" (revenue/ARPU/conversion/retention/engagement), gathers all variant identifiers via AskUserQuestion, builds the chart through Amplitude MCP using the correct formula syntax, assembles the dashboard with a glossary header, and reports the URL. Avoids known traps: PROPSUM not SUMS in formula, RC raw events instead of custom Premium Purchase, gp: prefix on user properties in segments, ARPU normalization for non-50/50 splits, Day-7+ checkpoints for weekly subscriptions, MANDATORY `gp:userRole != User_Team_Member` filter in every segment for your internal-team projects (`<YOUR_PROJECT_IDS>`) — иначе team-тестеры доминируют на маленьких выборках.
---

## Customization (project-specific values)

Этот скилл использует значения, специфичные для твоего Amplitude-воркспейса (project IDs, internal-team filter). Не хардкодь их в скилле — держи в gitignored файле `~/.claude/config/ab-test-dashboard.local.md` и попроси Claude прочитать его в начале работы (`Read ~/.claude/config/ab-test-dashboard.local.md`). Шаблон — `config/ab-test-dashboard.local.example.md` в этом репозитории.

Заменяемые плейсхолдеры ниже по тексту: `<YOUR_PROJECT_IDS>` — список твоих project IDs, для которых обязателен фильтр internal-team.

# AB Test Dashboard Builder

Goal: build an Amplitude dashboard that answers a single question — **is this A/B test successful, yes or no?** The skill works for any kind of A/B test: pricing/offers, UI/copy variants, new features, onboarding flows, retention experiments. It picks the right metric for each, builds it via Amplitude MCP, and assembles a dashboard with an explanatory glossary header.

## When this skill triggers

- User describes a running A/B test and wants to monitor it
- Phrases like: "построй ab дашборд", "сделай дашборд для ab теста", "запустили аб тест построй дашборд", "ab test dashboard", "monitor my ab test", "/ab-test-dashboard"
- After the user kicked off an experiment in production and wants visibility

## Workflow (sequential — do not skip steps)

### Step 1 — Understand the test

**1a. First pull the test definition from its source — don't default to asking the user, and never tell the user a platform "can't surface it" without checking the REST API.**

Most tests live in **Firebase A/B Testing** (Remote Config) or **RevenueCat Experiments**. Pulling the definition gives you launch moment, split, variants, and the primary objective without guessing:

- **Firebase A/B Testing** — ⚠️ these are **NOT** in the Firebase MCP and **NOT** in `remoteconfig_get_template` (that template only has base conditions: platform/version/country/staging). The experiment list is a separate REST endpoint:
  - List: `GET https://firebaseremoteconfig.googleapis.com/v1/projects/{projectNumber}/namespaces/firebase/experiments?pageSize=300` → `definition.displayName`, `state` (RUNNING/DONE), `startTime`.
  - Detail: `GET …/experiments/{N}` → `definition.variants[]` (name + weight = split, e.g. `1:1` = 50/50) and `definition.objectives.eventObjectives[]` (`systemObjectiveDetails.objective`: `total_revenue` / `retention_7`; or `customObjectiveDetails`). **Match your primary chart to the experiment's own primary objective.**
  - **Auth** (when gcloud token is stale / wrong project): exchange the Firebase CLI refresh token — `~/.config/configstore/firebase-tools.json` → `tokens.refresh_token` → POST `https://oauth2.googleapis.com/token` with the public Firebase-CLI `client_id <FIREBASE_CLI_CLIENT_ID>` / `client_secret <FIREBASE_CLI_CLIENT_SECRET>` (the well-known public Firebase CLI OAuth client — look it up in the firebase-tools source). Never print tokens.
  - The variant **RC-parameter overrides are NOT returned** — only variant names. Which parameter/offering/product/price differs you discover **empirically in Step 2**. Firebase A/B variant assignment is **not pushed to Amplitude** as a user-property → split by an **event-property** (pitfall 13/17), not a `gp:` segment.
  - Your Firebase project number: `<YOUR_PROJECT_ID>`.
- **RevenueCat Experiments** — `list-experiments` / `get-experiment-results` (RC MCP). RC results carry **exposure** (the correct denominator) → cite them as source-of-truth for revenue lift; the Amplitude dashboard is live monitoring.

Then ask the user (below) **only for what the source didn't give you.**

Ask the user via `AskUserQuestion` (group 2–4 questions per call). Default to `Other` if their answer doesn't fit prebuilt options.

Required to learn:

1. **What is being tested?** → drives the right metric. Options:
   - Pricing/offer change → ARPU per cohort user (revenue normalized)
   - UI/copy/button on a paywall/onboarding screen → conversion rate funnel
   - New feature/section → engagement (uniques + per-user frequency) or retention
   - Onboarding flow change → activation rate (entry → key action) + Day-7 retention
   - Retention/churn experiment → retention curve
   - Multi-metric experiment → 2–3 charts
2. **Variant identifier** — how to tell A from B in Amplitude:
   - User property name (most A/B platforms set one — e.g. `onboardingOffer`, `experiment_paywall_v2`)
   - OR event property on a specific event (e.g. `offerName` on `Premium Purchase`)
   - Exact values for control and test variants
3. **Date the test launched** — use the **exact launch moment** (Firebase `experiments/{N}.startTime`, e.g. `2026-06-10T09:32:48Z`), not 00:00 of the launch day. Used for `start` timestamp AND for stating test age + absolute-date checkpoints in the glossary (pitfall 18). A weekly-sub test on Day 2 has near-zero signal — the glossary must make the age unmissable.
4. **Platform**: Android / iOS / Web / All.
5. **Traffic split**: 50/50, 66/33, 80/20, etc. **Critical** — non-50/50 split forbids Total Revenue as a metric (use ARPU instead).
6. **For revenue/subscription tests only**: subscription type (weekly / monthly / yearly / one-time / lifetime). Drives Day-7 vs Day-30 checkpoints.
7. **Amplitude project**: get from `mcp__plugin_amplitude_amplitude__get_context`. Default to user's `defaultAppId` unless they specified otherwise.

Only ask what's actually missing — if the user already gave variant names + platform, don't re-ask. If `defaultAppId` exists, don't ask which project (just confirm in glossary).

### Step 2 — Discover taxonomy

Run these in parallel before building anything:

- `get_context` → confirm projectId
- `search` (entityTypes=`["EVENT", "EVENT_PROPERTY", "USER_PROPERTY"]`) for relevant events to the test type (purchase events for pricing tests, onboarding events for onboarding tests, etc.)
- `query_dataset` diagnostic: group by the variant property **AND platform** (two-dimensional groupBy) to verify variant values exist on the target platform. See diagnostic below.

**Diagnostic (mandatory two-dimensional groupBy):**

```json
{
  "type": "eventsSegmentation",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "events": [{"event_type": "_active", "filters": [], "group_by": []}],
    "metric": "uniques",
    "groupBy": [
      {"type": "user", "value": "gp:<propertyName>", "group_type": "User"},
      {"type": "user", "value": "platform", "group_type": "User"}
    ],
    "segments": [{"time_type": "all", "conditions": [{"op": "is not", "prop": "gp:userRole", "type": "property", "values": ["User_Team_Member"], "prop_type": "user", "group_type": "User"}]}]
  }
}
```

**Interpret the diagnostic:**

| What you see | What it means | What to do |
|---|---|---|
| `(none) ; <Platform>` is most/all of the volume | User-property never written on target platform (instrumentation gap) | **Switch to event-property split** (Template 6, see pitfall 13). Don't block. |
| Variant values exist with similar counts | All good | Proceed with user-property segments (Templates 1–5) |
| Only `(none)` even across platforms | Test hasn't reached users yet OR property name wrong | Wait or correct property name. Re-run before building. |
| `(none)` dominates only on target platform, values populated elsewhere | iOS vs Android instrumentation parity gap | Event-property fallback or fix the app (slow path) |

**Always check property values per platform — never just `groupBy gp:<name>` without a second axis.** Otherwise you may build a chart that silently has no signal on the target platform.

### Step 3 — Pick the metric

Match test type → primary metric. Always one **single-metric chart** that directly answers "успех или нет" — that's the user's contract. If the test legitimately needs more (e.g. revenue + retention), build 2 charts max and explain why in glossary.

| Test type | Primary metric | Chart type | Formula |
|---|---|---|---|
| Pricing / offer (revenue) | ARPU per cohort user | `eventsSegmentation` `formula` | `(PROPSUM(A)+PROPSUM(B))/UNIQUES(C)` where A,B = RC purchase events, C = `_new` |
| Conversion (UI/copy/CTA) | CR per variant | `funnels` | metric `CONVERSION` |
| Activation (onboarding) | % of new users who reach key action | `funnels` | metric `CONVERSION` with `_new` as step 1 |
| Retention | N-day retention | `retention` | start event → return event |
| Engagement (feature usage) | Uniques + per-user frequency | `eventsSegmentation` | metric `uniques` + group_by variant |

See `references/chart-templates.md` for full JSON definitions for each.

### Step 4 — Build the chart

1. `query_dataset` with the chosen definition. Use `start` (Unix seconds) + `end: "now"` from launch date — **not** `range: "Last N Days"` (range includes pre-test data which corrupts the cohort).
2. **Verify Unix timestamp**: response shows interpreted range as `YYYY-MM-DD to YYYY-MM-DD`. If start year is wrong (e.g. 2025 instead of 2026), recalculate. 2026-01-01 00:00 UTC = 1767225600. Add 86400 per day.
3. If revenue metric: `newOrActive: "new"` is required (only count purchases from users who started in the cohort window).
4. Two segments: one per variant. Both segments must include `platform = X` AND the variant property condition.
5. If `query_dataset` returns 0 for both variants:
   - Check property name — try `gp:<name>` prefix (almost always required for user properties in segments)
   - Try alternative event types — `Premium Purchase` (custom) often has no `$revenue`; use `rc_initial_purchase_event` + `rc_trial_converted_event` with `environment = PRODUCTION` filter
   - Confirm test actually launched (variant B has any users at all — see Step 2 diagnostic)
   - **If user-property is `(none)` on the target platform** → switch to event-property pattern (Template 6, pitfall 13). RC's `presented_offering_id` works without app instrumentation.
   - **If `_new` cohort is all `(none)`** → drop `newOrActive: "new"`, use `"active"` with behavioral entry event (e.g. `Special Gift Opened`). See pitfall 15.
6. `save_chart_edits` → permanent `chartId`. Required to put on dashboard.

### Step 5 — Build the dashboard

Use `create_dashboard` with two rows:

1. Glossary header (rich_text, width 12, height 500) — see `references/glossary-template.md`
2. Chart row (chart, width 12, height 500)

For multi-metric tests (rare): add additional rows with smaller heights (375).

### Step 6 — Report

Tell user:
- Dashboard URL
- Chart URL
- Current data (1–2 lines: "A = X, B = Y")
- When to expect a real signal (Day 7 / Day 30 from launch — based on subscription type)
- Any caveats discovered (variant B has 0 users, split is non-50/50, data only includes today, etc.)

## Critical pitfalls (read before building)

See `references/pitfalls.md` for full list with examples. Key ones:

- **MANDATORY for your internal-team projects (`<YOUR_PROJECT_IDS>`): every segment MUST include `gp:userRole is not User_Team_Member`** — иначе team-тестеры доминируют на маленьких выборках (release 4.05.02 prec: Premium Purchase 7→1, Vote Not Buy 3→0). Add this condition in BOTH variant segments (control + test), не только в один.
- **User-property may not be written on every platform** — diagnostic MUST groupBy `gp:<variant>` AND `platform` together. If target platform shows only `(none)`, fall back to event-property split (pitfall 13, Template 6). Real precedent: an Android client writes only `isSpecialGiftOfferEnabled` boolean, not `specialGiftOfferID` — iOS instrumentation works, Android doesn't. RC's `presented_offering_id` saves you.
- **Pre-test subscribers inflate Baseline renewal revenue on Day 1–7** — old users on the Baseline offering id keep renewing during the test window. Baseline gets unfair renewal-revenue lift. Add a separate "initial-revenue-only" chart for the first renewal cycle and a glossary warning. See pitfall 14.
- **`newOrActive: "new"` + delayed user-property = empty cohort** — if the app writes the variant property after first session, all new users in the test window have `(none)`. Switch to `"active"` + behavioral entry event, OR use event-property. See pitfall 15.
- **Formula syntax**: only `PROPSUM(A)`, `UNIQUES(B)`, `TOTALS(B)` work. `SUMS()`, `SUM()`, `DISTINCT()`, plain `A/B` all fail with "Formula parse failed".
- **Revenue source**: in RevenueCat-style RC integrations, `$revenue` is on `rc_initial_purchase_event`, `rc_trial_converted_event`, `rc_renewal_event` (filter `environment = PRODUCTION`), NOT on custom `Premium Purchase` events.
- **User-property segments**: use `gp:<name>` prefix (e.g. `gp:onboardingOffer`), even though `get_properties` returns the name without it.
- **Non-50/50 split** forbids Total Revenue as a metric — must normalize via ARPU formula or use a rate-based metric (CR, retention).
- **Weekly subscription** needs minimum Day-7 window to capture first renewal. Day-0 metric misses retention effect.
- **Time range**: use `start` (Unix seconds) + `end: "now"`, not `range: "Last N Days"`. Last-30-Days includes pre-test data and corrupts the analysis.

## Available tools (Amplitude MCP)

The plugin `amplitude` MCP exposes these — load them via `ToolSearch` if not already in scope:

- `get_context`, `get_project_context`
- `search`, `get_events`, `get_properties`
- `get_chart_definition_params`, `verify_chart_definition`
- `query_dataset` (returns editId)
- `save_chart_edits` (editId → permanent chartId)
- `create_dashboard`, `edit_dashboard`, `get_dashboard`

## References

- `references/chart-templates.md` — full JSON definitions for revenue/conversion/retention/engagement charts
- `references/pitfalls.md` — anti-patterns and the working alternatives
- `references/glossary-template.md` — markdown template for the dashboard header

## Output style

- Always include the dashboard URL and chart URL(s) in the final reply
- Always tell user the **current** data even if it's "$0 / 0 users" (so they know the chart works)
- Always tell user **when** to come back (Day 7 / Day 30 / sample size threshold)
- Never claim "the test is winning/losing" — the data shows that, not you. Just describe what the dashboard shows.
