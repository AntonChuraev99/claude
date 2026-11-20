#!/usr/bin/env bash
# claude-vertex-credits: run Claude Code on Google Vertex AI so usage is paid
# from Google Cloud credits (Google AI Pro / Ultra -> Google Developer Program).
# The default `claude` stays on the claude.ai subscription; Vertex is used only
# when Claude Code starts with `--settings <this skill's settings file>`.
set -euo pipefail

# Model IDs on Vertex (global endpoint). Update here when new models ship.
OPUS_ID="claude-opus-5-5"
SONNET_ID="claude-sonnet-5-5"
HAIKU_ID="claude-haiku-5-5"
REGION="global"
ANTHROPIC_VERSION="vertex-2023-10-16"

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS_FILE="$CONFIG_DIR/vertex-credits.settings.json"

usage() {
  cat <<'EOF'
Usage: vertex.sh <command> [options]

  doctor  [--project P]       read-only checks: gcloud, ADC, project, billing,
                              Vertex AI API, settings file. Spends nothing.
  setup   --project P [--create --billing-account B] [--model sonnet|opus]
                              enable the Vertex AI API and write the settings
                              file. --create: create project P and link it to
                              billing account B (recommended: a dedicated
                              project only for Claude).
  smoke   [--project P] [--model-id ID]
                              one tiny request (8 output tokens) to each pinned
                              model, or only to ID. Costs well under $0.001.
  budget  --billing-account B [--project P] [--cap AMOUNT]
                              budget alert on the first real (net of credits)
                              charge; --cap adds an alert when gross usage
                              reaches AMOUNT (billing account currency).
  launch                      print the commands that start Claude Code on
                              Vertex (continue the last session or a new one)

--project defaults to the project in the settings file.
Exit codes: 0 ok, 2 bad arguments, 3 missing tool, 4 auth problem,
5 gcloud/API call failed, 6 a check failed.
EOF
}

die() { echo "error: $2" >&2; exit "$1"; }

need_value() { [ -n "${2:-}" ] && [ "${2#--}" = "$2" ] || die 2 "$1 needs a value"; }

CMD="${1:-}"
[ $# -gt 0 ] && shift
PROJECT="" BILLING="" CREATE=0 MODEL="sonnet" MODEL_ID="" CAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) need_value "$1" "${2:-}"; PROJECT="$2"; shift 2 ;;
    --billing-account) need_value "$1" "${2:-}"; BILLING="$2"; shift 2 ;;
    --create) CREATE=1; shift ;;
    --model) need_value "$1" "${2:-}"; MODEL="$2"; shift 2 ;;
    --model-id) need_value "$1" "${2:-}"; MODEL_ID="$2"; shift 2 ;;
    --cap) need_value "$1" "${2:-}"; CAP="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 2 "unknown option: $1" ;;
  esac
done

# --- validation -------------------------------------------------------------

project_from_settings() {
  [ -f "$SETTINGS_FILE" ] || return 0
  sed -n 's/.*"ANTHROPIC_VERTEX_PROJECT_ID": *"\([^"]*\)".*/\1/p' "$SETTINGS_FILE" | head -n1
}

require_project() {
  [ -n "$PROJECT" ] || PROJECT="$(project_from_settings)"
  [ -n "$PROJECT" ] || die 2 "no project: pass --project P or run setup first"
  printf '%s' "$PROJECT" | grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' \
    || die 2 "invalid project id: $PROJECT"
}

