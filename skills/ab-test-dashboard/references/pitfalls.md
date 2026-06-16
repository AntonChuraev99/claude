# Pitfalls & Anti-patterns

Hard-won lessons from building A/B dashboards through Amplitude MCP. Each entry: ❌ what fails → ✅ what works → why.

---

## 1. Formula syntax — only `PROPSUM` / `UNIQUES` / `TOTALS` work

❌ All of these fail with `"Formula parse failed"`:
- `SUMS(A)` (logical guess from chart-level `metric: "sums"`)
- `SUMS[A]` (square brackets)
- `SUM(A.$revenue)` (with property selector)
- `DISTINCT(B)` (SQL-style)
- `A / B` (no operators)
- `TOTAL(A)` (singular form)

✅ Working syntax:
- `PROPSUM(A)` — sum of the property in `events.[A].group_by`
- `UNIQUES(B)` — unique users
- `TOTALS(B)` — event count
- Combined: `(PROPSUM(A)+PROPSUM(B))/UNIQUES(C)`

Why: not documented in `get_chart_definition_params` API spec. Only `amplitude:create-chart` plugin skill mentions `PROPSUM` (in its "Aggregation Scope" section). Discovered after 5 failed attempts on 2026-05-08.

**Action**: when building a `metric: formula` chart, use these three operators only. Don't guess.

---

## 2. Revenue source — RC raw events, not custom Premium Purchase

❌ Using your custom purchase event with `group_by: $revenue` and getting all-zero results:

```json
{"event_type": "Premium Purchase", "group_by": [{"value": "$revenue"}]}
// → revenue = 0 for every segment, even those with confirmed purchases
```

✅ Use RevenueCat raw events with `environment = PRODUCTION` filter:

```json
{
  "event_type": "rc_initial_purchase_event",
  "filters": [{"group_type": "User", "subprop_key": "environment", "subprop_op": "is", "subprop_value": ["PRODUCTION"]}],
  "group_by": [{"type": "event", "value": "$revenue", "group_type": "User"}]
}
```

Plus optionally `rc_trial_converted_event` (for offers with trial), `rc_non_subscription_purchase_event` (for one-time IAPs).

Why: when a project integrates RevenueCat → Amplitude, RC pushes purchases as `rc_*_event` types with proper `$revenue` field. The custom `Premium Purchase` event your app fires for analytics may not include the price/currency that Amplitude uses for `$revenue` aggregation. Verify per-project via `get_event_properties` — if `$revenue` isn't in the property list, that event won't aggregate.

**Action**: for revenue tests, default to RC raw events. Test with a small diagnostic query before building the main chart.

---

## 3. User-property segments require `gp:` prefix

❌ Using the property name as returned by `get_properties` directly in a segment:

```json
{"prop": "onboardingOffer", "prop_type": "user", "group_type": "User"}
// → "Invalid user property onboardingOffer"
```

✅ Add `gp:` prefix:

```json
{"prop": "gp:onboardingOffer", "prop_type": "user", "group_type": "User"}
```

Why: `gp:` denotes "group property" in Amplitude's segment language. The same name works without prefix in `groupBy` (chart-level) but requires the prefix in `segments[].conditions[].prop`. Source: existing chart `c2lkkxix` definition uses `gp:premiumType`.

**Action**: always add `gp:` for user properties in segments. Test with one diagnostic query if unsure (uniques + groupBy by `gp:<name>` reveals actual values).

---

## 4. Total Revenue is invalid for non-50/50 splits

❌ Building a chart with `metric: "sums"` of `$revenue` per variant when split is not 50/50 (e.g. 66/33, 80/20, 90/10 canary):

Result: control automatically gets ~2× more users → ~2× more revenue → looks like winning even when ARPU is identical. False signal.

✅ Always normalize via ARPU formula:

```json
{
  "metric": "formula",
  "formula": "(PROPSUM(A)+PROPSUM(B))/UNIQUES(C)"
}
```

Where C = `_new` (or whatever event marks cohort entry).

Why: Total Revenue scales linearly with cohort size. ARPU divides it out, so 66/33 is no longer a confound.

