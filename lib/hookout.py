#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared output shape for SessionStart hooks.

Every hook that prints to the terminal goes through here, so the session start
reads as one voice instead of N differently-framed blocks. There is deliberately
no aggregating runner: the CLI already renders one `says:` block per hook, and a
runner would turn six independent, fail-open hooks into a single point of
failure (a crash would take `model-overlay` and `credentials-digest` down with
the digest). Shared *format*, separate *processes*.

House style for the visible part:

* No box drawing. The CLI prefixes and indents hook output, so a frame that
  assumes column 0 is broken before its first character.
* A warning is `⚠ <what happened>` plus indented detail lines.
* Width comes from the console minus the CLI's indent (see `term.terminal_cols`).
* The screen gets the short version; the model gets the long one — they are
  different readers with different budgets.
"""

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from term import dtrunc, terminal_cols  # noqa: E402

CLI_INDENT = 3
WARN = "⚠"


def width():
    return max(40, terminal_cols() - CLI_INDENT)


def warn_block(headline, *details):
    """`⚠ headline` plus indented details, each clipped to the console width."""
    w = width()
    lines = [dtrunc("%s %s" % (WARN, headline), w)]
    lines.extend(dtrunc("  " + d, w) for d in details if d)
    return "\n".join(lines)


def emit(system_message=None, context=None, suppress=True):
    """Write the SessionStart hook JSON to stdout.

    `system_message=None` means the terminal stays quiet while the model still
    receives `context` — the split that lets `/compact` avoid interrupting the
    user without starving the model of the same information.
    """
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart"}}
    if suppress:
        out["suppressOutput"] = True
    if context:
        out["hookSpecificOutput"]["additionalContext"] = context
    if system_message:
        out["systemMessage"] = system_message
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


def force_utf8():
    """Windows pipes default to the ANSI code page, which cannot encode Cyrillic."""
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def read_payload():
    """Hook JSON from stdin; never raises — a broken payload yields {}."""
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw and raw.strip() else {}
    except Exception:
        return {}


def cwd_of(payload):
    return (payload or {}).get("cwd") or os.getcwd()