require_billing() {
  [ -n "$BILLING" ] || die 2 "--billing-account is required (gcloud billing accounts list)"
  BILLING="$(printf '%s' "${BILLING#billingAccounts/}" | tr '[:lower:]' '[:upper:]')"
  printf '%s' "$BILLING" | grep -Eq '^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$' \
    || die 2 "invalid billing account id: $BILLING"
}

require_gcloud() {
  command -v gcloud >/dev/null 2>&1 \
    || die 3 "gcloud not found. Install: https://cloud.google.com/sdk/docs/install"
}

native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

model_garden_url() {
  echo "https://console.cloud.google.com/vertex-ai/model-garden?project=$PROJECT"
}

# --- doctor -----------------------------------------------------------------

row() { printf '  %-4s %-22s %s\n' "$1" "$2" "$3"; }

cmd_doctor() {
  require_gcloud
  local failed=0 account billing_line billing_id api
  echo "claude-vertex-credits doctor"

  account="$(gcloud config get-value account 2>/dev/null || true)"
  if [ -n "$account" ]; then row ok "gcloud account" "$account"
  else row FAIL "gcloud account" "run: gcloud auth login"; failed=1; fi

  if gcloud auth application-default print-access-token >/dev/null 2>&1; then
    row ok "ADC credentials" "Claude Code will use them"
  else
    row FAIL "ADC credentials" "run: gcloud auth application-default login"; failed=1
  fi

  if command -v claude >/dev/null 2>&1; then row ok "claude CLI" "$(claude --version 2>/dev/null | head -n1)"
  else row FAIL "claude CLI" "not on PATH"; failed=1; fi

  [ -n "$PROJECT" ] || PROJECT="$(project_from_settings)"
  if [ -z "$PROJECT" ]; then
    row FAIL "project" "pass --project P or run setup"
    exit 6
  fi
  require_project

  if gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null 2>&1; then
    row ok "project" "$PROJECT"
  else
    row FAIL "project" "$PROJECT not found or no access"; exit 6
  fi

  billing_line="$(gcloud billing projects describe "$PROJECT" \
    --format='value(billingEnabled,billingAccountName)' 2>/dev/null || true)"
  billing_id="${billing_line##*billingAccounts/}"
  case "$billing_line" in
    True*) row ok "billing" "account $billing_id" ;;
    *) row FAIL "billing" "not linked: gcloud billing projects link $PROJECT --billing-account=<B>"; failed=1; billing_id="" ;;
  esac

  api="$(gcloud services list --enabled --project "$PROJECT" \
    --filter='config.name=aiplatform.googleapis.com' --format='value(config.name)' 2>/dev/null || true)"
  if [ -n "$api" ]; then row ok "Vertex AI API" "enabled"
  else row FAIL "Vertex AI API" "run: vertex.sh setup --project $PROJECT"; failed=1; fi

  if [ -f "$SETTINGS_FILE" ] && grep -q "\"$PROJECT\"" "$SETTINGS_FILE"; then
    row ok "settings file" "$(native_path "$SETTINGS_FILE")"
  else
    row FAIL "settings file" "missing or for another project: run setup"; failed=1
  fi

  echo
  echo "Not checked by this script (no API for it):"
  echo "  - Claude models enabled in Model Garden: $(model_garden_url)"
  echo "  - credits on the billing account and whether they cover Claude"
  if [ -n "$billing_id" ]; then
    echo "    usage by SKU with credits: https://console.cloud.google.com/billing/$billing_id/reports;grouping=GROUP_BY_SKU;projects=$PROJECT"
  fi
  [ "$failed" = 0 ] || exit 6
}

# --- setup ------------------------------------------------------------------

write_settings() {
  local tmp
  mkdir -p "$CONFIG_DIR"
  tmp="$SETTINGS_FILE.tmp"
  cat >"$tmp" <<EOF
{
  "model": "$MODEL",
  "env": {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "CLOUD_ML_REGION": "$REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID": "$PROJECT",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "$OPUS_ID",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "$SONNET_ID",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "$HAIKU_ID"
  }
}
EOF
  if [ -f "$SETTINGS_FILE" ] && ! cmp -s "$tmp" "$SETTINGS_FILE"; then
    cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"
    echo "previous settings saved to $(native_path "$SETTINGS_FILE.bak")"
  fi
  mv "$tmp" "$SETTINGS_FILE"
  echo "settings written: $(native_path "$SETTINGS_FILE")"
}

