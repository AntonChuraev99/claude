---
name: test-firebase-function
description: Smoke-test a deployed Google Cloud Function (Firebase Functions) end-to-end via curl, register-throwaway-user pattern, and Cloud Run log inspection. Reproduces production errors locally in 30 seconds without bothering the user. Use this skill whenever a Cloud Function is suspected of failing (5xx in client logcat, "didn't work" reports, after any `gcloud functions deploy`, after `firebase deploy --only functions`). Triggers on phrases like "тест функцию firebase", "test cloud function", "проверь функцию", "endpoint не отвечает", "функция возвращает 500", "почему не работает chat_completion / classify_chat_intent / analyze_and_fill_checklist". Do NOT use for: client-side bugs (those need logcat / Android Studio), local Python dev (use Functions Framework emulator), Cloud Run services that are not Firebase Functions.
allowed-tools: Bash, Read, Grep, Glob, Write, Edit
---

# Test Firebase Cloud Function — End-to-End Smoke Test

Diagnose Cloud Function (Gen 2 / Cloud Run-backed) failures **without dragging the user through a "deploy → check phone → wait for me" loop**. Replaces 5-minute round-trips with 30-second curl iterations.

## Why this exists — three latent prod-bugs caught in one session (2026-05-17)

A Phase B Cloud Function (`classify_chat_intent`) was deployed and "verified" via OPTIONS preflight + UI rendering only. Three independent bugs stacked silently:

1. **`KeyError` from Python `str.format()`** — template had JSON schema `{` `}` literally, but `.format()` parsed those as placeholders → uncaught exception → 500 → client `graceful fallback` masked it as "didn't catch your request" message.
2. **`ACCESS_TOKEN_SCOPE_INSUFFICIENT` (403 to Gemini)** — `gcloud functions deploy` without `--set-secrets` / `--set-env-vars` does NOT inherit env vars from previous revision → new revision had no `GEMINI_API_KEY` → genai fell back to service-account auth → 403.
3. **Plain-env-var anti-pattern** — even working revisions had API key as plain env var, queryable via `gcloud functions describe`. Should be Secret Manager.

Each of these was 5-second curl reproducible. None were caught by the UI smoke test. Hence this skill.

## Steps

### Step 1 — Identify the function and project

If the user named a function (e.g. "тест chat_completion"), use that name.

If not, look at `firebase-functions/main.py` (or equivalent project Python dir) and `Grep` for `@functions_framework.http` to list deployable functions. Ask the user which one only if there are 3+ candidates.

Project ID: read from `.firebaserc` or `firebase.json` in the project root. If neither exists, ask once.

Default region: `us-central1` unless project files say otherwise.

### Step 2 — Verify deploy is actually live

```bash
gcloud functions describe <FUNCTION_NAME> --region=<REGION> --gen2 \
  --format='value(state,serviceConfig.uri,updateTime,serviceConfig.environmentVariables,serviceConfig.secretEnvironmentVariables)'
```

What to check:
- `state` must be `ACTIVE` (otherwise tell user the deploy is incomplete)
- `updateTime` — confirm it's AFTER the last code change (no stale revision)
- `environmentVariables` — list of plain env vars
- `secretEnvironmentVariables` — Secret Manager bindings

**Red flag**: if the function calls Gemini (look for `genai.configure` / `os.environ.get("GEMINI_API_KEY")` in source) but neither `GEMINI_API_KEY` env var nor secret binding is present → guaranteed 403 SCOPE_INSUFFICIENT at runtime. Skip ahead to Step 6 with that hypothesis.

### Step 3 — Get a test user_id (avoid using real user data)

