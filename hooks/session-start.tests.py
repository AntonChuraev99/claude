#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for hooks/session-start.py — the merged python start process prints what
the three separate hooks printed, and one failing module does not silence the rest.

Run: python hooks/session-start.tests.py
"""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "session-start.py")
DIGEST = os.path.join(HERE, "session-docs-digest.py")
SIZE = os.path.join(HERE, "claude-md-size-guard.py")

FAILURES = []
PASSED = 0


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
        print("  PASS %s" % name)
    else:
        FAILURES.append(name)
        print("  FAIL %s%s" % (name, ("\n    " + str(detail)[:600]) if detail else ""))


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(text)


def run(script, cwd, env_extra):
    env = dict(os.environ)
    env.update({"CLAUDE_TERM_COLS": "100", "PYTHONIOENCODING": "utf-8", "CLAUDE_DIGEST_COLOR": "0"})
    env.pop("REVIEW_RULES_NO_AUTOHOOK", None)
    env.update(env_extra)
    p = subprocess.run([sys.executable, script], input=json.dumps({"cwd": cwd, "source": "startup"}),
                       env=env, capture_output=True, text=True, encoding="utf-8")
    out = (p.stdout or "").strip()
    return p.returncode, (json.loads(out) if out else None)


def ctx(o):
    return ((o or {}).get("hookSpecificOutput") or {}).get("additionalContext") or ""


def main():
    tmp = tempfile.mkdtemp(prefix="ss-py-")
    try:
        home = os.path.join(tmp, "home")
        write(os.path.join(home, "CLAUDE.md"), "короткий\n")
        proj = os.path.join(tmp, "proj")
        write(os.path.join(proj, "docs", "backlog", "b1.md"),
              "---\ntitle: Пункт бэклога\nstatus: backlog\ndate: 2026-11-01\narea: hooks\n---\n")
        write(os.path.join(proj, "CLAUDE.md"), "\n".join("строка %d" % i for i in range(260)))
        subprocess.run(["git", "init", "-q", proj], check=True)
        env = {"CLAUDE_HOME": home}

        print("=== all three parts in one output ===")
        code, both = run(HOOK, proj, env)
        check("exit 0", code == 0)
        _, digest = run(DIGEST, proj, env)
        _, size = run(SIZE, proj, env)
        check("screen = digest + size warning, in order",
              both and both.get("systemMessage") == digest["systemMessage"] + "\n" + size["systemMessage"],
              json.dumps(both, ensure_ascii=False))
        check("context starts with the digest context, then the size context",
              ctx(both).startswith(ctx(digest) + "\n\n" + ctx(size)), ctx(both)[:300])
        check("ensure-hook installed the pre-commit hook",
              os.path.isfile(os.path.join(proj, ".git", "hooks", "pre-commit")))
        check("ensure-hook message reaches the context", "installed L1 pre-commit hook" in ctx(both), ctx(both)[-300:])
        check("event SessionStart", both and both["hookSpecificOutput"]["hookEventName"] == "SessionStart")

        print("=== second start: hook already there -> no ensure-hook text ===")
        _, again = run(HOOK, proj, env)
        check("no repeat of the install line", "installed L1" not in ctx(again), ctx(again)[-300:])

        print("=== nothing to say -> no output ===")
        empty = os.path.join(tmp, "empty")
        os.makedirs(empty)
        code, out = run(HOOK, empty, dict(env, REVIEW_RULES_NO_AUTOHOOK="1"))
        check("empty project -> exit 0, silent", code == 0 and out is None, repr(out))

        print("=== merge: plain text, garbage and a raising module ===")
        spec = importlib.util.spec_from_file_location("ss", HOOK)
        ss = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ss)
        screens, contexts, _ = ss.merge(['{"systemMessage":"A","hookSpecificOutput":{"additionalContext":"a"}}',
                                         "plain text", "", None])
        check("merge keeps json parts and plain text", screens == ["A"] and contexts == ["a", "plain text"],
              (screens, contexts))

        def boom():
            raise RuntimeError("x")

        def bye():
            sys.exit(3)
        check("capture swallows an exception", ss.capture(boom, "") == "")
        check("capture swallows sys.exit", ss.capture(bye, "") == "")
        saved = ss.JOBS
        ss.JOBS = [lambda raw: (_ for _ in ()).throw(ImportError("gone")), saved[1]]
        old_in, old_out = sys.stdin, sys.stdout
        sys.stdin = io.StringIO(json.dumps({"cwd": proj}))
        sys.stdout = buf = io.StringIO()
        os.environ["CLAUDE_HOME"] = home
        try:
            ss.main()
        finally:
            sys.stdin, sys.stdout = old_in, old_out
            ss.JOBS = saved
            os.environ.pop("CLAUDE_HOME", None)
        out = json.loads(buf.getvalue())
        check("a module failing to import drops only its part", "CLAUDE.md" in out.get("systemMessage", ""), out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("passed: %d" % PASSED)
    if FAILURES:
        print("failed: %d" % len(FAILURES))
        return 1
    print("all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
