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
  - List: `GET https://firebaseremoteconfig.googleapis.com/v1/projects/{projectNumber}/namespaces/firebase/experiments?pageSize=300` → `definition.displayName`, `state` (RUNNING/DONE), `startTime`. Endpoint verified working 2026-08-13, post-migration.
  - **Experiment ids changed with the migration**: new experiments come back as `abt_<N>`
    (`…/experiments/abt_63`), older ones keep a bare number (`…/experiments/61`). Take the id from
    the `name` field, never assume it's numeric.
  - **Token**: `gcloud auth print-access-token` may fail here with `PERMISSION_DENIED … local
    Application Default Credentials` (no quota project). The reliable route is the Firebase CLI
    refresh-token exchange below. Parse the JSON with an explicit `encoding='utf-8'` — on Windows
    the default cp1251 decode blows up on experiment names.
  - Detail: `GET …/experiments/{N}` → `definition.variants[]` (name + weight = split, e.g. `1:1` = 50/50) and `definition.objectives.eventObjectives[]` (`systemObjectiveDetails.objective`: `total_revenue` / `retention_7`; or `customObjectiveDetails`). **Match your primary chart to the experiment's own primary objective.**
  - **Auth** (when gcloud token is stale / wrong project): exchange the Firebase CLI refresh token — `~/.config/configstore/firebase-tools.json` → `tokens.refresh_token` → POST `https://oauth2.googleapis.com/token` with the public Firebase-CLI `client_id <FIREBASE_CLI_CLIENT_ID>` / `client_secret <FIREBASE_CLI_CLIENT_SECRET>` (the well-known public Firebase CLI OAuth client — look it up in the firebase-tools source). Never print tokens.
  - The variant **RC-parameter overrides are NOT returned** — only variant names. Which parameter/offering/product/price differs you discover **empirically in Step 2**. Firebase A/B variant assignment is **not pushed to Amplitude** as a user-property → split by an **event-property** (pitfall 13/17), not a `gp:` segment.
  - Your Firebase project number: `<YOUR_PROJECT_ID>`.
  - **Workflow Migration (2026):** A/B Testing now lives *inside* the Remote Config template
    (experiments alongside Rollouts/Personalization); the standalone Drafts tab is deprecated and
    is removed **2026-10-31**, in-flight edits sit in a session-local "Staging" sub-tab, and
    "Manage test devices" is gone (target internal devices by Firebase Installation ID in the
    experiment's conditions instead). Console-side change — the experiments REST endpoints above
    were **not** announced as deprecated (checked 2026-08-13). Limits: 300 experiments per project,
    24 running at once.
  - **Auth reality check before you plan on the REST route:** both `gcloud` and the Firebase CLI
    token expire often, and re-auth is interactive → an agent cannot do it. Check `firebase
    login:list` first; if the required account is present but stale, the fix is the user running
    `firebase login --reauth` / `gcloud auth login`. **Do not silently fall back to a personal
    account** — it usually has no access to the project and will just return a shorter project
    list that looks like "the project doesn't exist". When the REST route is blocked, take launch
    date / variant count / split from the console screenshot the user gave you and say in the
    glossary that the split is user-reported, not pulled.
  - **"Cannot calculate a p-value"** on the experiment page means Firebase itself could not
    evaluate the objective — almost always too few users (a 97-user, 2-variant test is far below
    any usable power), sometimes an objective/targeting mismatch. It is **not** a reason to skip
    the dashboard, and the dashboard does **not** substitute for the verdict: state the observed
    counts and the fact that no arm is decidable yet.
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
7. **Amplitude project**: get from `get_amplitude_context` (call with no args). Default to the user's `defaultAppId` unless they specified otherwise.

Only ask what's actually missing — if the user already gave variant names + platform, don't re-ask. If `defaultAppId` exists, don't ask which project (just confirm in glossary).

### Step 2 — Discover taxonomy

Run these in parallel before building anything:

- `get_amplitude_context` → confirm projectId
- `search` (entityTypes=`["EVENT", "EVENT_PROPERTY", "USER_PROPERTY"]`) for relevant events to the test type (purchase events for pricing tests, onboarding events for onboarding tests, etc.)
- `query_dataset` diagnostic: group by the variant property **AND platform** (two-dimensional groupBy) to verify variant values exist on the target platform. See diagnostic below.

**Which events actually carry the variant param — check, don't assume.** A param added for one
test is usually wired into a *subset* of events (typically the purchase ones), and the one you
most want — the paywall/screen **impression** event — is often the one it's missing from. That
decides the whole dashboard: no marked impression event = **no exposure denominator** = conversion
rate per variant cannot be computed, only ratios and downstream funnels (pitfall 22).

Cheapest check is `get_properties` (`propertyType: "event"`, `eventType: "<event>"`) — a compact
list per event. `query_dataset` also enforces it: an event/property that doesn't exist in the
taxonomy now returns an explicit `Invalid chart definition: Property "X" does not exist on event
type "Y"` (verified 2026-08-13), so a typo fails loudly instead of silently rendering zeros.
Note the asymmetry: `get_amplitude_charts include:"guide"` does NOT validate names — it only
describes chart structure.

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

**When the variant param rides only on downstream events (no marked impression event), the table
above does not apply** — every row in it assumes you can count exposed users per arm. Fall back to
this trio (Templates 7–8), and say plainly in the glossary that these are proxies:

1. **Downstream funnel** — first marked event → success event, split `byProp` on the variant param.
   Honest, because its denominator (the first marked event) is itself marked. Answers "of users who
   got far enough to be labelled, which arm finishes more".
2. **Intent ratio** — `UNIQUES(variant=B) / UNIQUES(variant=A)` on the earliest marked event,
   compared against the **baseline implied by the traffic split** (50/50 → 1.0; 67/33 → 0.49).
   Above baseline = the B arm reaches that step more often. Needs the split; if the split is
   user-reported rather than pulled from the platform, label it as such.
3. **Treatment-on-treated** — if a second param distinguishes "feature actually rendered" from
   "flag was on" (e.g. `…Shown` vs `…Enabled`), build the same cut on the *Shown* param and report
   the dilution (how many flagged users never saw the feature). Intention-to-treat on the flag
   understates the effect whenever that gap is non-trivial.

### Step 4 — Build the chart

0. (optional but cheap) `verify_chart_definition` — catches wrong enums, bad field names, and
   event/property names that don't exist in the taxonomy, and returns the corrected definition.
1. `query_dataset` with the chosen definition. Use `start` (Unix seconds) + `end: "now"` from launch date — **not** `range: "Last N Days"` (range includes pre-test data which corrupts the cohort).
2. **Verify Unix timestamp**: response shows interpreted range as `YYYY-MM-DD to YYYY-MM-DD`. If start year is wrong (e.g. 2025 instead of 2026), recalculate. 2026-01-01 00:00 UTC = 1767225600. Add 86400 per day.
2b. **`interval` silently widens the window backwards to the bucket boundary.** `interval: 30` on a
   test launched Aug 10 buckets from **Aug 1** and the totals then include 9 pre-test days;
   `interval: 7` snaps to Monday. Verified 2026-08-13 — a diagnostic read 64 vs the true 11 this
   way, a 6× inflation that looks like real data. Keep `interval: 1` for A/B charts, or use `7`
   **only** when the launch date is itself a Monday. Always sanity-check the `xValue` of the first
   datapoint in the response against your intended `start`.
3. If revenue metric: `newOrActive: "new"` is required (only count purchases from users who started in the cohort window).
4. **Readable legend — prefer a property split, not two named segments.** The cleanest way to get a readable per-variant legend is **one segment + a property breakdown**: funnels → `byProp` + `byPropIndex` on the variant property; eventsSegmentation → `groupBy` on it. The legend then shows the property's own values (e.g. `True` / `False`, `control` / `test`) automatically. This is the paywall-A/B pattern and it always renders. Use this whenever the variant IS a single event/user property.
5. When the split is **not** a single property (e.g. `version ∈ {4.09.*}` vs `∉` → two segments with different conditions), you **cannot set the tile legend through this MCP** — it must be done in the UI after building. The tile legend reads the **top-level** `customSerieLabels` map (`{"{\"segmentIndex\":0}":"before 4.09","{\"segmentIndex\":1}":"4.09"}`), and only the UI "Rename a segment" action writes it (hover the segment name → click → type → Save). Verified dead ends (don't repeat them): `query_dataset` accepts top-level `customSerieLabels` and labels the response/CSV, but `save_chart_edits` **strips** it; placing it inside `params` survives save but the renderer **ignores** params-level. Still set each segment `name` (labels the query/CSV `Segment` column). In your final report, list which charts need the ~20-second UI rename. **Prefer the property split (step 4)** whenever the variant is a single property — it avoids the rename entirely.
5. If `query_dataset` returns 0 for both variants:
   - Check property name — try `gp:<name>` prefix (almost always required for user properties in segments)
   - Try alternative event types — `Premium Purchase` (custom) often has no `$revenue`; use `rc_initial_purchase_event` + `rc_trial_converted_event` with `environment = PRODUCTION` filter
   - Confirm test actually launched (variant B has any users at all — see Step 2 diagnostic)
   - **If user-property is `(none)` on the target platform** → switch to event-property pattern (Template 6, pitfall 13). RC's `presented_offering_id` works without app instrumentation.
   - **If `_new` cohort is all `(none)`** → drop `newOrActive: "new"`, use `"active"` with behavioral entry event (e.g. `Special Gift Opened`). See pitfall 15.
6. `save_chart_edits` → permanent `chartId`. Required to put on dashboard.
7. `render_chart` with the `chartEditId` (or saved `chartId`) to actually SHOW the result to the
   user — skipping it means they read numbers in prose instead of seeing the chart. Do NOT render
   an empty/all-zero result: say so in words instead.

### Step 5 — Build the dashboard

Use `create_dashboard` with two rows:

1. Glossary header (rich_text, width 12, height 500) — see `references/glossary-template.md`
2. Chart row (chart, width 12, height 500)

For multi-metric tests (rare): add additional rows with smaller heights (375).

**Charts you build land UNPUBLISHED in your personal space** — the dashboard link works for you and
looks broken/empty to a teammate. Finish the job: `share_object` (objectType `DASHBOARD`, and the
charts too) with the intended viewers' login emails, or tell the user in the report that publishing
to a shared space is a manual step. Don't hand over a link that only the author can read.

### Step 6 — Report

Tell user:
- Dashboard URL
- Chart URL
- Current data (1–2 lines: "A = X, B = Y")
- When to expect a real signal (Day 7 / Day 30 from launch — based on subscription type)
- Any caveats discovered (variant B has 0 users, split is non-50/50, data only includes today, etc.)

## Web / wasmJs tests

- `platform` for the web client is **`Web`** — a third value next to `Android` / `iOS`. Filter on
  it explicitly: a shared Amplitude project mixes all three, and mobile volume will drown the web
  arm otherwise.
- **Firebase A/B variant assignment never reaches Amplitude as a user-property** on any platform,
  web included → always the event-property route. Which events carry it is a code fact, not a
  platform fact — check per event (Step 2).
- **A feature flag shipped "Android-only" may be alive on web and the code comments stale.** Check
  the wasmJs `actual`/stubs of every flag source (RemoteConfig, DataStore) before concluding the
  feature is off there — hardcoded `false` stubs are the classic failure, and un-stubbing them is
  a one-line change someone may already have made.
- Web purchases may run through a different billing path (web billing / Stripe) than the store
  SDK. Don't assume `rc_*` events cover the web arm before checking.

## Critical pitfalls (read before building)

See `references/pitfalls.md` for full list with examples. Key ones:

- **`interval` widens the window backwards to the bucket boundary** — `interval: 30` on an Aug-10
  test reads from Aug 1 and inflates every count (pitfall 22). Use `interval: 1`.
- **No marked impression event = no exposure denominator** — conversion-rate-per-variant is then
  not computable; use downstream funnel + intent-ratio + treatment-on-treated instead, and label
  them as proxies (pitfall 22).
- **Charts save unpublished into your personal space** — the dashboard link is not team-visible
  until shared/published (pitfall 23).
- **`save_chart_edits` can fail with `"Chart limit reached"`** on capped plans, at the very last
  step. Check `org.plan` from `get_amplitude_context` early; when it hits, `render_chart` the
  `chartEditId`s so the analysis still lands, and hand over a cleanup list — never delete other
  people's charts yourself (pitfall 25).

- **MANDATORY for your internal-team projects (`<YOUR_PROJECT_IDS>`): every segment MUST include `gp:userRole is not User_Team_Member`** — иначе team-тестеры доминируют на маленьких выборках (release 4.05.02 prec: Premium Purchase 7→1, Vote Not Buy 3→0). Add this condition in BOTH variant segments (control + test), не только в один.
- **User-property may not be written on every platform** — diagnostic MUST groupBy `gp:<variant>` AND `platform` together. If target platform shows only `(none)`, fall back to event-property split (pitfall 13, Template 6). Real precedent: an Android client writes only `isSpecialGiftOfferEnabled` boolean, not `specialGiftOfferID` — iOS instrumentation works, Android doesn't. RC's `presented_offering_id` saves you.
- **Pre-test subscribers inflate Baseline renewal revenue on Day 1–7** — old users on the Baseline offering id keep renewing during the test window. Baseline gets unfair renewal-revenue lift. Add a separate "initial-revenue-only" chart for the first renewal cycle and a glossary warning. See pitfall 14.
- **`newOrActive: "new"` + delayed user-property = empty cohort** — if the app writes the variant property after first session, all new users in the test window have `(none)`. Switch to `"active"` + behavioral entry event, OR use event-property. See pitfall 15.
- **A two-segment chart's tile legend cannot be set through this MCP — plan for a UI rename or avoid it.** The tile reads the **top-level** `customSerieLabels` map, written only by the UI "Rename a segment" (hover→click→type→Save). Verified: segment `name` labels only the query/CSV; `query_dataset` accepts top-level `customSerieLabels` (labels the response) but `save_chart_edits` **strips** it; params-level `customSerieLabels` survives save but the renderer **ignores** it; there is no MCP tool to patch a saved chart's top-level definition. → **Programmatic readable legend = split by a property** (`byProp` funnels / `groupBy` segmentation → legend = the property's values). For arbitrary two-segment splits, build the chart, then tell the user to UI-rename each segment. Don't burn iterations re-testing the API paths — they're all dead ends. (prec: release-impact dashboard — segment `name`, top-level `customSerieLabels`+save, and params-level `customSerieLabels` all failed to relabel the tile; UI rename was the only fix.)
- **Formula syntax**: only `PROPSUM(A)`, `UNIQUES(B)`, `TOTALS(B)` work. `SUMS()`, `SUM()`, `DISTINCT()`, plain `A/B` all fail with "Formula parse failed".
- **Revenue source**: in RevenueCat-style RC integrations, `$revenue` is on `rc_initial_purchase_event`, `rc_trial_converted_event`, `rc_renewal_event` (filter `environment = PRODUCTION`), NOT on custom `Premium Purchase` events.
- **User-property segments**: use `gp:<name>` prefix (e.g. `gp:onboardingOffer`), even though `get_properties` returns the name without it.
- **Non-50/50 split** forbids Total Revenue as a metric — must normalize via ARPU formula or use a rate-based metric (CR, retention).
- **Weekly subscription** needs minimum Day-7 window to capture first renewal. Day-0 metric misses retention effect.
- **Time range**: use `start` (Unix seconds) + `end: "now"`, not `range: "Last N Days"`. Last-30-Days includes pre-test data and corrupts the analysis.

## Available tools (Amplitude MCP)

Load in ONE `ToolSearch` call (comma-separated `select:`), not one per tool. Verified against live
schemas 2026-08-13 — the names below are current; several older ones were consolidated:

| Use | Tool | Note |
|---|---|---|
| org + project list, project settings | `get_amplitude_context` | **replaces** `get_context` / `get_project_context` (one tool; omit `projectId` for the list) |
| find events/properties/charts | `search` | `entityTypes: ["EVENT","EVENT_PROPERTY","USER_PROPERTY","CHART"]` |
| taxonomy detail | `get_events`, `get_properties` | **`get_event_properties` is gone** → `get_properties` with `propertyType: "event"` + `eventType` |
| pre-flight validation | `verify_chart_definition` | validates event/property names against the project taxonomy, auto-coerces known mistakes |
| run an ad-hoc query | `query_dataset` | returns `chartEditId`; also aliased `query_amplitude_data` (accepts `chart` + `chartId` for fork/modify) |
| read saved charts | `get_amplitude_charts` | one tool, five modes via `include`: `link` / `typed` / `definition` / `data` / `guide`. **replaces** `get_charts`, `query_charts`, `get_chart_definition_params` (= `include:"guide"`) |
| SHOW a chart to the user | `render_chart` | pass the `chartEditId` from `query_dataset` (or a saved `chartId`) — renders an interactive widget |
| persist | `save_chart_edits` | `chartEditId` → permanent `chartId` (required for dashboards) |
| assemble | `create_dashboard`, `edit_dashboard`, `get_dashboard` | `edit_dashboard` needs `expectedLastModified` from `get_dashboard` |
| make it visible to the team | `share_object` | AI-built charts land **unpublished in your personal space** — see pitfall 23 |

Amplitude also exposes `get_experiments` / `query_experiment` — those are for experiments run in
**Amplitude Experiment**. A Firebase/RevenueCat test is invisible to them; don't reach for them
just because the word "experiment" appears.

## References

- `references/chart-templates.md` — full JSON definitions for revenue/conversion/retention/engagement charts
- `references/pitfalls.md` — anti-patterns and the working alternatives
- `references/glossary-template.md` — markdown template for the dashboard header

## Output style

- Always include the dashboard URL and chart URL(s) in the final reply
- Always tell user the **current** data even if it's "$0 / 0 users" (so they know the chart works)
- Always tell user **when** to come back (Day 7 / Day 30 / sample size threshold)
- Never claim "the test is winning/losing" — the data shows that, not you. Just describe what the dashboard shows.