**Action**: always ask user for split in Step 1. If not 50/50, mandate ARPU. If 50/50, ARPU is still safer (split can drift over time).

---

## 5. Time range — `start`/`end`, not `Last N Days`

❌ Using `range: "Last 30 Days"` for a test that launched recently:

The chart will include 30 days of pre-test data. For variants where the user-property was assigned only after launch, pre-test users have `(none)` for that property and don't show up — but their purchases inflate denominators in formulas.

✅ Use Unix timestamps:

```json
{"start": <launch_unix_seconds>, "end": "now"}
```

Compute `start`: 2026-05-08 00:00 UTC = `1778198400`. Add 86400 per day from a known reference. Verify in `query_dataset` response — it shows the interpreted range as `"YYYY-MM-DD to YYYY-MM-DD"`. If wrong year (off by 365 days), recalculate.

Reference points (00:00 UTC):
- 2026-01-01 = 1767225600
- 2026-05-01 = 1777593600
- 2026-05-08 = 1778198400
- 2026-06-01 = 1780272000

**Action**: never use `range` for an A/B test that started in the analysis window. Always use `start` + `end: "now"`.

---

## 6. `newOrActive: "new"` is mandatory for cohort tests

❌ Omitting it (defaults to "active"):

Your "control segment" then includes any user with `onboardingOffer = androidMain2` who was active in the window — even users who got that property assigned months ago. They mix old behavior into the cohort.

✅ Always set `newOrActive: "new"` for A/B tests:

```json
{"newOrActive": "new"}
```

Counts only users who became new during the test window.

Why: the assumption of an A/B test is that variant assignment happens at first session. `newOrActive: "new"` enforces that.

**Action**: include `newOrActive: "new"` in every chart for an A/B test.

---

## 7. Behavioral conditions on Sign Up Success inflate cohorts

❌ Using a behavioral segment condition `Sign Up Success WHERE version >= X.Y.Z` to define "users on the new app version":

