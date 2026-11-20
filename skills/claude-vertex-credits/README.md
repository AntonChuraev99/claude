# claude-vertex-credits

A Claude Code skill that runs Claude Code on **Google Vertex AI**, so usage is
billed to the monthly **Google Cloud credits** included with Google AI Pro /
Ultra subscriptions (Google Developer Program premium). Handy when your
claude.ai subscription limit runs out.

Your normal `claude` stays on the subscription. Vertex is used only when you
start Claude Code with a separate settings file — including continuing the
session that just hit the limit:

```bash
claude --continue --settings ~/.claude/vertex-credits.settings.json
```

## ⚠️ Read first: credits may not cover Claude

| Subscription | Monthly Google Cloud credit |
|---|---|
| Google AI Pro | $10 |
| Google AI Ultra 5x | $40 |
| Google AI Ultra 20x | $100 |

Source: Google Developer Program benefits FAQ, checked 2026-11-20.

Google does not state whether these credits cover **partner models** such as
Claude on Vertex AI. The $300 Free Trial credit explicitly does not. The skill
therefore:

- sends one tiny test request (< $0.001) and tells you how to confirm in
  Billing → Reports that credits covered it;
- creates a budget alert on **real (net of credits) charges** — at 0.5 and 1
  unit of the billing account currency — plus an optional gross usage cap
  ("spend only part of the credits");
- `launch` warns when the budget alert is missing.

Budgets only e-mail you, with a delay of hours. They do not stop spending.

## Install

Copy the folder into your skills directory:

```bash
git clone --depth 1 https://github.com/AntonChuraev99/claude /tmp/claude-harness
cp -r /tmp/claude-harness/skills/claude-vertex-credits ~/.claude/skills/
```

Requirements: [gcloud CLI](https://cloud.google.com/sdk/docs/install), `curl`,
bash (Git Bash on Windows), Claude Code.

## Use

Ask Claude Code: *"switch to Vertex credits"* — the skill walks through the
steps. Or run the script yourself:

```bash
S=~/.claude/skills/claude-vertex-credits/scripts/vertex.sh
bash $S doctor                                    # read-only checks
gcloud auth application-default login             # if doctor asks
bash $S setup --project my-claude-vertex --create --billing-account 0X0X0X-0X0X0X-0X0X0X
# enable the Claude models in Vertex AI Model Garden (link is printed)
bash $S smoke                                     # tiny paid request to each model
bash $S budget --billing-account 0X0X0X-0X0X0X-0X0X0X --cap 50
bash $S launch                                    # prints the claude command
```

Claim the credit first: Google Developer Program → Benefits → Google Cloud
credit → pick the billing account.

## What `setup` writes

`~/.claude/vertex-credits.settings.json` (or `$CLAUDE_CONFIG_DIR/...`):

```json
{
  "model": "sonnet",
  "env": {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "CLOUD_ML_REGION": "global",
    "ANTHROPIC_VERTEX_PROJECT_ID": "my-claude-vertex",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5"
  }
}
```

Sonnet is the default model to stretch the credits: without a pin Claude Code
on Vertex uses Opus. Use `setup --model opus` or `/model` inside the session.

## Limits

- Continuing a subscription session on Vertex is not documented by Anthropic.
  Old thinking blocks may be dropped; if the API returns a 400 about a
  signature, start a new session with `claude --settings <file>`.
- To stop spending at once: `gcloud billing projects unlink <project>` — use a
  project dedicated to Claude.