Register a throwaway user via `register_user` (or the project's equivalent). The device_id format `smoketest-<date>-<rand>` keeps test users distinguishable from real users in audit logs.

```bash
USER_ID=$(curl -s -X POST "https://<REGION>-<PROJECT>.cloudfunctions.net/register_user" \
  -H "Content-Type: application/json" \
  -d "{\"device_id\":\"smoketest-$(date +%Y%m%d-%H%M%S)-$$\"}" \
  | python -c "import sys,json; print(json.load(sys.stdin).get('user_id',''))")
echo "USER_ID=$USER_ID"
```

If `register_user` is missing from this project, ask the user for a test user_id once and reuse it.

### Step 4 — Build the request body (encoding-safe)

**Critical gotcha for Cyrillic / Asian text on Windows**: do NOT use `curl -d "{...кириллица...}"` directly — Windows shell mangles UTF-8 in `-d` args, causing the function to receive corrupted bytes and return `400 Invalid JSON body`.

Always write the body to a UTF-8 file first:

```bash
printf '{"user_id":"%s","text":"что ты умеешь","locale":"ru","timezone_offset_minutes":180}' "$USER_ID" > /tmp/req.json
```

Then send with `--data-binary @file` (NOT `-d`):

```bash
curl -s -i -X POST "$ENDPOINT" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @/tmp/req.json \
  --max-time 30
```

### Step 5 — Run both Latin and Cyrillic smoke tests

Latin first (isolates encoding issues from auth/logic issues), Cyrillic second (matches typical user input in this project).

If Latin succeeds but Cyrillic fails → encoding issue (revisit Step 4).
If both fail with the same error → server-side issue (Step 6).

### Step 6 — Diagnose by response pattern

Match the response body to the table below. Don't guess — these patterns are exhaustive for the issues we've actually hit in this project.

| Status | Body / pattern | Root cause | Fix |
|---|---|---|---|
| 200 | `{"success":true,...}` | None — works. | Done. |
| 400 | `"Invalid JSON body"` | Cyrillic/Unicode mangled by shell. | Use `printf > file` + `--data-binary @file` (Step 4). |
| 400 | missing field message | Client DTO doesn't match server schema. | Compare request body fields to `validate_request` / parsing block in `main.py`. |
| 402 | `"insufficient credits"` | User doc missing OR balance < cost. | Verify user_id (Step 3). Check Firestore `users/<id>.ai_credits`. |
| 403 | (from outer Cloud Function — rare) | IAM policy on the function itself. | `gcloud functions add-iam-policy-binding ... --member=allUsers --role=roles/cloudfunctions.invoker` if function is supposed to be public. |
| 500 | `"classification failed: 403 ... ACCESS_TOKEN_SCOPE_INSUFFICIENT ... generativelanguage.googleapis.com"` | Cloud Function has no `GEMINI_API_KEY` env var or secret binding → genai falls back to SA auth. | Redeploy with `--set-secrets=GEMINI_API_KEY=<secret>:latest`. See Step 8 — Secret Manager setup. |
| 500 | `KeyError: '...'` in logs (response body may say `classification failed` generically) | `str.format()` collided with literal `{` `}` in template (e.g. JSON schema in prompt). | Edit template: replace standalone `{` → `{{` and `}` → `}}` everywhere EXCEPT real placeholders. Verify with local Python: `template.format(**kwargs)`. |
| 500 | `"Internal Server Error"` with NO useful body | Read Cloud Run logs (Step 7). |
| 502 / 503 | Cold start / cloudbuild still running | Retry in 30s. If persistent — check `gcloud functions describe ... state`. |

### Step 7 — Read Cloud Run logs when response body is unhelpful

`gcloud functions logs read` shows execution metadata but often empty LOG column. Use `gcloud logging read` directly with the Cloud Run filter for the full Python traceback:

```bash
gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"<FUNCTION_NAME_WITH_HYPHENS>\" AND severity>=ERROR" \
  --limit=5 \
  --format='value(timestamp,textPayload,jsonPayload.message)'
```

Note: function name in `resource.labels.service_name` uses **hyphens**, not underscores. `classify_chat_intent` → `classify-chat-intent`.

If output is still empty, try `severity>=WARNING` to widen the filter. Cloud Function exceptions sometimes get logged at WARNING by the wrapper.

### Step 8 — Secret Manager setup (one-time, only if missing)

If Step 6 diagnosed `ACCESS_TOKEN_SCOPE_INSUFFICIENT` and the function is supposed to use Secret Manager (per project's CLAUDE.md or just for best practice), follow this one-time setup:

```bash
# 1. Get the key value from a known-working function's env var (TEMPORARY — we'll migrate it):
KEY=$(gcloud functions describe <KNOWN_WORKING_FUNCTION> --region=<REGION> --gen2 \
  --format='value(serviceConfig.environmentVariables.GEMINI_API_KEY)')

# 2. Create the secret (idempotent — skip if "AlreadyExists"):
gcloud secrets create gemini-api-key --replication-policy=automatic --project=<PROJECT> 2>/dev/null || true

# 3. Add a new version with the key value (via temp file — never echo secrets):
KEY_FILE=$(mktemp)
trap "rm -f $KEY_FILE" EXIT
printf '%s' "$KEY" > "$KEY_FILE"
gcloud secrets versions add gemini-api-key --data-file="$KEY_FILE" --project=<PROJECT>

# 4. Grant the Cloud Run runtime SA accessor role:
SA=$(gcloud projects describe <PROJECT> --format='value(projectNumber)')-compute@developer.gserviceaccount.com
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member=serviceAccount:$SA \
  --role=roles/secretmanager.secretAccessor \
  --project=<PROJECT>
```

Then redeploy the broken function with the secret bound:

```bash
gcloud functions deploy <FUNCTION_NAME> --gen2 --runtime=python312 \
  --trigger-http --allow-unauthenticated \
  --source="<ABS_PATH_TO_FUNCTIONS_DIR>" \
  --entry-point=<FUNCTION_NAME> \
  --region=<REGION> \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest \
  --project=<PROJECT> \
  --quiet
```

### Step 9 — Verify the fix

Re-run Step 5 smoke tests. If 200 → done. Otherwise loop to Step 6 with the new error pattern.

### Step 10 — Update project memory if a new pattern surfaces

If you hit an error pattern not in Step 6's table, write a one-liner memory file with the symptom + fix and link it from `MEMORY.md`. Future sessions will solve the same class of bug in seconds.

## Hard rules

- **Never `-d "raw_string_with_non_ascii"` to curl on Windows**. Always file-based body.
- **Never silently retry the same deploy 3 times** — diagnose the response, then fix once.
- **Never use the user's real user_id** for smoke tests — register a throwaway. Real user_ids would deduct production credits and pollute audit logs.
- **`gcloud functions deploy` does NOT inherit env vars from prior revisions** — you must re-pass `--set-secrets` / `--set-env-vars` on every deploy. This is the single most common cause of "worked yesterday, broken today" in this codebase.
- **`firebase deploy --only functions:<name>` may not work for Python functions** — see the project's Phase B note. Always have `gcloud functions deploy` ready as fallback for first-time Python endpoints AND for updates.
- **Always verify deploy via POST, not just OPTIONS preflight**. OPTIONS only confirms the function ACCEPTS connections; it doesn't run the handler body.

## When this skill IS NOT enough

- Race conditions / sporadic failures → enable structured logging in `main.py` (`logger.error(f"...")`) and retry diagnosis.
- Cold-start failures → `gcloud functions describe ... --format='value(serviceConfig.minInstanceCount)'`. Bumping min instances to 1 fixes but costs money.
- Auth issues on PRIVATE functions (not `--allow-unauthenticated`) → requires fetching ID token, different flow.

For all three, escalate to user with the specific data you collected.
