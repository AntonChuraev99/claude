#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook: enforcement for «CLAUDE.md ≤200 строк и ≤37000 символов».

The limit came out of the 2026-05-28 improvement replay: a limit without a
mechanism does not hold. Warns when the global OR the project CLAUDE.md is over,
so detail moves into rules/ or skills/ before instruction adherence regresses.
Never blocks — it only reports.

Two budgets on purpose. Counting lines alone is blind to the shape this file
actually grows in: on 2026-08-31 the global CLAUDE.md sat at 197 lines (green)
and 35 152 characters, ~178 chars per line. Context cost and the adherence
effect Anthropic warns about track characters, not newlines, so a file can
double in weight without ever tripping a line limit.

Screen and model get different lengths on purpose: the terminal gets the fact
(«214 строк, лимит 200»), the model gets the routing instructions it needs to
act on it. The previous version pushed the same long paragraph into both, which
is how a warning turned into a wall of text at every session start.

Env
    CLAUDE_HOME  — profile root, default %USERPROFILE%\\.claude (tests set it)

Run: python hooks/claude-md-size-guard.py, stdin = hook JSON ({cwd, source, …}).
Tests: hooks/claude-md-size-guard.tests.py
"""

import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
from hookout import cwd_of, emit, force_utf8, read_payload, warn_block  # noqa: E402

LIMIT = 200
# Set ~5% above the 2026-08-31 measurement (35 320) on purpose: a budget the file
# already busts would warn every single session, and «сократить CLAUDE.md» has been
# tried three times without sticking — a permanent nag would simply be tuned out.
# The headroom is deliberate but small: one added paragraph is free, sustained growth
# is not. Ratchet it down as the file shrinks. Keep this number, the docstring above,
# and skills/instruction-routing/SKILL.md → «## CLAUDE.md» in sync.
CHAR_LIMIT = 37000

HOWTO = (
    "WARNING: CLAUDE.md > ~%d строк или > ~%d символов (Anthropic: >200 строк снижает "
    "adherence + раздувает per-turn/per-subagent контекст; символы — та же цена, но "
    "линейный счётчик её не видит). Вынеси detail-блоки: правило по типу файлов -> "
    "~/.claude/rules/*.md с paths:, процедура -> ~/.claude/skills/<name>/SKILL.md; "
    "в CLAUDE.md оставь триггер+указатель. Инварианты (security/git/DoD-gate/scope) "
    "оставляй inline. Маршрутизация — скилл instruction-routing." % (LIMIT, CHAR_LIMIT)
)


def measure(path):
    """(lines, chars) of path, or None if unreadable."""
    try:
        with io.open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    return text.count("\n") + (1 if text and not text.endswith("\n") else 0), len(text)


def overflow(lines, chars):
    """Human-readable list of the budgets this file busts; empty when fine."""
    parts = []
    if lines > LIMIT:
        parts.append("%d строк" % lines)
    if chars > CHAR_LIMIT:
        parts.append("%d символов" % chars)
    return parts


def main():
    payload = read_payload()
    cwd = cwd_of(payload)

    home = os.environ.get("CLAUDE_HOME") or os.path.join(
        os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".claude")
    global_md = os.path.join(home, "CLAUDE.md")
    project_md = os.path.join(cwd, "CLAUDE.md")

    targets = []
    if os.path.isfile(global_md):
        targets.append(("глобальный", global_md))
    if os.path.isfile(project_md):
        try:
            same = os.path.samefile(project_md, global_md) if os.path.isfile(global_md) else False
        except OSError:
            same = os.path.normcase(os.path.abspath(project_md)) == \
                   os.path.normcase(os.path.abspath(global_md))
        if not same:
            targets.append(("проектный", project_md))

    over = []
    for label, path in targets:
        measured = measure(path)
        if measured is None:
            continue
        lines, chars = measured
        parts = overflow(lines, chars)
        if parts:
            over.append((label, parts, path))
    if not over:
        return 0

    headline = "CLAUDE.md больше лимита (%d строк / %d символов): %s" % (
        LIMIT, CHAR_LIMIT,
        ", ".join("%s — %s" % (label, ", ".join(parts)) for label, parts, _ in over))
    details = ["вынести detail в rules/ или skills/ — скилл instruction-routing"]
    details += [path for _, _, path in over]

    emit(system_message=warn_block(headline, *details),
         context=HOWTO + "\n" + "\n".join(
             "%s CLAUDE.md — %s (лимит %d строк / %d символов): %s"
             % (label, ", ".join(parts), LIMIT, CHAR_LIMIT, path)
             for label, parts, path in over))
    return 0


if __name__ == "__main__":
    try:
        force_utf8()
        sys.exit(main())
    except Exception:
        sys.exit(0)                             # informational hook: never break startup
