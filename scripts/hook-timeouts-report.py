#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hook timeouts and hook errors, read back from the session transcripts.

Claude Code (2.1.2xx) writes every hook outcome into the session transcript as
an `attachment` record: `hook_success`, `hook_additional_context`,
`hook_cancelled` (with `durationMs`, `timeoutMs`, `timedOut`, `command`) and
`hook_non_blocking_error` (with `exitCode`, `stderr`). That is the only place
where a hook killed by its timeout leaves a trace with its real duration — the
killed process cannot log itself, and a sibling hook measuring its own run
time never sees the stall that happened before its process even started
(2026-09-15: a 5 ms node hook was reported killed at 10–14 s three times while
its own heartbeat showed nothing).

Reads `<config dir>/projects/*/*.jsonl` and prints:

    * timed-out hooks grouped by command — count, days, timeout, median/max
      duration. A duration several times the timeout means the CLI's own
      timer fired late: the whole machine was stalled, not the hook;
    * per-day counts next to the number of user prompts that day;
    * bursts — timeouts landing in the same 2-second window across two or
      more sessions, the signature of a machine-wide stall (paging);
    * the timeline of individual timeouts;
    * non-blocking hook errors grouped by command and working directory.

Usage
    python scripts/hook-timeouts-report.py [--days N] [--project SUBSTR]
                                           [--timeline N] [--config-dir DIR]

