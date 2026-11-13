#!/usr/bin/env bash
# Generate or edit one raster image through the built-in $imagegen skill of
# Codex CLI. Usage is billed to the ChatGPT subscription the CLI is logged in
# with; an API-key login is refused because it bills per image.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: imagegen.sh --out <file.png> [--ref <image>]... [--timeout <sec>] -- <prompt>
       imagegen.sh --out <file.png> [--ref <image>]... [--timeout <sec>] --prompt-file <file>
EOF
  exit 2
}

# Default stays below the 600 s ceiling of the agent's Bash tool, so the
# script's own timeout fires first and its log tail reaches the agent.
out=""; prompt=""; prompt_file=""; timeout_s=540
refs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out|--ref|--prompt-file|--timeout)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "codex-imagegen: $1 needs a value" >&2; usage; } ;;
  esac
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --ref) refs+=("$2"); shift 2 ;;
    --prompt-file) prompt_file="$2"; shift 2 ;;
    --timeout) timeout_s="$2"; shift 2 ;;
    --) shift; prompt="$*"; break ;;
    *) usage ;;
  esac
done
if [ -n "$prompt_file" ]; then
  [ -f "$prompt_file" ] || { echo "codex-imagegen: prompt file not found: $prompt_file" >&2; exit 2; }
  prompt="$(cat "$prompt_file")"
fi
[ -n "$out" ] && [ -n "$prompt" ] || usage
for r in ${refs[@]+"${refs[@]}"}; do
  [ -f "$r" ] || { echo "codex-imagegen: reference image not found: $r" >&2; exit 2; }
done

command -v codex >/dev/null 2>&1 || {
  echo "codex-imagegen: Codex CLI not found. Install: npm i -g @openai/codex" >&2; exit 3; }

status="$(codex login status 2>&1 || true)"
case "$status" in
  *"using ChatGPT"*) ;;
  *) echo "codex-imagegen: Codex is not logged in with ChatGPT (status: $status). Ask the user to run: codex login" >&2; exit 4 ;;
esac

gen_dir="${CODEX_HOME:-$HOME/.codex}/generated_images"
mkdir -p "$gen_dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
touch "$work/.marker"

instr="Use the \$imagegen skill to generate exactly one image. Do not run shell commands and do not write files yourself. Reply with only the absolute path of the generated image."
if [ ${#refs[@]} -gt 0 ]; then
  instr="$instr The attached image(s) are the input: edit them or use them as the visual reference, as the request says."
fi
instr="$instr

Image request:
$prompt"

args=(exec --skip-git-repo-check --sandbox read-only --enable image_generation -C "$work" -o "$work/last.txt")
for r in ${refs[@]+"${refs[@]}"}; do args+=(-i "$r"); done
args+=(-- "$instr")

runner=()
if command -v timeout >/dev/null 2>&1; then runner=(timeout "$timeout_s")
elif command -v gtimeout >/dev/null 2>&1; then runner=(gtimeout "$timeout_s")
else echo "codex-imagegen: warning: no timeout/gtimeout found, --timeout is not enforced" >&2
fi

# Codex reads extra input from stdin; </dev/null keeps the call from hanging.
# API-key variables are dropped so the run can only use the ChatGPT login.
if ! env -u OPENAI_API_KEY -u CODEX_API_KEY ${runner[@]+"${runner[@]}"} codex "${args[@]}" </dev/null >"$work/log.txt" 2>&1; then
  echo "codex-imagegen: codex exec failed. Last log lines:" >&2
  tail -n 20 "$work/log.txt" >&2
  exit 5
fi

# Codex stores images under generated_images/<session id>/. Searching only this
# run's session folder keeps parallel calls from taking each other's image.
newest_in() {
  local dir="$1" best="" f
  [ -d "$dir" ] || return 0
  while IFS= read -r f; do
    if [ -z "$best" ] || [ "$f" -nt "$best" ]; then best="$f"; fi
  done < <(find "$dir" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) -newer "$work/.marker")
  printf '%s' "$best"
}

img=""
session="$(tr -d '\r' < "$work/log.txt" | sed -n 's/^session id: *//p' | head -n 1)"
if [ -n "$session" ]; then img="$(newest_in "$gen_dir/$session")"; fi

if [ -z "$img" ] && [ -f "$work/last.txt" ]; then
  cand="$(tr -d '\r`' < "$work/last.txt" | grep -v '^[[:space:]]*$' | tail -n 1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -n "$cand" ] && [ -f "$cand" ]; then img="$cand"; fi
fi

# Last resort: newest image anywhere. Not safe for parallel calls, so warn.
if [ -z "$img" ]; then
  img="$(newest_in "$gen_dir")"
  if [ -n "$img" ]; then
    echo "codex-imagegen: warning: session folder not found, took the newest image in $gen_dir" >&2
  fi
fi

if [ -z "$img" ]; then
  echo "codex-imagegen: no new image in $gen_dir. Codex reply and log tail:" >&2
  cat "$work/last.txt" >&2 2>/dev/null || true
  tail -n 20 "$work/log.txt" >&2
  exit 6
fi

mkdir -p "$(dirname "$out")"
cp "$img" "$out"
src_ext="${img##*.}"; out_base="$(basename "$out")"; out_ext=""
case "$out_base" in *.*) out_ext="${out_base##*.}" ;; esac
if [ "$(printf %s "$src_ext" | tr '[:upper:]' '[:lower:]')" != "$(printf %s "$out_ext" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "codex-imagegen: warning: source is .$src_ext, copied without conversion to $out" >&2
fi
echo "$out"
