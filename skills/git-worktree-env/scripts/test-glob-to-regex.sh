#!/usr/bin/env bash
# Smoke test for the glob-to-regex conversion used by sync-env.sh.
# Run: bash scripts/test-glob-to-regex.sh
#
# Catches regressions where a pattern escape breaks (the original sed-based
# implementation crashed on Git Bash with "unterminated s command").

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
# Pull glob_to_regex out of sync-env.sh without running the whole script.
# We source it in a subshell with args that would make it exit early.
eval "$(
  awk '/^glob_to_regex\(\) \{$/,/^\}$/' "$SCRIPT_DIR/sync-env.sh"
)"

pass=0
fail=0
check() {
  local glob=$1 haystack=$2 expected=$3
  local re pat actual
  re=$(glob_to_regex "$glob")
  pat="^${re}$"
  if [[ $haystack =~ $pat ]]; then
    actual=match
  else
    actual=nomatch
  fi
  if [ "$actual" = "$expected" ]; then
    pass=$((pass + 1))
    printf '  ok   %-25s vs %-25s => %s\n' "$glob" "$haystack" "$actual"
  else
    fail=$((fail + 1))
    printf '  FAIL %-25s vs %-25s => got %s, want %s (regex=%s)\n' \
      "$glob" "$haystack" "$actual" "$expected" "$re"
  fi
}

echo "== glob_to_regex smoke tests =="

# Exact matches
check "secrets.properties" "secrets.properties" match
check "secrets.properties" "secretsXproperties" nomatch   # '.' must be literal
check "secrets.properties" "secrets-properties" nomatch

# Globstar-in-basename
check "*.jks"     "signing_key.jks"     match
check "*.jks"     "signing_key.keystore" nomatch
check ".env.*"    ".env.local"          match
check ".env.*"    ".env"                nomatch           # '*' needs ≥0 chars after the literal '.'
check ".env"      ".env"                match
check ".env"      ".envrc"              nomatch           # anchored

# Regex metacharacters in a filename must be literal
check "a+b.txt"   "a+b.txt"             match
check "a+b.txt"   "aab.txt"             nomatch           # '+' is not a quantifier
check "weird[1].cfg" "weird[1].cfg"     match
check "weird[1].cfg" "weird1.cfg"       nomatch

# Backslash edge case (pattern containing a literal backslash would be unusual,
# but the escape table covers it)
check 'a\b'       'a\b'                 match

echo ""
echo "passed: $pass"
echo "failed: $fail"

if [ $fail -gt 0 ]; then
  exit 1
fi