cmd_setup() {
  require_gcloud
  [ -n "$PROJECT" ] || die 2 "--project is required"
  require_project
  case "$MODEL" in sonnet|opus) ;; *) die 2 "--model must be sonnet or opus" ;; esac

  if [ "$CREATE" = 1 ]; then
    require_billing
    if gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
      die 2 "project $PROJECT already exists: pick a new id for --create, or run setup without --create (billing of an existing project is not touched)"
    fi
    gcloud projects create "$PROJECT" --name="Claude via Vertex" \
      || die 5 "project create failed (id taken globally? pick another)"
    gcloud billing projects link "$PROJECT" --billing-account="$BILLING" \
      || die 5 "billing link failed (need Billing Account User on $BILLING)"
  elif [ -n "$BILLING" ]; then
    die 2 "--billing-account without --create: link billing yourself, setup does not move existing projects between accounts"
  fi

  gcloud services enable aiplatform.googleapis.com --project "$PROJECT" \
    || die 5 "could not enable aiplatform.googleapis.com (is billing linked?)"
  write_settings

  cat <<EOF

Next:
  1. Enable the Claude models in Model Garden (search "Claude", open each
     model you pinned, press Enable): $(model_garden_url)
     Pinned: $OPUS_ID, $SONNET_ID, $HAIKU_ID
  2. vertex.sh smoke      (tiny paid request, < \$0.001)
  3. vertex.sh budget --billing-account <B>
  4. vertex.sh launch
EOF
}

# --- smoke ------------------------------------------------------------------

smoke_one() {
  local model="$1" token="$2" url body resp code text
  url="https://aiplatform.googleapis.com/v1/projects/$PROJECT/locations/$REGION/publishers/anthropic/models/$model:rawPredict"
  body='{"anthropic_version":"'"$ANTHROPIC_VERSION"'","max_tokens":8,"messages":[{"role":"user","content":"Reply with the word OK."}]}'
  resp="$(curl -sS -w '\n%{http_code}' -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    --data "$body" "$url" 2>&1)" || true
  code="${resp##*$'\n'}"
  text="${resp%$'\n'*}"
  case "$code" in
    200) row ok "$model" "$(printf '%s' "$text" | tr -d '\n' | cut -c1-160)"; return 0 ;;
    403) row FAIL "$model" "403: model not enabled in Model Garden, API off, or no roles/aiplatform.user" ;;
    404) row FAIL "$model" "404: model id unknown on the $REGION endpoint or not enabled" ;;
    429) row FAIL "$model" "429: quota. Request more in IAM & Admin -> Quotas (filter: anthropic)" ;;
    *) row FAIL "$model" "HTTP $code" ;;
  esac
  printf '%s\n' "$text" | head -c 600 >&2; echo >&2
  return 1
}

cmd_smoke() {
  require_gcloud
  require_project
  command -v curl >/dev/null 2>&1 || die 3 "curl not found"
  local token models failed=0 m
  token="$(gcloud auth application-default print-access-token 2>/dev/null)" \
    || die 4 "no ADC credentials: run gcloud auth application-default login"
  if [ -n "$MODEL_ID" ]; then
    printf '%s' "$MODEL_ID" | grep -Eq '^claude-[a-z0-9.@-]+$' || die 2 "invalid --model-id"
    models="$MODEL_ID"
  else
    models="$HAIKU_ID $SONNET_ID $OPUS_ID"
  fi
  echo "smoke: project $PROJECT, endpoint $REGION"
  for m in $models; do smoke_one "$m" "$token" || failed=1; done
  [ "$failed" = 0 ] || exit 6
  cat <<EOF

The request is billed to the project's billing account. In 1-2 days check
that credits covered it: Billing -> Reports, project $PROJECT, group by SKU,
the Claude rows must show a negative "Credits" value equal to the cost.
EOF
}

# --- budget -----------------------------------------------------------------

