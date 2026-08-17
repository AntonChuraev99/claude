# Chart Templates by Test Type

JSON-ready definitions to pass to `mcp__plugin_amplitude_amplitude__query_dataset`. Replace placeholders `<...>` with values gathered in Step 1.

---

## 1. Revenue / ARPU (pricing, offer, paywall A/B)

**Use when**: test changes price, offer composition, paywall layout, or anything where revenue is the success criterion.

**Formula**: `(PROPSUM(A)+PROPSUM(B))/UNIQUES(C)` — A,B = RC purchase events, C = `_new` (Amplitude system event for new users). Result = ARPU per new user in variant.

```json
{
  "type": "eventsSegmentation",
  "app": "<projectId>",
  "vis": "bar",
  "name": "A/B <test name> — ARPU per new user",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "events": [
      {
        "event_type": "rc_initial_purchase_event",
        "filters": [{"group_type": "User", "subfilters": [], "subprop_op": "is", "subprop_key": "environment", "subprop_type": "event", "subprop_value": ["PRODUCTION"]}],
        "group_by": [{"type": "event", "value": "$revenue", "group_type": "User"}]
      },
      {
        "event_type": "rc_trial_converted_event",
        "filters": [{"group_type": "User", "subfilters": [], "subprop_op": "is", "subprop_key": "environment", "subprop_type": "event", "subprop_value": ["PRODUCTION"]}],
        "group_by": [{"type": "event", "value": "$revenue", "group_type": "User"}]
      },
      {"event_type": "_new", "filters": [], "group_by": []}
    ],
    "metric": "formula",
    "formula": "(PROPSUM(A)+PROPSUM(B))/UNIQUES(C)",
    "groupBy": [],
    "interval": 1,
    "newOrActive": "new",
    "countGroup": "User",
    "eventAbstraction": "Event",
    "segments": [
      {
        "name": "A - <controlLabel>",
        "label": "A - <controlLabel>",
        "conditions": [
          {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
          {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<controlValue>"], "prop_type": "user", "group_type": "User"}
        ]
      },
      {
        "name": "B - <testLabel>",
        "label": "B - <testLabel>",
        "conditions": [
          {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
          {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<testValue>"], "prop_type": "user", "group_type": "User"}
        ]
      }
    ]
  }
}
```

**If trial-only flow** (offer has free trial → most users go through `rc_trial_started_event` then `rc_trial_converted_event`): formula simplifies to `PROPSUM(A)/UNIQUES(B)` with A = `rc_trial_converted_event`, B = `_new`.

**If non-subscription IAP** (consumables, lifetime): use `rc_non_subscription_purchase_event` instead of `rc_initial_purchase_event`.

---

## 2. Conversion Rate (UI / copy / CTA A/B)

**Use when**: test changes a button, layout, copy, or removes/adds a step on a paywall/onboarding screen — and you want to know which version converts more users to the next step.

```json
{
  "type": "funnels",
  "app": "<projectId>",
  "vis": "bar",
  "name": "A/B <test name> — Conversion Rate",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "mode": "ordered",
    "events": [
      {"event_type": "<entryEvent>", "filters": [], "group_by": []},
      {"event_type": "<successEvent>", "filters": [], "group_by": []}
    ],
    "metric": "CONVERSION",
    "groupBy": [],
    "interval": 1,
    "newOrActive": "new",
    "countGroup": "User",
    "conversionSeconds": 86400,
    "funnelNewUserType": "SAME_DAY",
    "segments": [
      {"name": "A - <controlLabel>", "label": "A - <controlLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<controlValue>"], "prop_type": "user", "group_type": "User"}
      ]},
      {"name": "B - <testLabel>", "label": "B - <testLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<testValue>"], "prop_type": "user", "group_type": "User"}
      ]}
    ]
  }
}
```

**`conversionSeconds`**:
- 3600 (1 hour) — same-session conversions
- 86400 (1 day) — typical for paywall/onboarding
- 604800 (7 days) — for slower funnels

**Anti-pattern**: don't use behavioral subprop conditions on a Sign Up Success-style event for variant version segmentation — Sign Up Success fires on every login and inflates the cohort. Use a top-level user-property segment instead (this skill's default).

---

## 3. Activation / Onboarding (key action within N days)

