#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook: enforcement for «CLAUDE.md ≤200 строк».

The limit came out of the 2026-05-28 improvement replay: a limit without a
mechanism does not hold. Warns when the global OR the project CLAUDE.md is over,
so detail moves into rules/ or skills/ before instruction adherence regresses.
Never blocks — it only reports.

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

HOWTO = (
    "WARNING: CLAUDE.md > ~%d строк (Anthropic: >200 снижает adherence + раздувает "
    "per-turn/per-subagent контекст). Вынеси detail-блоки: правило по типу файлов -> "
    "~/.claude/rules/*.md с paths:, процедура -> ~/.claude/skills/<name>/SKILL.md; "
    "в CLAUDE.md оставь триггер+указатель. Инварианты (security/git/DoD-gate/scope) "
    "оставляй inline. Маршрутизация — скилл instruction-routing." % LIMIT
)


def count_lines(path):
    try:
        with io.open(path, encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except OSError:
        return None


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
        n = count_lines(path)
        if n is not None and n > LIMIT:
            over.append((label, n, path))
    if not over:
        return 0

    headline = "CLAUDE.md больше лимита (%d строк): %s" % (
        LIMIT, ", ".join("%s — %d" % (label, n) for label, n, _ in over))
    details = ["вынести detail в rules/ или skills/ — скилл instruction-routing"]
    details += [path for _, _, path in over]

    emit(system_message=warn_block(headline, *details),
         context=HOWTO + "\n" + "\n".join(
             "%s CLAUDE.md — %d строк (лимит %d): %s" % (label, n, LIMIT, path)
             for label, n, path in over))
    return 0


if __name__ == "__main__":
    try:
        force_utf8()
        sys.exit(main())
    except Exception:
        sys.exit(0)                             # informational hook: never break startup