create_budget() {
  local name="$1"; shift
  local existing
  existing="$(gcloud billing budgets list --billing-account="$BILLING" \
    --billing-project="$PROJECT" --filter="displayName=\"$name\"" \
    --format='value(name)' 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    echo "budget exists: $name"
    return 0
  fi
  gcloud billing budgets create --billing-account="$BILLING" \
    --billing-project="$PROJECT" --display-name="$name" \
    --filter-projects="projects/$PROJECT" "$@" \
    || die 5 "budget create failed (need Billing Account Costs Manager or Administrator on $BILLING)"
  echo "budget created: $name"
}

cmd_budget() {
  require_gcloud
  require_project
  require_billing
  if [ -n "$CAP" ]; then
    printf '%s' "$CAP" | grep -Eq '^[0-9]+([.][0-9]+)?$' || die 2 "--cap must be a number"
  fi
  gcloud services enable billingbudgets.googleapis.com --project "$PROJECT" \
    || die 5 "could not enable billingbudgets.googleapis.com"

  # Net cost after credits: alerts at 0.5 and 1 unit of real charge (billing
  # account currency) if credits do not cover Claude or run out.
  create_budget "claude-vertex $PROJECT: first real charge" \
    --budget-amount=1 --credit-types-treatment=include-all-credits \
    --threshold-rule=percent=0.5 --threshold-rule=percent=1.0

  if [ -n "$CAP" ]; then
    # Gross usage before credits: "spend only part of the credits" limit.
    create_budget "claude-vertex $PROJECT: usage cap $CAP" \
      --budget-amount="$CAP" --credit-types-treatment=exclude-all-credits \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 \
      --threshold-rule=percent=1.0
  fi

  cat <<EOF

Budgets only send e-mail to the billing account admins, with a delay of hours.
They do not stop spending. Hard stop: gcloud billing projects unlink $PROJECT
(only safe for a project used for Claude alone).
EOF
}

# --- launch -----------------------------------------------------------------

budget_status() {
  # Prints a warning when the project has no budget from `vertex.sh budget`.
  local billing_line billing_id found
  command -v gcloud >/dev/null 2>&1 || { echo "WARNING: gcloud not found, budget not checked"; return 0; }
  billing_line="$(gcloud billing projects describe "$PROJECT" \
    --format='value(billingAccountName)' 2>/dev/null || true)"
  billing_id="${billing_line##*billingAccounts/}"
  if [ -z "$billing_id" ]; then
    echo "WARNING: could not read the billing account of $PROJECT, budget not checked"
    return 0
  fi
  found="$(gcloud billing budgets list --billing-account="$billing_id" \
    --billing-project="$PROJECT" \
    --filter="displayName=\"claude-vertex $PROJECT: first real charge\"" \
    --format='value(name)' 2>/dev/null || true)"
  if [ -z "$found" ]; then
    echo "WARNING: no budget alert for $PROJECT. Run first: vertex.sh budget --billing-account $billing_id"
  else
    echo "budget alert: present"
  fi
}

cmd_launch() {
  [ -f "$SETTINGS_FILE" ] || die 6 "no settings file: run setup first"
  local p
  p="$(native_path "$SETTINGS_FILE")"
  PROJECT="$(project_from_settings)"
  [ -n "$PROJECT" ] && budget_status
  cat <<EOF
Until Billing -> Reports shows credits covering the Claude rows, treat this
usage as possibly paid with real money.

EOF
  cat <<EOF
Continue the last session on Vertex (run in a new terminal, same directory):
  claude --continue --settings "$p"

New session on Vertex:
  claude --settings "$p"

Inside, /status must show "API provider: Google Vertex AI".
Plain \`claude\` keeps using the subscription.
EOF
}

case "$CMD" in
  doctor) cmd_doctor ;;
  setup) cmd_setup ;;
  smoke) cmd_smoke ;;
  budget) cmd_budget ;;
  launch) cmd_launch ;;
  ""|-h|--help|help) usage ;;
  *) usage >&2; die 2 "unknown command: $CMD" ;;
esac
