#!/usr/bin/env bash
# Tests for hooks/commit-msg. Run: bash hooks/commit-msg.tests.sh
# Uses the template hooks/pre-commit (placeholder denylist: yourproject, @yourmail.com, ...).
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0; fail=0

check() { # name, expected rc, message text
  printf '%s' "$3" > "$tmp/msg"
  bash "$here/commit-msg" "$tmp/msg" >/dev/null 2>&1
  rc=$?
  if [ "$rc" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (rc=$rc, want $2)"; fi
}

check "clean message passes" 0 $'fix(x): tidy hook\n\nPlain body.\n'
check "denylisted name in subject blocked" 1 $'fix(yourproject): crash\n'
check "denylisted e-mail in body blocked" 1 $'fix(x): y\n\nreported by a@yourmail.com\n'
# -m / -F keep '#' lines (cleanup=whitespace): they are published, so they are checked.
check "denylisted name on a '#' line blocked" 1 $'fix(x): y\n\n#12 yourproject crashes\n'
fake_token="gh""p_abcdefghijklmnopqrstuvwxyz"   # split so pre-commit does not flag this file
check "secret token blocked" 1 "chore: y

$fake_token
"
# Verbose diff below the scissors line is staged content — pre-commit's job, not ours.
check "scissors section skipped" 0 $'fix(x): y\n\n# ------------------------ >8 ------------------------\n+ yourproject in diff\n'

# Fail closed without a usable pre-commit.
mkdir "$tmp/h" && cp "$here/commit-msg" "$tmp/h/commit-msg"
printf 'fix(x): y\n' > "$tmp/msg"
bash "$tmp/h/commit-msg" "$tmp/msg" >/dev/null 2>&1; rc=$?
if [ "$rc" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: missing pre-commit must block (rc=$rc)"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
