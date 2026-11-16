#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart: every python-side start hook in ONE process.

    session-docs-digest.py     digest of docs/active + todos + backlog (+ replay note)
    claude-md-size-guard.py    CLAUDE.md line / character budget
    review-rules/run.py        --ensure-hook: L1 pre-commit hook in the project repo

Until 2026-11-16 these were three processes (the last behind a pwsh wrapper, 0.32 s
idle start of its own); a session start spawned ten hook processes in all and
SessionStart timeouts came in series of 15–16 s under memory pressure. Each module
keeps its own file, its own `main()` and its own tests; this runner feeds each the
same stdin, captures what it prints and merges the outputs.

lib/hookout.py argued for separate processes: one crash would take every hook down.
Here each module runs in its own try/except — a module that raises (or exits)
drops only its own part.

Why not a cache instead (claude-md-size-guard): measuring two files costs a
millisecond in-process; the cost was the interpreter start, and the project
CLAUDE.md (cwd) cannot move to the harness pre-commit hook.

Merge: systemMessage parts joined by a newline; additionalContext parts by a blank
line, in module order; plain-text output (run.py prints text) goes to the context.
"""

import importlib.util
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "lib"))
from hookout import emit, force_utf8  # noqa: E402


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def capture(fn, raw):
    """Run fn() with `raw` on stdin; return what it printed. Never raises."""
    old_in, old_out = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(raw), io.StringIO()
    try:
        fn()
    except BaseException:                     # SystemExit included: a module may sys.exit()
        pass
    finally:
        out = sys.stdout.getvalue()
        sys.stdin, sys.stdout = old_in, old_out
    return out


def digest_job(raw):
    return load("session_docs_digest", os.path.join(HERE, "session-docs-digest.py")).main


def size_job(raw):
    return load("claude_md_size_guard", os.path.join(HERE, "claude-md-size-guard.py")).main


def ensure_hook_job(raw):
    try:
        cwd = (json.loads(raw) if raw.strip() else {}).get("cwd") or "."
    except ValueError:
        cwd = "."
    run = load("review_rules_run", os.path.join(ROOT, "review-rules", "run.py"))
    return lambda: run.ensure_hook(cwd)


JOBS = [digest_job, size_job, ensure_hook_job]


def merge(outputs):
    screens, contexts, suppress = [], [], False
    for out in outputs:
        text = (out or "").strip()
        if not text:
            continue
        try:
            obj = json.loads(text)
        except ValueError:
            obj = None
        if not isinstance(obj, dict):
            contexts.append(text)
            continue
        if obj.get("systemMessage"):
            screens.append(obj["systemMessage"])
        ctx = (obj.get("hookSpecificOutput") or {}).get("additionalContext")
        if ctx:
            contexts.append(ctx)
        suppress = suppress or bool(obj.get("suppressOutput"))
    return screens, contexts, suppress


def main():
    try:
        raw = sys.stdin.read() or ""
    except Exception:
        raw = ""
    outputs = []
    for job in JOBS:
        try:
            fn = job(raw)
        except BaseException:                 # module failed to import: skip only it
            continue
        outputs.append(capture(fn, raw))
    screens, contexts, suppress = merge(outputs)
    if screens or contexts:
        emit(system_message="\n".join(screens) or None,
             context="\n\n".join(contexts) or None, suppress=suppress or bool(screens))
    return 0


if __name__ == "__main__":
    try:
        force_utf8()
        sys.exit(main())
    except Exception:
        sys.exit(0)                             # a start hook must never break startup
