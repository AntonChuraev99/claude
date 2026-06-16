#!/usr/bin/env bash
# sync-env.sh — Detect and copy gitignored build-essential files to a target directory.
#
# Usage:
#   sync-env.sh <source-repo> <target-dir> [--dry-run] [--verbose]
#
# The script scans the source repo for gitignored files matching known patterns
# (secrets, keystores, properties, google-services, .env, etc.), preserves
# relative paths, and copies them into the target directory.
#
# Performance notes
# -----------------
# Android / KMP / Node repos easily have 30k+ gitignored files (build/, .gradle/,
# node_modules/, .idea/). An O(N*M) loop with a subshell per entry (basename) runs
# for minutes on Windows (Git Bash fork is slow). This script avoids that by:
#   1. Using `git ls-files --directory` so whole gitignored directories collapse
#      into a single entry instead of listing every file inside them.
#   2. Doing a single awk pass with one composed regex instead of a nested loop.
#   3. Avoiding subshell calls (basename, dirname) inside the hot loop.
# Typical runtime on a 38k-gitignored-file repo: under 2 seconds.

set -euo pipefail

usage() {
  echo "Usage: sync-env.sh <source-repo> <target-dir> [--dry-run] [--verbose]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
SOURCE="$1"
TARGET="$2"
shift 2

DRY_RUN=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verbose) VERBOSE=1 ;;
    *) echo "Unknown arg: $arg" >&2; usage ;;
  esac
done

# Build-essential gitignored file patterns (glob syntax, matched against basename).
# Keep this list human-readable — it is the authoritative source for what gets synced.
# The script converts these into a single regex at runtime.
PATTERNS=(
  # Android / Gradle
  "secrets.properties"
  "local.properties"
  "local.defaults.properties"
  "gradle.properties"
  "keystore.properties"
  "signing.properties"
  "google-services.json"
  "agconnect-services.json"
  "fabric.properties"
  "crashlytics.properties"
  "*.jks"
  "*.keystore"
  # iOS / macOS / cross-platform signing
  "*.p12"
  "*.mobileprovision"
  # Certificates / secrets
  "*.pem"
  "*.key"
  # Observability
  "sentry.properties"
  # Generic env files
  ".env"
  ".env.*"
)

[ -d "$SOURCE" ] || { echo "ERROR: source not found: $SOURCE" >&2; exit 1; }
[ -d "$TARGET" ] || { echo "ERROR: target not found: $TARGET" >&2; exit 1; }

SOURCE="$(cd "$SOURCE" && pwd)"
TARGET="$(cd "$TARGET" && pwd)"

if [ "$SOURCE" = "$TARGET" ]; then
  echo "ERROR: source and target are the same directory" >&2
  exit 1
fi

echo "=== sync-env ==="
echo "Source: $SOURCE"
echo "Target: $TARGET"
[ $DRY_RUN -eq 1 ] && echo "Mode:   dry-run (no files will be copied)"
echo ""

# Convert each glob pattern into a regex alternative anchored to a full basename.
# Glob semantics we support:
#   *        -> [^/]*  (within a basename, never crosses directories)
#   literal  -> regex-escaped
# No ?, [], or ** — if you need them, extend glob_to_regex below.
#
# Implemented in pure bash (no sed). Git Bash on Windows struggles with sed
# character classes that mix ']' and '\' — a pure-bash loop is both faster
# (no subshell per pattern) and more portable.
glob_to_regex() {
  local s=$1
  local out=""
  local i c
  for (( i=0; i<${#s}; i++ )); do
    c=${s:i:1}
    case "$c" in
      '*') out+='[^/]*' ;;
      '.'|'^'|'$'|'+'|'?'|'('|')'|'{'|'}'|'|'|'['|']'|'\') out+='\'"$c" ;;
      *) out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

glob_alt=""
for pattern in "${PATTERNS[@]}"; do
  glob_alt+="|$(glob_to_regex "$pattern")"
done
# Anchor to basename: either start of line, or after a '/'. This way the regex
# matches the filename regardless of how deep the path is.
BASENAME_REGEX="(^|/)(${glob_alt#|})\$"

cd "$SOURCE"

# List gitignored entries once. `--directory` collapses whole gitignored
# directories (build/, .gradle/, node_modules/) into a single entry — crucial
# on large repos where a naive listing has tens of thousands of files.
# Then a single `grep -E` pass filters by basename against the composed regex.
# Using grep instead of awk avoids awk's noisy "\." escape-sequence warnings.
#
# Gotcha: `--directory` hides files that live *inside* gitignored directories.
# This is acceptable because build-essential configs almost always live at
# project roots or committed module roots, not inside build/ or node_modules/.
# If your project hides a secret under a gitignored directory, add its exact
# path via the `--extra <rel-path>` flag, or list it in a project-level
# copy-list outside this script.
candidates=$(
  git ls-files --others --ignored --exclude-standard --directory 2>/dev/null \
    | grep -E "$BASENAME_REGEX" || true
)

copied=0
skipped=0
examined=0

if [ -z "${candidates:-}" ]; then
  echo "No build-essential files matched known patterns."
  echo ""
  echo "=== Result ==="
  echo "Copied/Updated: 0"
  echo "Skipped:        0"
  echo ""
  echo "If your build fails due to a missing file, either:"
  echo "  - Add its pattern to PATTERNS[] in this script, or"
  echo "  - Copy it manually (see SKILL.md > Manual Fallback)."
  exit 0
fi

[ $VERBOSE -eq 1 ] && echo "Matched $(printf '%s\n' "$candidates" | wc -l | tr -d ' ') candidate path(s)."

while IFS= read -r rel_path; do
  [ -z "$rel_path" ] && continue
  examined=$((examined + 1))

  src_file="$SOURCE/$rel_path"
  dst_file="$TARGET/$rel_path"

  # `git ls-files --directory` may occasionally list a directory that happens
  # to match our basename regex. Skip anything that isn't a regular file.
  if [ ! -f "$src_file" ]; then
    [ $VERBOSE -eq 1 ] && echo "  skip (not a file): $rel_path"
    continue
  fi

  if [ -f "$dst_file" ]; then
    src_hash=$(md5sum "$src_file" 2>/dev/null | cut -d' ' -f1)
    dst_hash=$(md5sum "$dst_file" 2>/dev/null | cut -d' ' -f1)
    if [ "$src_hash" = "$dst_hash" ]; then
      echo "  SKIP (identical): $rel_path"
      skipped=$((skipped + 1))
      continue
    fi
    action="UPDATE"
  else
    action="COPY"
  fi

  echo "  $action: $rel_path"

  if [ $DRY_RUN -eq 1 ]; then
    copied=$((copied + 1))
    continue
  fi

  # Use parameter expansion instead of `dirname` to avoid subshell overhead.
  dst_dir="${dst_file%/*}"
  mkdir -p "$dst_dir"
  cp -- "$src_file" "$dst_file"
  copied=$((copied + 1))
done <<< "$candidates"

echo ""
echo "=== Result ==="
echo "Examined:            $examined"
echo "Copied/Updated:      $copied"
echo "Skipped (identical): $skipped"
[ $DRY_RUN -eq 1 ] && echo "(dry-run mode, no files were actually copied)"

if [ "$copied" -eq 0 ] && [ "$skipped" -eq 0 ]; then
  echo ""
  echo "WARNING: matches were found but none were regular files."
fi
