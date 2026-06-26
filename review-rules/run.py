#!/usr/bin/env python3
"""L1 static gate for the bug-pattern review system.

Deterministic, no LLM. Loads the rule registry (review-rules/*.yaml), selects the
rules whose `globs` intersect the changed files, runs their detectors, and prints
findings. Exits non-zero when a `static` HIGH-severity finding is present (so a
git pre-commit hook can block the commit).

Failure modes this catches: "green build but broken" bugs that compile fine and
pass tests, yet break in release / on web / on a real device — the class that
recurs every session because nothing automated guards it (wrong Firebase region,
toPx()->CSS, getIdentifier(), bare %d placeholders, Android types in commonMain,
double system-bar padding ...).

`runtime`-mode rules are surfaced as WARN red-flags (need a real run to confirm);
they never block. `process`-mode rules have no detector — they are consumed by the
L3 process gate / the bug-pattern-reviewer agent, and are skipped here.

Usage:
    python run.py                 # review working-tree changes vs HEAD (+ untracked)
    python run.py --staged        # review staged changes (for pre-commit)
    python run.py --base <ref>    # review everything since <ref> (e.g. origin/main)
    python run.py --json          # machine-readable output (for the L2 agent)
    python run.py --warn-only     # never exit non-zero (advisory, for /end-session)
    python run.py --area <name>   # restrict to one area file
    python run.py --install-hook <project-dir>   # drop a pre-commit hook into a repo

Runs against the CURRENT git repo (a project repo such as the app you're editing),
not against ~/.claude — the rules live globally, the diff is local to the project.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Windows consoles default to cp1251 — force UTF-8 so Cyrillic messages and
# --json output are not mojibake / don't raise UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

try:
    import yaml
except ImportError:
    sys.stderr.write("review-rules: PyYAML required (pip install pyyaml)\n")
    sys.exit(2)

RULES_DIR = Path(__file__).resolve().parent
SEVERITY_ORDER = {"high": 3, "medium": 2, "low": 1}


# ---------------------------------------------------------------- glob -> regex
def glob_to_regex(glob: str) -> re.Pattern:
    """Translate a path glob (supporting **, *, ?, {a,b}) to a compiled regex."""
    i, n = 0, len(glob)
    out = []
    while i < n:
        c = glob[i]
        if glob.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "{":
            j = glob.find("}", i)
            if j == -1:
                out.append(re.escape(c))
                i += 1
            else:
                alts = glob[i + 1 : j].split(",")
                out.append("(?:" + "|".join(re.escape(a) for a in alts) + ")")
                i = j + 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def matches_any(path: str, globs: list[str]) -> bool:
    norm = path.replace("\\", "/")
    return any(glob_to_regex(g).match(norm) for g in globs)


# ---------------------------------------------------------------- git plumbing
def git(args: list[str]) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
    ).stdout


def changed_files(staged: bool, base: str | None) -> list[str]:
    if base:
        out = git(["diff", f"{base}...", "--name-only", "--diff-filter=ACM"])
        return [f for f in out.splitlines() if f.strip()]
    if staged:
        out = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
        return [f for f in out.splitlines() if f.strip()]
    tracked = git(["diff", "HEAD", "--name-only", "--diff-filter=ACM"])
    untracked = git(["ls-files", "--others", "--exclude-standard"])
    files = [f for f in tracked.splitlines() if f.strip()]
    files += [f for f in untracked.splitlines() if f.strip()]
    return sorted(set(files))


def file_content(path: str, staged: bool) -> str | None:
    if staged:
        out = git(["show", f":{path}"])
        if out:
            return out
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeError):
        return None


# ---------------------------------------------------------------- rule loading
def load_rules(area: str | None) -> list[dict]:
    rules: list[dict] = []
    for yml in sorted(RULES_DIR.glob("*.yaml")):
        if yml.name == "manifest.yaml":
            continue
        if area and yml.stem != area:
            continue
        try:
            data = yaml.safe_load(yml.read_text(encoding="utf-8")) or []
        except yaml.YAMLError as e:
            sys.stderr.write(f"review-rules: skipping {yml.name}: {e}\n")
            continue
        for rule in data:
            rule.setdefault("area", yml.stem)
            rules.append(rule)
    return rules


# ---------------------------------------------------------------- detectors
def run_detector(rule: dict, path: str, content: str) -> list[dict]:
    """Return a list of findings (each {line, snippet}) for one rule on one file."""
    detect = rule.get("detect")
    if not detect:  # process-mode rule, no static detector
        return []
    dtype = detect.get("type", "grep")
    findings: list[dict] = []

    if dtype == "glob":
        # Fires simply because a file matching the rule's globs is in the diff.
        return [{"line": 0, "snippet": Path(path).name}]

    if dtype == "grep":
        lacks = detect.get("lacks")
        if lacks and re.search(lacks, content):
            return []  # file already contains the required guard -> OK
        has = detect.get("has")
        unless = detect.get("unless")
        if not has:
            return []
        has_re = re.compile(has)
        unless_re = re.compile(unless) if unless else None
        for n, line in enumerate(content.splitlines(), start=1):
            if has_re.search(line):
                if unless_re and unless_re.search(line):
                    continue
                findings.append({"line": n, "snippet": line.strip()[:160]})
    return findings


# ---------------------------------------------------------------- main review
def review(files: list[str], rules: list[dict], staged: bool) -> list[dict]:
    results: list[dict] = []
    cache: dict[str, str | None] = {}
    for rule in rules:
        if rule.get("mode") == "process":
            continue
        globs = rule.get("globs") or []
        if not globs:
            continue
        for path in files:
            if not matches_any(path, globs):
                continue
            if path not in cache:
                cache[path] = file_content(path, staged)
            content = cache[path]
            if content is None:
                continue
            for hit in run_detector(rule, path, content):
                results.append(
                    {
                        "id": rule.get("id", "?"),
                        "area": rule.get("area", "?"),
                        "mode": rule.get("mode", "static"),
                        "severity": rule.get("severity", "medium"),
                        "pain": rule.get("pain"),
                        "file": path,
                        "line": hit["line"],
                        "snippet": hit["snippet"],
                        "message": rule.get("message", ""),
                        "fix": rule.get("fix", ""),
                        "source": rule.get("source", ""),
                    }
                )
    return results


# ---------------------------------------------------------------- reporting
def blocking(results: list[dict]) -> bool:
    return any(r["mode"] == "static" and r["severity"] == "high" for r in results)


def print_human(results: list[dict]) -> None:
    if not results:
        print("review-rules: no findings.")
        return
    order = sorted(
        results,
        key=lambda r: (
            -SEVERITY_ORDER.get(r["severity"], 0),
            r["mode"],
            r["area"],
            r["file"],
            r["line"],
        ),
    )
    for r in order:
        tag = "BLOCK" if (r["mode"] == "static" and r["severity"] == "high") else (
            "WARN" if r["mode"] == "runtime" else r["severity"].upper()
        )
        loc = f"{r['file']}:{r['line']}" if r["line"] else r["file"]
        pain = f" (боль #{r['pain']})" if r.get("pain") else ""
        print(f"\n{tag}  [{r['area']}/{r['id']}]{pain}  {loc}")
        if r["snippet"]:
            print(f"    > {r['snippet']}")
        if r["message"]:
            print(f"    {r['message']}")
        if r["fix"]:
            print(f"    fix: {r['fix']}")
        if r["source"]:
            print(f"    src: {r['source']}")
    statics = sum(1 for r in results if r["mode"] == "static")
    runtimes = sum(1 for r in results if r["mode"] == "runtime")
    print(f"\nreview-rules: {statics} static, {runtimes} runtime red-flag(s).")
    if blocking(results):
        print("review-rules: HIGH static finding(s) -> commit/gate should BLOCK.")


# ---------------------------------------------------------------- hook install
# Marker that identifies OUR hook inside a project's pre-commit file.
HOOK_MARKER = "review-rules/run.py"

HOOK_TEMPLATE = """#!/usr/bin/env bash
# Bug-pattern L1 static gate (installed by review-rules/run.py).
# Delegates to the global rule registry in ~/.claude/review-rules.
RUNNER="$HOME/.claude/review-rules/run.py"
[ -f "$RUNNER" ] || { echo "review-rules: runner not found at $RUNNER (skipping)"; exit 0; }
python "$RUNNER" --staged || {
  echo ""
  echo "Commit blocked by review-rules (HIGH static finding). Fix, or bypass once with:"
  echo "    git commit --no-verify   (NOT recommended)"
  exit 1
}
exit 0
"""


def git_root(start: str | None) -> Path | None:
    """git toplevel of `start` (or cwd), or None if not a git repo."""
    res = subprocess.run(
        ["git", "-C", start or ".", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if res.returncode != 0 or not res.stdout.strip():
        return None
    return Path(res.stdout.strip()).resolve()


def is_claude_home(repo: Path) -> bool:
    """True if `repo` is the ~/.claude (or ~/.claude-work) config repo — never touch it."""
    home = Path.home()
    return repo in {(home / ".claude").resolve(), (home / ".claude-work").resolve()}


def hook_status(repo: Path) -> tuple[str, Path]:
    """Return (status, path): 'installed' | 'absent' | 'foreign'."""
    target = repo / ".git" / "hooks" / "pre-commit"
    if not target.exists():
        return ("absent", target)
    try:
        txt = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ("foreign", target)
    return ("installed" if HOOK_MARKER in txt else "foreign", target)


def _write_hook(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(HOOK_TEMPLATE, encoding="utf-8")
    try:
        os.chmod(target, 0o755)
    except OSError:
        pass


def check_hook(start: str | None) -> int:
    """Read-only: report whether the L1 hook is installed in the current repo."""
    repo = git_root(start)
    if repo is None:
        print("review-rules: not a git repo — hook N/A")
        return 0
    if is_claude_home(repo):
        print("review-rules: config repo — hook N/A")
        return 0
    status, target = hook_status(repo)
    if status == "installed":
        print(f"review-rules: pre-commit hook installed ({repo.name})")
    elif status == "absent":
        print(f"review-rules: pre-commit hook NOT installed ({repo.name}) — run: python ~/.claude/review-rules/run.py --ensure-hook")
    else:
        print(f"review-rules: foreign pre-commit in {repo.name} — add manually: python \"$HOME/.claude/review-rules/run.py\" --staged || exit 1")
    return 0


def ensure_hook(start: str | None, explicit: bool = False) -> int:
    """Self-config: install the L1 hook into the current project repo if missing.

    Safe & idempotent: never touches ~/.claude; never clobbers a foreign hook
    (only flags it). Opt out with REVIEW_RULES_NO_AUTOHOOK=1. Quiet when there is
    nothing to do (so it's harmless on every SessionStart).
    """
    if os.environ.get("REVIEW_RULES_NO_AUTOHOOK") == "1":
        return 0
    repo = git_root(start)
    if repo is None or is_claude_home(repo):
        return 0  # not a project repo — nothing to configure
    status, target = hook_status(repo)
    if status == "installed":
        if explicit:
            print(f"review-rules: pre-commit hook already installed ({repo.name})")
        return 0
    if status == "foreign":
        # Don't break an existing hook — surface it so the user wires it in.
        print(
            f"review-rules: {repo.name} has a pre-commit hook without the L1 gate. "
            f'Add this line to .git/hooks/pre-commit:\n'
            f'    python "$HOME/.claude/review-rules/run.py" --staged || exit 1'
        )
        return 0
    _write_hook(target)
    print(f"review-rules: installed L1 pre-commit hook in {repo.name}")
    return 0


# ---------------------------------------------------------------- cli
def main() -> int:
    ap = argparse.ArgumentParser(description="L1 static gate for bug-pattern rules")
    ap.add_argument("--staged", action="store_true", help="review staged changes")
    ap.add_argument("--base", help="review changes since this ref (e.g. origin/main)")
    ap.add_argument("--area", help="restrict to one area file (stem name)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--warn-only", action="store_true", help="never exit non-zero")
    ap.add_argument("--install-hook", metavar="DIR", nargs="?", const=".",
                    help="install pre-commit hook into a repo (default: current)")
    ap.add_argument("--ensure-hook", metavar="DIR", nargs="?", const=".",
                    help="self-config: install hook if missing (safe, for SessionStart)")
    ap.add_argument("--check-hook", metavar="DIR", nargs="?", const=".",
                    help="read-only: report whether the hook is installed")
    args = ap.parse_args()

    if args.check_hook is not None:
        return check_hook(args.check_hook)
    if args.ensure_hook is not None:
        return ensure_hook(args.ensure_hook)
    if args.install_hook is not None:
        return ensure_hook(args.install_hook, explicit=True)

    files = changed_files(args.staged, args.base)
    if not files:
        if not args.json:
            print("review-rules: no changed files.")
        else:
            print("[]")
        return 0

    rules = load_rules(args.area)
    results = review(files, rules, args.staged)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print_human(results)

    if args.warn_only:
        return 0
    return 1 if blocking(results) else 0


if __name__ == "__main__":
    sys.exit(main())
