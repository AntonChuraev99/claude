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

## Common to all chart types

- `start`: Unix seconds at launch moment (00:00 UTC of launch date is fine if launched same day).
- `end`: `"now"` (Amplitude evaluates as current time).
- `newOrActive: "new"` — only count users who became new during the test window. Critical: pre-test users will be in both old and new variants and skew everything. **Exception**: Template 6 uses `"active"` because pre-test subscribers on Baseline offering id are a known bias to disclose in glossary, not a cohort to filter.
- `gp:` prefix on user properties in segments. Without it: "Invalid user property" error.
- Always two segments minimum (A, B) for Templates 1–5. Template 6 uses one segment + `groupBy` on event-property.
- Multi-arm tests (A/B/C/D): add more segments, but limit to ≤4 for readability.

### Unix timestamp reference (00:00 UTC, for `start` parameter)

| Date | Unix seconds |
|---|---|
| 2026-01-01 | 1767225600 |
| 2026-04-01 | 1775001600 |
| 2026-05-01 | 1777593600 |
| 2026-05-22 | 1779408000 |
| 2026-05-26 | 1779753600 |
| 2026-05-27 | 1779840000 |
| 2026-06-01 | 1780272000 |
| 2026-07-01 | 1782864000 |

Add 86400 per day. Always verify in `query_dataset` response — `"YYYY-MM-DD to YYYY-MM-DD"` should match what you intended.
