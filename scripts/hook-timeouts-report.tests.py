#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for scripts/hook-timeouts-report.py.

Run: python scripts/hook-timeouts-report.tests.py

A throwaway `projects/` tree with hand-written transcript lines; the module is
imported by path (the file name has dashes) and its pure functions are
exercised directly. The numbers this report prints end up in improvement
baselines, so the two filters that were wrong once — the human-prompt filter
and the burst window — each have a case that fails without them.
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("report", os.path.join(HERE, "hook-timeouts-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

FAILURES = []
PASSED = 0


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILURES.append("%s%s" % (name, (" — " + detail) if detail else ""))


def write_jsonl(path, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            # compact separators, as the CLI writes them
            f.write((json.dumps(r, ensure_ascii=False, separators=(",", ":")) if isinstance(r, dict) else r) + "\n")


def user(ts, prompt_id="p1", **extra):
    rec = {"type": "user", "promptId": prompt_id, "timestamp": ts,
           "message": {"role": "user", "content": "hi"}, "sessionId": "s1"}
    rec.update(extra)
    return rec


def cancelled(ts, session, cmd, dur, limit, timed_out=True):
    return {"type": "attachment", "timestamp": ts, "sessionId": session,
            "attachment": {"type": "hook_cancelled", "hookEvent": "PreToolUse", "hookName": "PreToolUse:Grep",
                           "command": cmd, "durationMs": dur, "timeoutMs": limit, "timedOut": timed_out}}


def nbe(ts, session, cmd):
    return {"type": "attachment", "timestamp": ts, "sessionId": session, "cwd": "C:/proj",
            "attachment": {"type": "hook_non_blocking_error", "hookEvent": "PostToolUse",
                           "hookName": "PostToolUse:Edit", "command": cmd, "stderr": "boom", "exitCode": 1}}


def case_prompt_filter():
    recs = [
        user("2026-09-15T05:00:00.000Z"),                                         # human turn
        user("2026-09-15T05:00:01.000Z", toolUseResult={"stdout": ""}),           # tool_result
        user("2026-09-15T05:00:02.000Z", isMeta=True),                            # skill body via Skill tool
        {"type": "user", "timestamp": "2026-09-15T05:00:03.000Z", "sessionId": "s1",
         "message": {"role": "user", "content": "no promptId"}},                  # not a prompt
    ]
    check("human prompt counted", report.is_human_prompt(recs[0]))
    check("tool_result not counted", not report.is_human_prompt(recs[1]))
    check("isMeta skill body not counted", not report.is_human_prompt(recs[2]))
    check("record without promptId not counted", not report.is_human_prompt(recs[3]))


def case_scan_tree():
    root = tempfile.mkdtemp(prefix="hooks-report-")
    try:
        proj = os.path.join(root, "projects", "C--Users-me-StudioProjects-app")
        write_jsonl(os.path.join(proj, "s1.jsonl"), [
            user("2026-09-15T05:00:00.000Z"),
            user("2026-09-15T05:00:01.000Z", toolUseResult={}),
            user("2026-09-15T05:00:02.000Z", isMeta=True),
            cancelled("2026-09-15T05:01:00.000Z", "s1", "bash grep-reminder.sh", 12000, 5000),
            cancelled("2026-09-15T05:02:00.000Z", "s1", "bash grep-reminder.sh", 100, 5000, timed_out=False),
            nbe("2026-09-15T05:03:00.000Z", "s1", "pwsh -File x.ps1"),
            "not json at all",
        ])
        write_jsonl(os.path.join(proj, "s1", "subagents", "agent-a.jsonl"), [
            cancelled("2026-09-15T05:01:01.000Z", "a1", "bash grep-reminder.sh", 9000, 5000),
        ])
        write_jsonl(os.path.join(proj, "s1", "tool-results", "ignored.jsonl"), [
            cancelled("2026-09-15T05:09:00.000Z", "zz", "should not be read", 9000, 5000),
        ])
        files = report.transcripts(root, days=3650, project="")
        labels = sorted(label for label, _ in files)
        check("session and subagent transcripts found, tool-results skipped",
              labels == ["C--Users-me-StudioProjects-app", "C--Users-me-StudioProjects-app [sub]"], repr(labels))
        timeouts, errors, prompts = report.scan(files)
        check("only timedOut cancellations counted", len(timeouts) == 2, repr(timeouts))
        check("prompts per day count humans only", dict(prompts) == {"2026-09-15": 1}, repr(dict(prompts)))
        check("non-blocking error grouped", sum(errors.values()) == 1, repr(errors))
        check("garbage line survives", True)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def case_short_project():
    check("windows path with worktree",
          report.short_project("C--Users-me-StudioProjects-app--claude-worktrees-x") == "StudioProjects-app (wt:x)",
          report.short_project("C--Users-me-StudioProjects-app--claude-worktrees-x"))
    check("posix home path", report.short_project("-home-me-app") == "app", report.short_project("-home-me-app"))
    check("profile dir", report.short_project("C--Users-me--claude") == "claude", report.short_project("C--Users-me--claude"))


def case_bursts_window():
    def t(sec, session):
        return {"ts": "2026-09-15T05:00:%02d.000Z" % sec, "session": session, "dur": 1, "proj": "p"}
    # 0 / 1.9 / 3.8 / 5.7 — chained they would be one 5.7 s group; anchored to the
    # first member they are two separate two-session bursts.
    chain = [t(0, "a"), t(1, "b"), t(3, "a"), t(5, "b")]
    groups = report.bursts(chain, window_s=2)
    check("window anchored to first member, not chained",
          [len(g) for g in groups] == [2, 2], repr([[x["ts"][17:19] for x in g] for g in groups]))
    check("single-session cluster is not a burst", report.bursts([t(0, "a"), t(1, "a")]) == [])
    check("empty and single input", report.bursts([]) == [] and report.bursts([t(0, "a")]) == [])
    check("unreadable timestamp skipped",
          report.bursts([{"ts": "garbage", "session": "a"}, t(0, "a"), t(1, "b")], window_s=2) and True)


def main():
    for fn in (case_prompt_filter, case_scan_tree, case_short_project, case_bursts_window):
        try:
            fn()
        except Exception as exc:  # a crashing case is a failing case
            FAILURES.append("%s raised %s: %s" % (fn.__name__, type(exc).__name__, exc))
    print("passed: %d" % PASSED)
    if FAILURES:
        print("failed: %d" % len(FAILURES))
        for f in FAILURES:
            print("  - %s" % f)
        return 1
    print("all green")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    sys.exit(main())
