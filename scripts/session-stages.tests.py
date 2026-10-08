"""Tests for review classification in scripts/session-stages.py.
Run: python scripts/session-stages.tests.py
"""
import importlib.util, os, sys

sys.argv = [sys.argv[0], "0"]  # the module reads DAYS from argv on import
spec = importlib.util.spec_from_file_location(
    "session_stages", os.path.join(os.path.dirname(os.path.abspath(__file__)), "session-stages.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

CASES = [
    # Since 2026-09-15 there is no separate fresh review: "Diff review ..." is the gate 2.3b reviewer.
    ("Diff review: rewards VM", "gate 2.3b Standards+Spec"),
    ("Gate 2.3b diff review", "gate 2.3b Standards+Spec"),
    ("Gate review: Spec axis", "gate 2.3b Standards+Spec"),
    ("Ревью диффа хотфикса", "gate 2.3b Standards+Spec"),
    ("L2 bug-pattern review", "L2 bug-pattern"),
    ("Fresh independent look at the plan", "fresh/independent diff review"),
    ("Verify release notes", "PR/release review"),
    ("Sanity check build", "verify/sanity"),
]

fails = 0
for desc, want in CASES:
    got = mod.kind_of(desc, mod.REVIEW_KINDS)
    if got != want:
        fails += 1
        print(f"FAIL: {desc!r} -> {got!r}, want {want!r}")
print(f"{len(CASES) - fails} passed, {fails} failed")
sys.exit(1 if fails else 0)
