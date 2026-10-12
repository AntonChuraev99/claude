#!/usr/bin/env python3
"""Replay for improvements/2026-10-12-play-store-data-routing: Play Console via browser vs API agent.

Scans session transcripts of both profiles (~/.claude/projects, ~/.claude-work/projects) modified
in the last N days and counts:
  - browser tool calls (claude-in-chrome, playwright) whose input has play.google.com/console;
  - Agent calls with subagent_type google-play-console-expert;
  - per transcript with browser calls: the order of agent calls and console sections opened.

Usage: python scripts/replay-play-console-browser.py [days=14] [--sessions]
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOTS = [Path.home() / ".claude" / "projects", Path.home() / ".claude-work" / "projects"]
BROWSER = ("mcp__claude-in-chrome__", "mcp__plugin_playwright_playwright__")
SECTION = re.compile(r"play\.google\.com/console/[^\"\s]*?/app/\d+/([a-z0-9\-/]+)")
AGENT = "google-play-console-expert"
# Console sections whose data the API agent returns (GCS export, reviews API, Reporting API).
# Policy center, App content, experiments and store analysis have no API and stay legitimate
# browser targets, so they do not count against the hypothesis.
API_SECTION = re.compile(
    r"^browser:(statistics|reporting/acquisition|store-performance/(?!store-analysis)|"
    r"financial-reports|reporting/subscriptions|user-feedback|ratings|reviews|vitals|android-vitals)")


def scan(path: Path) -> list[str]:
    events = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if "play.google.com" not in line and AGENT not in line:
            continue
        try:
            content = (json.loads(line).get("message") or {}).get("content")
        except json.JSONDecodeError:
            continue
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict) or c.get("type") != "tool_use":
                continue
            name, inp = c.get("name", ""), c.get("input") or {}
            blob = json.dumps(inp, ensure_ascii=False)
            if name.startswith(BROWSER) and "play.google.com/console" in blob:
                m = SECTION.search(blob)
                events.append("browser:" + (m.group(1).split("?")[0] if m else "?"))
            if name in ("Agent", "Task") and inp.get("subagent_type") == AGENT:
                events.append("AGENT")
    return events


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    days = int(args[0]) if args else 14
    since = datetime.now(timezone.utc) - timedelta(days=days)
    browser_calls = agent_calls = api_section_calls = 0
    browser_files, agent_files, browser_before_agent = set(), set(), 0
    seen = set()  # the profiles share project dirs through links: count each transcript once
    for root in ROOTS:
        if not root.exists():
            continue
        for f in root.rglob("*.jsonl"):
            if (f.parent.name, f.name) in seen:
                continue
            seen.add((f.parent.name, f.name))
            if datetime.fromtimestamp(f.stat().st_mtime, timezone.utc) < since:
                continue
            events = scan(f)
            b = sum(e.startswith("browser") for e in events)
            a = events.count("AGENT")
            browser_calls += b
            agent_calls += a
            api_section_calls += sum(bool(API_SECTION.match(e)) for e in events)
            if b:
                browser_files.add(f)
                first_agent = events.index("AGENT") if a else len(events)
                browser_before_agent += any(API_SECTION.match(e) for e in events[:first_agent])
                if "--sessions" in sys.argv:
                    print(f"--- {f.parent.name}/{f.name}: " + " > ".join(dict.fromkeys(events)))
            if a:
                agent_files.add(f)
    print(f"window_days={days}")
    print(f"browser -> play console: calls={browser_calls} transcripts={len(browser_files)}")
    print(f"browser -> API-covered sections (statistics, acquisition, subscriptions, ...): calls={api_section_calls}")
    print(f"agent {AGENT}: calls={agent_calls} transcripts={len(agent_files)}")
    print(f"transcripts where browser opened an API-covered section BEFORE any agent call: {browser_before_agent}")


if __name__ == "__main__":
    main()
