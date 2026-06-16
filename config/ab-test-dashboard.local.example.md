# ab-test-dashboard — local config (template)

The `ab-test-dashboard` skill needs values that are specific to **your** Amplitude
workspace. Do not hard-code them into the skill — keep them here, in a gitignored
local file, so the published skill stays generic.

## Setup

1. Copy this file to `~/.claude/config/ab-test-dashboard.local.md`
   (the `.local.md` suffix is ignored by `.gitignore` — it never gets committed).
2. Replace the placeholder values below with your real ones.
3. When you run the skill, ask Claude to `Read ~/.claude/config/ab-test-dashboard.local.md`
   first so it picks up your values.

## Values

```
# Amplitude project IDs where every chart segment MUST filter out internal team
# members (gp:userRole is not User_Team_Member) — otherwise test accounts skew
# small samples. Comma-separated.
YOUR_PROJECT_IDS = 111111, 222222, 333333

# Firebase project number — used to hit the Remote Config experiments REST API
# (GET .../v1/projects/{projectNumber}/namespaces/firebase/experiments).
FIREBASE_PROJECT_NUMBER = 123456789012
```