**Use when**: testing changes to onboarding flow itself. Success = % of new users who complete a key activation event (e.g. first core action, first content view, etc.) within N days.

```json
{
  "type": "funnels",
  "app": "<projectId>",
  "vis": "bar",
  "name": "A/B <test name> — Activation Rate",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "mode": "ordered",
    "events": [
      {"event_type": "_new", "filters": [], "group_by": []},
      {"event_type": "<activationEvent>", "filters": [], "group_by": []}
    ],
    "metric": "CONVERSION",
    "groupBy": [],
    "interval": 1,
    "newOrActive": "new",
    "countGroup": "User",
    "conversionSeconds": 604800,
    "funnelNewUserType": "SAME_DAY",
    "segments": [
      {"name": "A - <controlLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<controlValue>"], "prop_type": "user", "group_type": "User"}
      ]},
      {"name": "B - <testLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<testValue>"], "prop_type": "user", "group_type": "User"}
      ]}
    ]
  }
}
```

`conversionSeconds: 604800` = 7 days (standard activation window). Adjust for app context.

---

## 4. Retention (return after N days)

**Use when**: testing changes that affect retention or churn — e.g. notification frequency, content quality, paywall friction.

```json
{
  "type": "retention",
  "app": "<projectId>",
  "name": "A/B <test name> — N-day Retention",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "se": [{"event_type": "<startEvent>", "filters": [], "group_by": []}],
    "re": [{"event_type": "<returnEvent>", "filters": [], "group_by": []}],
    "interval": 1,
    "countGroup": "User",
    "newOrActive": "new",
    "segments": [
      {"name": "A - <controlLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<controlValue>"], "prop_type": "user", "group_type": "User"}
      ]},
      {"name": "B - <testLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<testValue>"], "prop_type": "user", "group_type": "User"}
      ]}
    ]
  }
}
```

Common pairs:
- `se = _new`, `re = _active` → general N-day retention
- `se = Sign Up Success`, `re = Premium Purchase` → conversion to paid over time
- `se = Onboarding Completed`, `re = Start Generation` → engagement retention

---

## 5. Engagement (uniques + frequency)

**Use when**: testing a new feature or section, want to see if more users use it AND if they use it more often per user.

```json
{
  "type": "eventsSegmentation",
  "app": "<projectId>",
  "vis": "bar",
  "name": "A/B <test name> — Engagement (uniques)",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "events": [{"event_type": "<featureEvent>", "filters": [], "group_by": []}],
    "metric": "uniques",
    "groupBy": [],
    "interval": 1,
    "newOrActive": "new",
    "countGroup": "User",
    "eventAbstraction": "Event",
    "segments": [
      {"name": "A - <controlLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<controlValue>"], "prop_type": "user", "group_type": "User"}
      ]},
      {"name": "B - <testLabel>", "conditions": [
        {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
        {"op": "is", "prop": "gp:<variantPropertyName>", "type": "property", "values": ["<testValue>"], "prop_type": "user", "group_type": "User"}
      ]}
    ]
  }
}
```

For "events per user" (frequency) on the same chart: change `metric` to `"average"` (events per user) — gives you per-user usage intensity.

---

## 6. Revenue by event-property (RC `presented_offering_id` fallback)

**Use when**: app doesn't write a user-property identifying the variant (pitfall 13), OR `_new` cohort with the user-property is all `(none)` (pitfall 15) — typical for **Firebase A/B Testing** tests, whose variant assignment is never pushed to Amplitude. RC pushes purchase event-properties natively — no app instrumentation needed.

