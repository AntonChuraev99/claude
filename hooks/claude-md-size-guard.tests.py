#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for hooks/claude-md-size-guard.py.

Run: python hooks/claude-md-size-guard.tests.py
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "claude-md-size-guard.py")
BOX_CHARS = "═─│┌┐└┘├┤┬┴┼▶●━┃"

FAILURES = []
PASSED = 0


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILURES.append("%s%s" % (name, (" — " + detail) if detail else ""))


def write_md(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write("\n".join("строка %d" % i for i in range(lines)))


def run_hook(home, cwd, cols="100"):
    env = dict(os.environ)
    env["CLAUDE_HOME"] = home
    env["CLAUDE_TERM_COLS"] = cols
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run([sys.executable, HOOK], input=json.dumps({"cwd": cwd, "source": "startup"}),
                       env=env, capture_output=True, text=True, encoding="utf-8")
    out = (p.stdout or "").strip()
    return p.returncode, (json.loads(out) if out else None), (p.stderr or "")


def sysmsg(p):
    return (p or {}).get("systemMessage")


def ctx(p):
    return ((p or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""


def case_under_limit(root):
    home = os.path.join(root, "home")
    write_md(os.path.join(home, "CLAUDE.md"), 150)
    code, parsed, err = run_hook(home, os.path.join(root, "proj"))
    check("under limit → silent", parsed is None, repr(parsed))
    check("under limit → exit 0", code == 0, "code=%d" % code)


def case_global_over(root):
    home = os.path.join(root, "home")
    write_md(os.path.join(home, "CLAUDE.md"), 260)
    _, parsed, _ = run_hook(home, os.path.join(root, "proj"))
    msg = sysmsg(parsed) or ""
    check("over limit → warns", bool(msg), "empty")
    check("screen version is short", len(msg.splitlines()) <= 3,
          "%d lines: %r" % (len(msg.splitlines()), msg))
    check("no box drawing", not any(c in msg for c in BOX_CHARS), repr(msg))
    check("states the count", "260" in msg and "200" in msg, repr(msg))
    check("model gets the how-to", "instruction-routing" in ctx(parsed), ctx(parsed))
    check("screen is not a copy of the context", msg != ctx(parsed).strip(),
          "systemMessage duplicates additionalContext verbatim")
    check("screen shorter than context", len(msg) < len(ctx(parsed)),
          "screen=%d ctx=%d" % (len(msg), len(ctx(parsed))))


def case_project_over(root):
    home = os.path.join(root, "home")
    proj = os.path.join(root, "proj")
    write_md(os.path.join(home, "CLAUDE.md"), 100)
    write_md(os.path.join(proj, "CLAUDE.md"), 300)
    _, parsed, _ = run_hook(home, proj)
    msg = sysmsg(parsed) or ""
    check("project file reported", "проектный" in msg, repr(msg))
    check("global not reported when fine", "глобальный" not in msg, repr(msg))


def case_both_over(root):
    home = os.path.join(root, "home")
    proj = os.path.join(root, "proj")
    write_md(os.path.join(home, "CLAUDE.md"), 210)
    write_md(os.path.join(proj, "CLAUDE.md"), 400)
    _, parsed, _ = run_hook(home, proj)
    msg = sysmsg(parsed) or ""
    check("both reported", "глобальный" in msg and "проектный" in msg, repr(msg))
    check("still short", len(msg.splitlines()) <= 4, repr(msg))


def case_same_file_not_doubled(root):
    """Sessions run from ~/.claude itself: the project file IS the global one."""
    home = os.path.join(root, "home")
    write_md(os.path.join(home, "CLAUDE.md"), 250)
    _, parsed, _ = run_hook(home, home)
    msg = sysmsg(parsed) or ""
    check("same file counted once", msg.count("250") == 1, repr(msg))


def case_missing_files(root):
    code, parsed, err = run_hook(os.path.join(root, "nowhere"), os.path.join(root, "alsonowhere"))
    check("no files → silent", parsed is None, repr(parsed))
    check("no files → exit 0", code == 0, "code=%d stderr=%s" % (code, err[:200]))


def case_bad_stdin():
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run([sys.executable, HOOK], input="мусор", env=env,
                       capture_output=True, text=True, encoding="utf-8")
    check("garbage stdin → exit 0", p.returncode == 0, "code=%d" % p.returncode)


CASES = [case_under_limit, case_global_over, case_project_over, case_both_over,
         case_same_file_not_doubled, case_missing_files]


def main():
    if not os.path.exists(HOOK):
        print("FAIL: hook not found: %s" % HOOK)
        return 1
    for fn in CASES:
        root = tempfile.mkdtemp(prefix="mdsize-test-")
        try:
            fn(root)
        except Exception as exc:
            FAILURES.append("%s raised %s: %s" % (fn.__name__, type(exc).__name__, exc))
        finally:
            shutil.rmtree(root, ignore_errors=True)
    case_bad_stdin()

    print("passed: %d" % PASSED)
    if FAILURES:
        print("failed: %d" % len(FAILURES))
        for f in FAILURES:
            print("  - %s" % f)
        return 1
    print("all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