Sign Up Success fires on every login (it's actually "user signed in this session"). Old users on the new app version will fire it → counted as "new". Your before/after sample inflates by 2×.

✅ Use top-level **user-property** segment for version cutoffs:

```json
{"prop": "gp:[Amplitude] Start version", "op": "is", "values": ["X.Y.Z"]}
```

Why: `[Amplitude] Start version` is set once at first session — never re-fires. Source: project memory `amplitude_funnel_segment_property_vs_behavioral.md`.

**Action**: for version cutoffs in A/B-style analysis, use user-property segments only. Behavioral conditions are for "did at least one X" use cases, not cohort definitions.

---

## 8. Subscription tests need Day-7+ window minimum

❌ Looking at Day-0 (immediate purchase) results for a weekly subscription test and concluding "B is winning":

You're missing the most important effect — retention. A higher price might convert fewer users on Day 0 but those users might retain at the same rate, so Day-7 ARPU (which includes the first renewal) overtakes Day 0.

✅ Wait for Day-7 minimum (weekly), Day-30 (monthly), Day-90 (yearly) before declaring a winner.

Why: subscription LTV compounds over renewals. Single-payment metrics undersample.

**Action**: in glossary header, always state checkpoints based on subscription type. Tell user "real signal at Day 7, full LTV at Day 30" so they don't make premature decisions.

---

## 9. Statistical significance — t-test is wrong for revenue

❌ Plugging revenue means into an online t-test calculator:

Revenue distributions are right-skewed (mass at zero + long tail of buyers). t-test assumes normal distribution. p-values are unreliable, often inflated.

✅ Use Mann-Whitney / Wilcoxon Rank Sum Test, or Bayesian methods, or rely on visual lift + cohort size heuristics:
- Lift ≥ 1.5× with cohort > 1500 per variant → likely real
- Lift < 1.2× → wait longer regardless of nominal "significance"

Why: source [Analytics Toolkit](https://blog.analytics-toolkit.com/2017/statistical-significance-non-binomial-metrics-revenue-time-site-pages-session-aov-rpu/).

**Action**: in glossary, mention "Mann-Whitney/Wilcoxon, не t-test" so user doesn't get fooled by online t-test calculators.

---

## 10. Verify variant exists before building chart

❌ Building a chart, getting all-zero data, and assuming it's "no purchases yet":

The variant property value might not actually exist. Test launched but app rollout might not have shipped, or the property name has a typo.

✅ Run a diagnostic query first:

```json
{
  "type": "eventsSegmentation",
  "params": {
    "events": [{"event_type": "_active", "filters": [], "group_by": []}],
    "metric": "uniques",
    "groupBy": [{"type": "user", "value": "gp:<propertyName>", "group_type": "User"}],
    "newOrActive": "new",
    "segments": [{"conditions": [{"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"}]}]
  }
}
```

Result lists actual values + counts. Verify both control and test values are present with non-zero counts.

**Action**: always run this before building the main chart. Saves 5+ minutes of debugging "why is everything zero".

---

## 11. Exclude internal Team Members from your org's dashboards (MANDATORY)

❌ Building any Amplitude chart for your internal-team projects (`<YOUR_PROJECT_IDS>`) without filtering out internal team:

```json
{"segments":[{"conditions":[
  {"prop":"platform","op":"is","values":["Android"]},
  {"prop":"version","op":"is","values":["4.05.02"]}
]}]}
// → Premium Purchase = 7, Vote Not Buy = 3 — но реально это 1 покупка + 0 голосов от внешних юзеров
```

✅ Always add `gp:userRole is not User_Team_Member` to every segment:

```json
{"segments":[{"conditions":[
  {"prop":"platform","op":"is","values":["Android"]},
  {"prop":"version","op":"is","values":["4.05.02"]},
  {"type":"property","group_type":"User","prop_type":"user","prop":"gp:userRole","op":"is not","values":["User_Team_Member"]}
]}]}
```

For AB-test dashboards add this condition in **BOTH** variant segments (control + test). Один пропущенный сегмент = перекос только в одну сторону.

Why: prec 2026-05-26 — Android release 4.05.02 dashboard. Без фильтра внутренняя команда (≈3-5 человек) генерировала 86% Premium Purchase events, 89% Premium Try Purchase, 100% Vote Not Buy и Rate Video. На сотнях покупок team-шум размывается, но release-dashboards первых дней и AB-test первой недели **полностью некорректны**. Зафиксируй это правило для всех будущих dashboards в своём воркспейсе.

Property nuance:
- Именно `gp:userRole` с префиксом `gp:` (group property → user)
- Operator: `is not` (не `!=`)
- Value: `User_Team_Member` ровно с подчёркиваниями (не `Team Member` / `team-member`)

**Edge case:** debug-задача, явно нацеленная на проверку integration аналитики внутри команды — фильтр снять и явно об этом сказать пользователю в финальном отчёте.

**Action**: добавлять условие в `conditions[]` в каждом variant-сегменте, без исключений. Включить упоминание в glossary header dashboard'а («Фильтр: исключены тестеры команды»).

---

## 12. Glossary header is mandatory

A naked chart (just bars, no context) lets users misinterpret. Always include rich_text header with:

- Variant table (control vs test, identifier values, prices/details, traffic share)
- Metric explanation (what's measured, what formula)
- "How to read" section (B > A means..., B < A means...)
- Checkpoints (Day 1 / 7 / 30 with absolute dates)
- Statistical caveat (right-skewed → not t-test)

See `references/glossary-template.md` for the template.

---

## 13. User-property gap by platform → fallback to event-property (CRITICAL)

❌ Building an AB dashboard on `gp:<variantProperty>` without verifying it's actually populated **per platform**:

Symptoms in the diagnostic: groupBy by user-property returns only `(none)` for the target platform, while values exist on other platforms. Real example (2026-05-27):
- iOS: `specialOfferFirstPeriod` 24 uniques, `Week2to10` 36.5, `Week4to10` 30
- **Android: only `(none) = 215 uniques`** — Android client never writes the property

Root cause is almost always an **instrumentation gap**: the app's analytics helper writes only a related boolean (e.g. `isSpecialGiftOfferEnabled`) but not the variant identifier itself. iOS team may have implemented it, Android may not have — or vice versa.

✅ **Fallback: split by event-property delivered by the integration**, not by user-property delivered by the app.

For RevenueCat → Amplitude integration, every RC event carries `presented_offering_id` (the offering ID at purchase time). This works **without any app instrumentation** because RC pushes it directly:

```json
{
  "event_type": "rc_initial_purchase_event",
  "filters": [
    {"subprop_key": "environment", "subprop_op": "is", "subprop_value": ["PRODUCTION"]},
    {"subprop_key": "presented_offering_id", "subprop_op": "is", "subprop_value": ["<controlValue>", "<testValue>"]}
  ],
  "group_by": [{"type": "event", "value": "$revenue", "group_type": "User"}]
}
// Then chart-level groupBy: presented_offering_id
```

Other integrations with similar event-properties: AppsFlyer (`af_*` event-properties), Adjust (callback parameters), Branch.

**Action**: in Step 2 diagnostic, ALWAYS add `platform` as a second groupBy dimension. If the user-property is `(none)` on the target platform but values exist elsewhere, switch to event-property pattern (Template 6 in chart-templates.md). Tell the user about the instrumentation gap but do NOT block on it — event-property route is fully self-contained.

---

## 14. Pre-test subscribers inflate Baseline renewal-revenue (CRITICAL for renewal tests)

❌ Comparing Total Revenue between variants on Day 1–7 of a renewal-pricing test and concluding "Baseline wins by 3.6× — kill the test":

Real example (2026-05-27, Day 1 of test):
- Baseline `specialOfferFirstPeriod`: $22.52 total = $7.15 initial (2 purchasers) + **$15.37 renewals**
- Treatment `CasinoFirst3After8SpecialOffer`: $6.27 total = $6.27 initial (2 purchasers) + $0 renewals

That $15.37 of Baseline renewal-revenue is **not from the test cohort** — it's from old subscribers who bought `specialOfferFirstPeriod` weeks/months before the test started and just happen to renew during the test window. They share the offering id with the Baseline variant but were never assigned to the AB-test.

Treatment cannot have renewals on Day 1 because its offering id is brand-new. Comparing "all-time renewal revenue" between an old offering and a new offering on Day 1 is structurally biased toward the old one.

✅ Two corrections:

1. **Honest Day 1 comparison**: only `initial-purchase revenue per purchaser`. In the example: $7.15 / 2 = $3.58 for A, $6.27 / 2 = $3.14 for B — identical (both charge $3 in week 1), which is the **expected** state on Day 1 of a renewal-pricing test.
2. **Defer the renewal-revenue judgment** until Day ≥ subscription period. For weekly: Day 7+. For monthly: Day 30+. Treatment needs at least one renewal cycle to have non-zero renewal revenue.

Glossary header MUST include a warning like:

> **⚠️ Renewal Revenue Bias (first N days):** Baseline accumulates renewal revenue from pre-test subscribers; Treatment does not. Compare initial-purchase revenue first; total-revenue lift becomes meaningful only after Day {renewal_period}.

**Action**: include a separate "initial-revenue-only" chart for the first renewal cycle (filter to `rc_initial_purchase_event + rc_trial_converted_event`, exclude `rc_renewal_event`) so users have a clean comparison. Always include `rc_renewal_event` separately too — it tells the real story from Day {N}.

---

## 15. `newOrActive: new` + delayed user-property = empty cohort

❌ Using `newOrActive: "new"` with `groupBy gp:<variantProperty>` when the app writes that property only on second-or-later session (after RC fetch, after server response, after user grants permission):

Result: every new user in the cohort window has `(none)` for the property, because Amplitude registered them as `_new` **before** the property was set. Even if the test is running correctly and treatment users got the variant offering, your chart shows all variants = 0 and one big `(none) = N` bucket.

Real example (2026-05-27): 342 new users on Android in the test window — 100% of them in `(none)` for `gp:specialGiftOfferID`. The property writes only after `getSpecialGiftOfferConfig()` completes, which happens after `_new` is fired.

✅ Three workarounds, in order of preference:

1. **Switch to event-property** (see pitfall 13) — RC's `presented_offering_id` is on the event itself, no async-write race.
2. **Use `newOrActive: "active"`** with a behavioral entry event that fires *after* the property is set (e.g. `Special Gift Opened` instead of `_new`). Active cohort = anyone with that property value during the window, including users who became new before the window.
3. **Push the user-property write earlier** in the app code (fix the instrumentation). Only do this if the team controls the app and the feature genuinely matters — otherwise burns weeks waiting for a release.

**Action**: if Step 2 diagnostic shows `_new` cohort with all-`(none)` group, do NOT use `newOrActive: "new"` in the main chart. Use option 1 (event-property) or option 2 (`active` + behavioral entry event). Document the choice in the glossary so reviewers don't ask "why isn't this a clean new-user cohort".

---

## 16. Firebase A/B experiments aren't in the MCP — don't conclude "no method exists"

❌ Looking at `remoteconfig_get_template` (or the Firebase MCP tool list), not seeing experiments, and telling the user "Firebase A/B tests can't be pulled programmatically / aren't exposed":

The active Remote Config template only carries **base conditions** (platform/version/country/staging). Running A/B experiments are a **separate subsystem**, intentionally absent from `getRemoteConfig` AND from the Firebase MCP.

✅ They ARE retrievable via the Remote Config **experiments** REST endpoint:

- List: `GET https://firebaseremoteconfig.googleapis.com/v1/projects/{projectNumber}/namespaces/firebase/experiments?pageSize=300` → `definition.displayName`, `state` (RUNNING/DONE), `startTime`.
- Detail: `GET …/experiments/{N}` → `definition.variants[]` (name+weight = split) and `definition.objectives.eventObjectives[]` (primary metric: `total_revenue` / `retention_7` / custom). **Set your primary chart to whatever the experiment optimizes.**
- Auth when gcloud is stale/wrong-project: exchange the Firebase CLI refresh token (`~/.config/configstore/firebase-tools.json` → `tokens.refresh_token`) at `https://oauth2.googleapis.com/token` with the public Firebase-CLI client_id `<FIREBASE_CLI_CLIENT_ID>` / secret `<FIREBASE_CLI_CLIENT_SECRET>` (the well-known public Firebase CLI OAuth client — look it up in the firebase-tools source). Never print tokens.
- The response gives **variant names only** — NOT the RC-parameter overrides. Which parameter/offering/product/price differs you find empirically in Step 2.

Why: 2026-06-12 — the agent first told the user the method didn't exist; the user pushed back ("должен быть метод, проверь нормально"); `developerknowledge_answer_query` confirmed `projects.namespaces.experiments.list`. Wasted a round-trip and eroded trust.

**Action**: never assert an API/method doesn't exist from the MCP tool list alone. Check the product's REST API (and `developerknowledge_answer_query` for Firebase) before telling the user it's impossible — same rule as "don't claim a library lacks feature X without checking the network."

---

## 17. Don't assume `product_id` collapses after the intro period — verify renewal split with a diagnostic

❌ Seeing a base product id among renewals (e.g. `weekly:weekly-8usd` in a casino renewal diagnostic) and writing into the glossary "after the intro week both variants renew on a shared product → renewal revenue can't be split by variant → defer Total to Firebase":

That's a guess about store mechanics, and it's usually wrong. On Google Play an intro-priced offer is typically a **separate product** (`…-first-3usd` vs `…-first-2usd`), and `product_id` is **preserved on `rc_renewal_event`** — so renewal revenue DOES split by variant. The shared base product you saw was a *different, unrelated* subscription, not "the arms merged."

✅ Verify before writing any limitation. Run a renewal diagnostic with two-dimensional groupBy `product_id × platform`, filtered to the two variant product ids:

```json
{"event_type": "rc_renewal_event",
 "filters": [{"subprop_key":"product_id","subprop_op":"is","subprop_value":["<A_productId>","<B_productId>"],"subprop_type":"event"}],
 "groupBy": [{"type":"event","value":"product_id"},{"type":"user","value":"platform"}]}
```

If the variant product ids appear → they split; build the Total Revenue (initial+trial+renewal) chart. Treatment renewals legitimately = 0 until Day {period} (weekly → Day 7) — that's pitfall 14, NOT "no split."

Why: 2026-06-12 (casino 3→8 vs 2→8). Agent assumed collapse, shipped a glossary claiming "renewal not splittable → only Firebase," user corrected ("в гугл консоли создано 2 разных продукта, перепроверь, проверь что платформа == android"). The diagnostic confirmed `…-first-3usd; Android` renewals exist → full dashboard rebuild.

**Action**: for any store-mechanics claim (does `product_id` change on renewal? does the intro phase keep the id?), run a diagnostic — never bake a methodology limitation into the glossary from an assumption. The same diagnostic also confirms `platform` (Google Play products are Android-only, App Store iOS-only) — check it, the user will ask.

---

## 18. Use the experiment's exact launch moment as `start`, and surface test age

❌ Rounding `start` to 00:00 UTC of the launch day, or omitting how old the test is from the glossary:

For a test launched today/yesterday, day-rounding pulls in pre-launch hours, and without an explicit age the reader can't tell whether a flat chart means "no effect" or "test is 2 days old."

✅ Pull the exact `startTime` from the experiment (`experiments/{N}.startTime`, e.g. `2026-06-10T09:32:48Z` → Unix `1781083968`) and use it verbatim as `start`. In the glossary header state the **test age** ("идёт ~N дней на момент сборки") and put checkpoints as **absolute dates anchored to the real launch** (Day 7 = launch + 7d).

Why: 2026-06-12 the user flagged it twice ("обрати внимания на дату запуска теста, дашборд должен это учитывать"). A weekly-sub test on Day 2 has near-zero signal; the glossary must make that unmissable so early noise isn't read as a result.

**Action**: `start` = exact experiment launch second (not day-rounded). Glossary always carries launch timestamp + current test age + checkpoints as absolute dates from launch.

---

## 19. App Version (and other envelope fields) — group via top-level `groupBy type:user value:"version"`, NOT event group_by

❌ Trying to break a custom event down by app version through the event's own `group_by`:

```json
{"event_type":"Premium Purchase Error","group_by":[{"type":"event","value":"version"}]}      // → (none) for every row
{"event_type":"Premium Purchase Error","group_by":[{"type":"event","value":"version_name"}]}  // → "not tracked on this event_type"
// same dead end: "start_version", "versionName", "app_version_name", "[Amplitude] Version"
```

The version IS in the raw event JSON (`"version_name":"4.06.07"` at the top level), which makes the all-`(none)` result deeply confusing. `get_user_timeline` adds to the confusion — it omits the envelope `version_name` from its compact output (shows only `platform/os/device` + `eventProperties`).

✅ App version is an Amplitude **envelope** field, not an event-property. Take it via the **top-level `groupBy`** with `type:"user"` and the name **`version`**:

```json
"groupBy": [{"type": "user", "value": "version", "group_type": "User"}]
```

To **filter** by it, use a user-property segment condition: `{"type":"property","group_type":"User","prop_type":"user","prop":"version","op":"is","values":["4.06.07"]}`.

Same rule for the other envelope fields (`country`, `os`, `platform`, `start_version`, `device_type`) — they are NOT event-properties; reach them through top-level `groupBy type:"user"` (see `get_chart_definition_params` example: `groupBy:[{type:"user",value:"country",group_type:"User"}]`). Note: `[Amplitude] Version` IS populated on autocapture lifecycle events (`Application Opened/Installed`) but is empty on custom events — don't rely on it; use `version`.

Why: 2026-06-15 (an Android daily-report routine, "Premium Purchase Error" by release version). Burned several rounds grouping inside the event with `type:"event"` (all `(none)`/"not tracked") and almost concluded "the event has no version" — until the user pasted the raw event JSON showing `version_name` in the envelope. `query_dataset`'s `event` group_by validates against event-property taxonomy, where envelope fields don't exist. Full writeup: `routines/<your-report>/docs/solutions/amplitude-builtin-version-groupby-2026-06-15.md`.

**Action**: for App Version (and country/os/platform/start_version), always use top-level `groupBy {type:"user", value:"version", ...}`; never the event's `group_by` with `type:"event"`. If a built-in returns all-`(none)`, suspect wrong layer before concluding "not tracked".