**Which event-property to split by — run the Step-2 diagnostic grouping by BOTH and pick the clean one:**
- `presented_offering_id` — works when the **offering** differs between variants. But on a chunk of purchases it can be `(none)` (offering id not always propagated) — don't split by it blindly.
- **`product_id`** — for **Google Play price-point tests** this is usually the clean separator: each price point is a distinct Play product (e.g. `weekly:weekly-8usd-first-3usd` vs `weekly:weekly-8usd-first-2usd`). It is **preserved on `rc_renewal_event`**, so it splits renewal revenue too (verify with the pitfall-17 diagnostic — don't assume it collapses to a base product after the intro week). Substitute `product_id` for `presented_offering_id` everywhere below when that's the clean axis.

**Key differences from Template 1 (Revenue/ARPU):**
- Variant split is NOT in `segments` — it's in event `filters` (`presented_offering_id IN [Baseline, Treatment]`).
- Chart-level `groupBy` is `presented_offering_id` (event property), not segments.
- One segment globally for `platform` + team-member filter; variants appear as groupBy bars.
- `newOrActive: "active"` — pre-test subscribers on Baseline offering id will inflate renewal revenue on Day 1–7 (pitfall 14); glossary must warn the reader.

```json
{
  "type": "eventsSegmentation",
  "app": "<projectId>",
  "vis": "bar",
  "name": "A/B <test name> — Total Revenue per offering",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "events": [
      {
        "event_type": "rc_initial_purchase_event",
        "filters": [
          {"group_type": "User", "subprop_key": "environment", "subprop_op": "is", "subprop_value": ["PRODUCTION"]},
          {"group_type": "User", "subprop_key": "presented_offering_id", "subprop_op": "is", "subprop_value": ["<controlValue>", "<testValue>"]}
        ],
        "group_by": [{"type": "event", "value": "$revenue", "group_type": "User"}]
      },
      {
        "event_type": "rc_trial_converted_event",
        "filters": [
          {"group_type": "User", "subprop_key": "environment", "subprop_op": "is", "subprop_value": ["PRODUCTION"]},
          {"group_type": "User", "subprop_key": "presented_offering_id", "subprop_op": "is", "subprop_value": ["<controlValue>", "<testValue>"]}
        ],
        "group_by": [{"type": "event", "value": "$revenue", "group_type": "User"}]
      },
      {
        "event_type": "rc_renewal_event",
        "filters": [
          {"group_type": "User", "subprop_key": "environment", "subprop_op": "is", "subprop_value": ["PRODUCTION"]},
          {"group_type": "User", "subprop_key": "presented_offering_id", "subprop_op": "is", "subprop_value": ["<controlValue>", "<testValue>"]}
        ],
        "group_by": [{"type": "event", "value": "$revenue", "group_type": "User"}]
      }
    ],
    "metric": "formula",
    "formula": "PROPSUM(A)+PROPSUM(B)+PROPSUM(C)",
    "groupBy": [{"type": "event", "value": "presented_offering_id"}],
    "interval": 1,
    "newOrActive": "active",
    "countGroup": "User",
    "eventAbstraction": "Event",
    "segments": [
      {
        "name": "<Platform>, no team",
        "label": "<Platform>, no team",
        "time_type": "all",
        "conditions": [
          {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
          {"op": "is not", "prop": "gp:userRole", "type": "property", "values": ["User_Team_Member"], "prop_type": "user", "group_type": "User"}
        ]
      }
    ]
  }
}
```

**Recommended companion charts for an event-property dashboard:**

1. **Total Revenue per offering** (above) — primary, with pre-test renewal warning in glossary.
2. **Unique purchasers per offering** — `metric: "uniques"` on `rc_initial_purchase_event` (with the same `presented_offering_id` filter), `groupBy presented_offering_id`. Shows split balance + sample size.
3. **Renewal revenue per offering** — same as Total Revenue but only `rc_renewal_event`. This is the hypothesis-core chart for renewal-pricing tests; treatment will be $0 until Day 7 (weekly) / Day 30 (monthly) — expected and stated in glossary.
4. (optional) **Initial-only revenue per offering** — `PROPSUM(rc_initial)+PROPSUM(rc_trial_converted)` only, excluding renewals. Honest Day 1 comparison free of pre-test renewal bias.

**When NOT to use this template**: if the app DOES write a clean user-property and Step 2 diagnostic shows real values on the target platform, prefer Templates 1–5 (user-property segments) — they isolate the AB cohort correctly and avoid pre-test subscriber contamination.

---

## 7. Downstream funnel split by variant event-property (no exposure denominator)

**Use when**: the variant param exists only on downstream (purchase-ish) events, so there is no
marked impression event to serve as the denominator (pitfall 22b). Both funnel steps must be events
that carry the param — that's what makes the rate honest.

Split via `byProp` (NOT two segments) so the legend renders the property's own values
automatically — no UI rename needed (see SKILL Step 4).

```json
{
  "type": "funnels",
  "app": "<projectId>",
  "name": "A/B <test> — <stepA> → <stepB> CR by variant",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "mode": "ordered",
    "events": [
      {"event_type": "<markedEntryEvent>", "filters": [], "group_by": []},
      {"event_type": "<markedSuccessEvent>", "filters": [], "group_by": []}
    ],
    "metric": "CONVERSION",
    "byProp": "<variantPropertyName>",
    "byPropIndex": 0,
    "byPropType": "event",
    "interval": 1,
    "countGroup": "User",
    "conversionSeconds": 86400,
    "segments": [{"time_type": "all", "conditions": [
      {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
      {"op": "is not", "prop": "gp:userRole", "type": "property", "values": ["User_Team_Member"], "prop_type": "user", "group_type": "User"}
    ]}]
  }
}
```

`byPropIndex` = index of the funnel step whose property does the splitting (0 = first step).
Filter the `(none)` series out of the reading — it's users the param never reached.

---

## 8. Intent ratio B/A against the split-implied baseline

**Use when**: you need a single "is B pulling ahead" number on the earliest marked event, with no
denominator available. Compare the plotted value against the baseline the traffic split implies:
50/50 → **1.0**, 67/33 → **0.49**, 80/20 → **0.25**.

```json
{
  "type": "eventsSegmentation",
  "app": "<projectId>",
  "name": "A/B <test> — intent ratio B/A (baseline <X>)",
  "params": {
    "start": <launch_unix_seconds>,
    "end": "now",
    "interval": 1,
    "events": [
      {"event_type": "<markedEvent>", "filters": [{"group_type": "User", "subprop_key": "<variantPropertyName>", "subprop_op": "is", "subprop_type": "event", "subprop_value": ["<testValue>"]}], "group_by": []},
      {"event_type": "<markedEvent>", "filters": [{"group_type": "User", "subprop_key": "<variantPropertyName>", "subprop_op": "is", "subprop_type": "event", "subprop_value": ["<controlValue>"]}], "group_by": []}
    ],
    "metric": "formula",
    "formula": "UNIQUES(A)/UNIQUES(B)",
    "groupBy": [],
    "countGroup": "User",
    "eventAbstraction": "Event",
    "segments": [{"time_type": "all", "conditions": [
      {"op": "is", "prop": "platform", "type": "property", "values": ["<Platform>"], "prop_type": "user", "group_type": "User"},
      {"op": "is not", "prop": "gp:userRole", "type": "property", "values": ["User_Team_Member"], "prop_type": "user", "group_type": "User"}
    ]}]
  }
}
```

On thin daily volume this ratio is violently noisy (a day with 1 and 0 gives ∞ or 0) — read the
cumulative/period value, not the daily line, and say so in the glossary.

**Treatment-on-treated variant**: same definition with `<variantPropertyName>` swapped for the
"was actually shown" param. The gap between the two is the dilution — report it as a number
(e.g. "9 flagged, only 5 actually saw the feature → 44% of the treatment arm is untreated").

---

## Common to all chart types

- `start`: Unix seconds at launch moment (00:00 UTC of launch date is fine if launched same day).
- `end`: `"now"` (Amplitude evaluates as current time).
- `newOrActive: "new"` — only count users who became new during the test window. Critical: pre-test users will be in both old and new variants and skew everything. **Exception**: Template 6 uses `"active"` because pre-test subscribers on Baseline offering id are a known bias to disclose in glossary, not a cohort to filter.
- `gp:` prefix on user properties in segments. Without it: "Invalid user property" error.
- Always two segments minimum (A, B) for Templates 1–5. Template 6 uses one segment + `groupBy` on event-property.
- Multi-arm tests (A/B/C/D): add more segments, but limit to ≤4 for readability.

### Unix timestamp for `start` — compute it, don't look it up

A hardcoded table rots (this one did). Anchor: **2026-01-01 00:00 UTC = 1767225600**, +86400/day.
Or just pass an ISO string — `start` accepts `"2026-08-10T00:00:00Z"` and coerces it (and
`"now-7d"` style relatives). Prefer the exact experiment launch second when you have it
(pitfall 18).

Always verify against the response: the first datapoint's `xValue` must equal your intended start.
If it's *earlier*, `interval` snapped the bucket backwards — see pitfall 22a.
