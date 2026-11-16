#!/usr/bin/env python3
"""gate-log -- closes a /task-gate run: one validated line in task-gate-timings.jsonl
plus the state-file update (lastGateSha, reviewedSha, once flags, artifact server).

  python ~/.claude/skills/task-gate/scripts/gate-log.py --scratchpad <session-scratchpad> \
      --verdict "READY WITH WARNINGS" --artifact other --agents 1 [--review-clean] \
      [--review-sec N] [--once hookSetup,activeHygiene,rollup] \
      [--artifact-task <id> --artifact-url <url>]

Runs at 5.2, after the verdict, in both modes and for every verdict including NOT READY.
mode, files, l1_sec and the gate start come from the state that gate-prep.py wrote;
--mode/--files override them when gate-prep did not run. Exit 0 -- written; 2 -- the
row failed validation or this run is already logged (nothing written); 3 -- internal error.

The log lives outside git in ~/.claude/stats/ (absolute path, so a worktree writes to the
same file). It is not review-rules-events.jsonl: that one carries the L1 event schema
that stats.py aggregates.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.dont_write_bytecode = True   # no __pycache__ next to the scripts: the skill dir is whitelisted in git
_spec = importlib.util.spec_from_file_location("gate_prep", SCRIPT_DIR / "gate-prep.py")
prep = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prep)

SCHEMA = ("ts", "repo", "branch", "mode", "gate_sec", "review_sec", "l1_sec", "agents",
          "files", "verdict", "artifact")
MODES = ("lite", "full")
VERDICTS = ("READY", "READY WITH WARNINGS", "NOT READY")
ARTIFACTS = ("localhost", "apk", "other", "fallback", "none")
ONCE_KEYS = ("hookSetup", "activeHygiene", "rollup")
PASSING = ("READY", "READY WITH WARNINGS")
TS_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
MAX_GATE_SEC = 6 * 3600


def normalize_verdict(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    v = re.sub(r"[\s_]+", " ", value.strip()).upper()
    return v if v in VERDICTS else None


def _is_count(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def validate_row(row: dict) -> list[str]:
    errors = []
    if tuple(row) != SCHEMA:
        errors.append(f"ключи {list(row)} != {list(SCHEMA)}")
        return errors
    if not isinstance(row["ts"], str) or not TS_RE.match(row["ts"]):
        errors.append(f"ts {row['ts']!r}: нужен YYYY-MM-DDTHH:MM:SSZ")
    for key in ("repo", "branch"):
        if not isinstance(row[key], str) or not row[key].strip():
            errors.append(f"{key}: пустая строка")
    if row["mode"] not in MODES:
        errors.append(f"mode {row['mode']!r}: допустимо {', '.join(MODES)}")
    if row["verdict"] not in VERDICTS:
        errors.append(f"verdict {row['verdict']!r}: допустимо {' | '.join(VERDICTS)}")
    if row["artifact"] not in ARTIFACTS:
        errors.append(f"artifact {row['artifact']!r}: допустимо {', '.join(ARTIFACTS)} "
                      "(нет артефакта -- явное none)")
    for key in ("gate_sec", "review_sec", "l1_sec"):
        if row[key] is not None and not _is_count(row[key]):
            errors.append(f"{key} {row[key]!r}: целое >= 0 или null")
    for key in ("agents", "files"):
        if not _is_count(row[key]):
            errors.append(f"{key} {row[key]!r}: целое >= 0")
    return errors


def fmt_sec(sec) -> str:
    if sec is None:
        return "—"
    return f"{sec // 60}м{sec % 60:02d}с" if sec >= 60 else f"{sec}с"


def build_row(args, state: dict, repo: dict | None, now: float) -> dict:
    p = state.get("prep") or {}
    gate_sec = None
    if isinstance(p.get("ts"), int) and 0 <= now - p["ts"] <= MAX_GATE_SEC:
        gate_sec = int(now - p["ts"])
    return {
        "ts": datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": repo["name"] if repo else Path.cwd().name,
        "branch": repo["branch"] if repo else "none",
        "mode": args.mode or p.get("mode"),
        "gate_sec": gate_sec,
        "review_sec": args.review_sec,
        "l1_sec": p.get("l1Sec"),
        "agents": args.agents,
        "files": args.files if args.files is not None else p.get("files"),
        "verdict": normalize_verdict(args.verdict) or args.verdict,
        "artifact": (args.artifact or "").strip().lower() or None,
    }


def update_state(state: dict, verdict: str, head: str | None, top, args) -> dict:
    """5.2: lastGateSha on a passing verdict; reviewedSha only if the diff did not change."""
    out = {"lastGateSha": state.get("lastGateSha"), "reviewed_advanced": None, "reason": None}
    state["gateRuns"] = int(state.get("gateRuns", 0)) + 1
    once = state.setdefault("onceChecks", {})
    for key in [k.strip() for k in (args.once or "").split(",") if k.strip()]:
        once[key] = True
    if args.artifact_task or args.artifact_url:
        state["artifactServer"] = {"taskId": args.artifact_task, "url": args.artifact_url}
    if verdict in PASSING and head:
        state["lastGateSha"] = head
        out["lastGateSha"] = head
    if args.review_clean:
        review = (state.get("prep") or {}).get("review") or {}
        mb, fp = review.get("mergeBase"), review.get("fingerprint")
        if verdict not in PASSING:
            out["reviewed_advanced"], out["reason"] = False, "вердикт не READY"
        elif not (mb and fp and top):
            out["reviewed_advanced"], out["reason"] = False, "нет отпечатка ревью от gate-prep"
        elif prep.diff_fingerprint(top, mb) != fp:
            out["reviewed_advanced"], out["reason"] = False, "diff changed after review"
        else:
            state["reviewedSha"] = head
            out["reviewed_advanced"] = True
    out["reviewedSha"] = state.get("reviewedSha")
    return out


def run(args, cwd) -> tuple[int, dict]:
    bad_once = [k for k in (args.once or "").split(",") if k.strip() and k.strip() not in ONCE_KEYS]
    if bad_once:
        return 2, {"error": f"--once {bad_once}: допустимо {', '.join(ONCE_KEYS)}"}
    scratch = Path(args.scratchpad) if args.scratchpad else None
    if not args.state and not scratch:
        return 2, {"error": "нужен --scratchpad или --state"}
    state_path = Path(args.state) if args.state else scratch / "task-gate-state.json"
    state, state_error = prep.load_json(state_path)
    if not isinstance(state, dict):
        state, state_error = {}, "state не JSON-объект"
    if (state.get("prep") or {}).get("logged"):
        return 2, {"error": "этот прогон уже записан: gate-prep.py не запускался после прошлой строки"}

    repo = prep.repo_facts(cwd)
    now = time.time()
    row = build_row(args, state, repo, now)
    errors = validate_row(row)
    if errors:
        return 2, {"error": "строка не записана", "problems": errors, "row": row}

    stats_dir = Path(args.stats_dir) if args.stats_dir else prep.HOME_CLAUDE / "stats"
    stats_dir.mkdir(parents=True, exist_ok=True)
    log_path = stats_dir / "task-gate-timings.jsonl"
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

    st = update_state(state, row["verdict"], repo["head"] if repo else None,
                      repo["top"] if repo else None, args)
    state.setdefault("prep", {})["logged"] = True
    prep.save_json(state_path, state)
    return 0, {
        "logged": str(log_path), "row": row, "state": str(state_path),
        "state_error": state_error, **st,
        "timings": f"⏱ Timings: gate {fmt_sec(row['gate_sec'])} · review "
                   f"{fmt_sec(row['review_sec'])} · L1 {fmt_sec(row['l1_sec'])}",
    }


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="task-gate timing line + state update (5.2)")
    ap.add_argument("--scratchpad", help="session scratchpad with task-gate-state.json")
    ap.add_argument("--state", help="state file (default: <scratchpad>/task-gate-state.json)")
    ap.add_argument("--verdict", required=True, help=" | ".join(VERDICTS))
    ap.add_argument("--artifact", required=True, help=", ".join(ARTIFACTS))
    ap.add_argument("--agents", type=int, required=True, help="review agents spawned (2.3b + L2)")
    ap.add_argument("--mode", help="override: lite | full (default: from gate-prep)")
    ap.add_argument("--files", type=int, help="override: files of the task (default: from gate-prep)")
    ap.add_argument("--review-sec", type=int, help="longest review agent, seconds (from its result)")
    ap.add_argument("--review-clean", action="store_true",
                    help="2.3b closed without a blocker: advance reviewedSha if the diff is unchanged")
    ap.add_argument("--once", help="done [once] checks: " + ",".join(ONCE_KEYS))
    ap.add_argument("--artifact-task", help="background task id of the 5.1b dev-server")
    ap.add_argument("--artifact-url", help="URL of the 5.1b dev-server")
    ap.add_argument("--stats-dir", help="stats directory (default: ~/.claude/stats)")
    return ap


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    code, out = run(build_parser().parse_args(argv), os.getcwd())
    print(json.dumps(out, ensure_ascii=False, indent=1), file=sys.stdout if code == 0 else sys.stderr)
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write(f"gate-log: internal error: {type(exc).__name__}: {exc}\n")
        sys.exit(3)
