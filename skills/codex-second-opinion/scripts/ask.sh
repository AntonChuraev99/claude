#!/usr/bin/env bash
# Ask Codex CLI (GPT model family) for an independent second opinion: a diff
# review, a bug diagnosis, a plan critique or a free question. Codex runs in a
# read-only sandbox and is billed to the ChatGPT subscription the CLI is logged
# in with; an API-key login is refused because it bills per token.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: ask.sh --mode review [--base <branch> | --uncommitted | --commit <sha>] [--cd <dir>] [--timeout <sec>] [-- <extra instructions>]
       ask.sh --mode debug|plan|ask [--cd <dir>] [--timeout <sec>] (--prompt-file <file> | -- <prompt>)
EOF
  exit 2
}

# Default stays below the 600 s ceiling of the agent's Bash tool, so the
# script's own timeout fires first and its log tail reaches the agent.
mode=""; dir="$PWD"; prompt=""; prompt_file=""; timeout_s=540
base=""; uncommitted=0; commit=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode|--cd|--prompt-file|--timeout|--base|--commit)
      [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#-}" = "$2" ] || { echo "codex-second-opinion: $1 needs a value" >&2; usage; } ;;
  esac
  case "$1" in
    --mode) mode="$2"; shift 2 ;;
    --cd) dir="$2"; shift 2 ;;
    --prompt-file) prompt_file="$2"; shift 2 ;;
    --timeout) timeout_s="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --commit) commit="$2"; shift 2 ;;
    --uncommitted) uncommitted=1; shift ;;
    --) shift; prompt="$*"; break ;;
    *) usage ;;
  esac
done
if [ -n "$prompt_file" ]; then
  [ -f "$prompt_file" ] || { echo "codex-second-opinion: prompt file not found: $prompt_file" >&2; exit 2; }
  prompt="$(cat -- "$prompt_file")"
fi
[ -d "$dir" ] || { echo "codex-second-opinion: directory not found: $dir" >&2; exit 2; }
case "$timeout_s" in
  ''|*[!0-9]*) timeout_s=0 ;;
esac
timeout_s=$((10#$timeout_s))
[ "$timeout_s" -gt 0 ] || { echo "codex-second-opinion: --timeout must be a positive number of seconds" >&2; exit 2; }

targets=0
[ -n "$base" ] && targets=$((targets + 1))
[ -n "$commit" ] && targets=$((targets + 1))
[ "$uncommitted" = 1 ] && targets=$((targets + 1))
case "$mode" in
  review)
    [ "$targets" -le 1 ] || { echo "codex-second-opinion: pick one of --base, --uncommitted, --commit" >&2; exit 2; }
    [ "$targets" = 1 ] || base="origin/main" ;;
  debug|plan|ask)
    [ "$targets" = 0 ] || { echo "codex-second-opinion: --base/--uncommitted/--commit work only with --mode review" >&2; exit 2; }
    [ -n "$prompt" ] || { echo "codex-second-opinion: --mode $mode needs a prompt" >&2; usage; } ;;
  *) usage ;;
esac

command -v codex >/dev/null 2>&1 || {
  echo "codex-second-opinion: Codex CLI not found. Install: npm i -g @openai/codex" >&2; exit 3; }

status="$(codex login status 2>&1 || true)"
case "$status" in
  *"using ChatGPT"*) ;;
  *) echo "codex-second-opinion: Codex is not logged in with ChatGPT (status: $status). Ask the user to run: codex login" >&2; exit 4 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

common="You give an independent second opinion to another AI agent. Do not edit files and do not run commands that change anything. Read the code you need. Back every claim with file:line. If you are not sure, say so and say what would confirm it. Answer in Russian, briefly. Privacy: do not read files that git ignores (check with 'git check-ignore') and never read files named *.local.*, .env*, *credentials* or *secret*."

case "$mode" in
  review)
    # codex exec review rejects a custom prompt together with
    # --base/--commit/--uncommitted, and the built-in preset would not get the
    # privacy rule from $common. So the target is always named in the prompt.
    # Scope matches the preset: the working tree against the merge base, so
    # uncommitted edits are included ('base...HEAD' would skip them).
    if [ -n "$base" ]; then target="the changes relative to the merge base of HEAD and $base: run 'git merge-base HEAD $base', then 'git diff <that sha>' (this includes uncommitted edits; list untracked files with 'git status --short' and read them too)"
    elif [ -n "$commit" ]; then target="the changes introduced by commit $commit"
    else target="the uncommitted changes: staged, unstaged and untracked files"
    fi
    instr="$common Review $target. Report only defects that break correctness or stated requirements; for each give file:line and a concrete failure scenario. Put style remarks in one short 'optional' list."
    [ -z "$prompt" ] || instr="$instr

Extra instructions:
$prompt"
    sub=(review -- "$instr") ;;
  debug)
    sub=(-- "$common Find the root cause of the bug below. Give: root cause (file, line, mechanism), the evidence, and the one check that would prove or refute it. Do not propose workarounds that hide the symptom.

Bug:
$prompt") ;;
  plan)
    sub=(-- "$common Critique the plan below against the actual code. Give: what breaks or is missing, a stronger alternative if one exists, and the risks ranked by impact.

Plan:
$prompt") ;;
  ask)
    sub=(-- "$common

Question:
$prompt") ;;
esac

args=(exec --sandbox read-only --skip-git-repo-check --ephemeral -C "$dir" -o "$work/last.txt")
call_path="$PATH"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    # With no [windows] sandbox chosen, Codex rejects every command in
    # read-only mode ("blocked by policy"), so it cannot even read the repo.
    # "unelevated" needs no admin setup and still denies writes. A sandbox the
    # user configured in config.toml is left as is.
    if ! grep -qs '^[[:space:]]*\[windows\]' "${CODEX_HOME:-$HOME/.codex}/config.toml"; then
      args+=(-c 'windows.sandbox="unelevated"')
    fi
    # The sandbox token cannot start Microsoft Store app aliases
    # (CreateProcessAsUserW error 5 on WindowsApps\pwsh.exe). Without
    # WindowsApps on PATH Codex falls back to the system powershell.exe.
    call_path="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vi '/WindowsApps' | paste -sd: -)" ;;
esac
args+=("${sub[@]}")

runner=()
if command -v timeout >/dev/null 2>&1; then runner=(timeout "$timeout_s")
elif command -v gtimeout >/dev/null 2>&1; then runner=(gtimeout "$timeout_s")
else echo "codex-second-opinion: warning: no timeout/gtimeout found, --timeout is not enforced" >&2
fi

# Codex reads extra input from stdin; </dev/null keeps the call from hanging.
# API-key variables are dropped so the run can only use the ChatGPT login.
if ! env -u OPENAI_API_KEY -u CODEX_API_KEY PATH="$call_path" ${runner[@]+"${runner[@]}"} codex "${args[@]}" </dev/null >"$work/log.txt" 2>&1; then
  echo "codex-second-opinion: codex exec failed. Last log lines:" >&2
  tail -n 20 "$work/log.txt" >&2
  exit 5
fi

if [ ! -s "$work/last.txt" ]; then
  echo "codex-second-opinion: Codex returned no final message. Log tail:" >&2
  tail -n 20 "$work/log.txt" >&2
  exit 6
fi
cat "$work/last.txt"