`--config-dir` defaults to $CLAUDE_CONFIG_DIR, then ~/.claude. Profiles that
share `projects/` through a junction are covered by either.
"""

import argparse
import io
import json
import os
import statistics
import sys
import time
from collections import defaultdict


def transcripts(config_dir, days, project):
    """Session transcripts plus the subagent transcripts nested under them
    (`<proj>/<session>/subagents/agent-*.jsonl`). The window is by file mtime:
    a resumed session brings its older records along, which is acceptable for
    a triage report."""
    root = os.path.join(config_dir, "projects")
    since = time.time() - days * 86400

    def jsonl_in(folder):
        try:
            names = os.listdir(folder)
        except OSError:
            return []
        return [os.path.join(folder, n) for n in names if n.endswith(".jsonl")]

    out = []
    if not os.path.isdir(root):
        return out
    for proj in sorted(os.listdir(root)):
        if project and project.lower() not in proj.lower():
            continue
        folder = os.path.join(root, proj)
        if not os.path.isdir(folder):
            continue
        found = [(proj, p) for p in jsonl_in(folder)]
        for session in os.listdir(folder):
            sub = os.path.join(folder, session, "subagents")
            if os.path.isdir(sub):
                found += [(proj + " [sub]", p) for p in jsonl_in(sub)]
        for label, path in found:
            try:
                if os.path.getmtime(path) >= since:
                    out.append((label, path))
            except OSError:
                pass
    return out


def short_project(proj):
    """`C--Users-<user>-StudioProjects-app--claude-worktrees-x` → `StudioProjects-app (wt:x)`;
    POSIX `-home-<user>-app` → `app`."""
    parts = proj.split("--claude-worktrees-")
    head = parts[0]
    if "--" in head and not head.startswith("-"):
        head = head.split("--", 1)[1]            # drop the Windows drive letter
    segs = [s for s in head.split("-") if s]     # drops the POSIX leading slash too
    if len(segs) > 2 and segs[0] in ("Users", "home"):
        segs = segs[2:]                          # drop `Users-<user>` / `home-<user>`
    return "-".join(segs) + (" (wt:%s)" % parts[1] if len(parts) > 1 else "")


def is_human_prompt(rec):
    return (rec.get("type") == "user" and bool(rec.get("promptId"))
            and "toolUseResult" not in rec and not rec.get("isMeta"))


def scan(files):
    timeouts, errors, prompts = [], defaultdict(int), defaultdict(int)
    for proj, path in files:
        try:
            f = io.open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with f:
            for line in f:
                if '"promptId"' in line:
                    # tool_result records and skill bodies injected by the Skill
                    # tool are `type: user` with a promptId too; the human turn
                    # is the one without `toolUseResult` and without `isMeta`.
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if is_human_prompt(rec):
                        prompts[str(rec.get("timestamp") or "")[:10]] += 1
                    continue
                if '"hook_cancelled"' not in line and '"hook_non_blocking_error"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                att = rec.get("attachment") or {}
                base = {
                    "ts": str(rec.get("timestamp") or ""), "proj": short_project(proj),
                    "session": (rec.get("sessionId") or "")[:8], "event": att.get("hookEvent", ""),
                    "cmd": str(att.get("command") or att.get("hookName") or "")[:90],
                }
                if att.get("type") == "hook_cancelled" and att.get("timedOut"):
                    timeouts.append(dict(base, dur=att.get("durationMs") or 0,
                                         limit=att.get("timeoutMs") or 0))
                elif att.get("type") == "hook_non_blocking_error":
                    key = (base["event"], base["cmd"], rec.get("cwd", ""),
                           str(att.get("stderr") or att.get("content") or "")[:120].replace("\n", " "))
                    errors[key] += 1
    timeouts.sort(key=lambda t: t["ts"])
    return timeouts, errors, prompts


def bursts(timeouts, window_s=2):
    """Groups of timeouts that ended within `window_s` of the group's first one,
    in two or more sessions. The window is anchored to the first member, not
    chained from the previous one, so two stalls 1.5 s apart stay two."""
    out, group, start = [], [], None

    def epoch(ts):
        try:
            return time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            return None

    def flush():
        if len({g["session"] for g in group}) >= 2:
            out.append(list(group))
        group.clear()

    for t in timeouts:
        at = epoch(t["ts"])
        if at is None:
            continue                            # unreadable time can't form a burst
        if group and at - start > window_s:
            flush()
        if not group:
            start = at
        group.append(t)
    flush()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--project", default="", help="substring of the project folder name")
    ap.add_argument("--timeline", type=int, default=40, help="timeline rows to print (0 = none)")
    ap.add_argument("--config-dir", default=os.environ.get("CLAUDE_CONFIG_DIR")
                    or os.path.join(os.path.expanduser("~"), ".claude"))
    args = ap.parse_args()

    files = transcripts(args.config_dir, args.days, args.project)
    timeouts, errors, prompts = scan(files)
    print("transcripts: %d (last %d days)  timed-out hooks: %d  non-blocking errors: %d"
          % (len(files), args.days, len(timeouts), sum(errors.values())))

    by_cmd = defaultdict(list)
    for t in timeouts:
        by_cmd[(t["event"], t["cmd"], t["limit"])].append(t)
    print("\n== timed out, by command ==")
    print("%5s %5s %8s %8s %8s  %s" % ("n", "days", "limit", "median", "max", "event | command"))
    for (event, cmd, limit), rows in sorted(by_cmd.items(), key=lambda kv: -len(kv[1])):
        durs = [r["dur"] for r in rows]
        print("%5d %5d %7.1fs %7.1fs %7.1fs  %s | %s"
              % (len(rows), len({r["ts"][:10] for r in rows}), limit / 1000.0,
                 statistics.median(durs) / 1000.0, max(durs) / 1000.0, event, cmd))

    print("\n== per day ==")
    per_day = defaultdict(int)
    for t in timeouts:
        per_day[t["ts"][:10]] += 1
    for day in sorted(set(prompts) | set(per_day)):
        print("%s  prompts=%-5d timeouts=%d" % (day, prompts.get(day, 0), per_day.get(day, 0)))

    groups = bursts(timeouts)
    print("\n== bursts (same 2 s window, ≥2 sessions — machine-wide stall) == %d" % len(groups))
    for g in groups[-15:]:
        print("%s  %d hooks / %d sessions  max %.1fs  %s"
              % (g[0]["ts"][:19], len(g), len({x["session"] for x in g}),
                 max(x["dur"] for x in g) / 1000.0, ", ".join(sorted({x["proj"] for x in g}))))

    if args.timeline:
        print("\n== timeline (last %d) ==" % args.timeline)
        for t in timeouts[-args.timeline:]:
            print("%s  %-44s %s  %-16s %6.1f/%-4.0fs  %s"
                  % (t["ts"][:19], t["proj"][:44], t["session"], t["event"],
                     t["dur"] / 1000.0, t["limit"] / 1000.0, t["cmd"]))

    print("\n== non-blocking errors ==")
    for (event, cmd, cwd, err), n in sorted(errors.items(), key=lambda kv: -kv[1])[:25]:
        print("%4d  %s | %s\n      cwd=%s\n      %s" % (n, event, cmd, cwd, err))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")   # Windows console defaults to a code page
    except (AttributeError, ValueError):
        pass
    sys.exit(main())
