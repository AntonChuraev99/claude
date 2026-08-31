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
    python run.py --warn-only     # never exit non-zero (advisory, for /task-gate)
    python run.py --area <name>   # restrict to one area file
    python run.py --install-hook <project-dir>   # drop a pre-commit hook into a repo

Runs against the CURRENT git repo (a project repo such as the app you're editing),
not against ~/.claude — the rules live globally, the diff is local to the project.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
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
    sys.exit(3)  # tool/setup error — distinct from exit 1 (finding); hook must NOT block

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


def added_lines(staged: bool, base: str | None) -> dict[str, set[int]]:
    """Map path -> set of NEW-file line numbers added (+) in the diff (git diff -U0).

    Used by --changed-only so STATIC rules consider only freshly added lines, not
    pre-existing legacy code in a file you merely touched (no commit lockout, and
    the Stop-hook's block stays loop-safe).
    """
    if base:
        args = ["diff", "-U0", f"{base}...", "--diff-filter=ACM"]
    elif staged:
        args = ["diff", "-U0", "--cached", "--diff-filter=ACM"]
    else:
        args = ["diff", "-U0", "HEAD", "--diff-filter=ACM"]
    out = git(args)
    result: dict[str, set[int]] = {}
    cur: str | None = None
    newln = 0
    for line in out.splitlines():
        if line.startswith("+++ b/"):
            cur = line[6:]
            result.setdefault(cur, set())
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)  # @@ -a,b +c,d @@ -> new-file start
            newln = int(m.group(1)) if m else 0
        elif line.startswith("+") and not line.startswith("+++"):
            if cur is not None:
                result[cur].add(newln)
                newln += 1
        elif line.startswith("-") and not line.startswith("---"):
            pass  # deletions don't advance the new-file counter
    return result


def diff_hash(staged: bool, base: str | None) -> str:
    """8-char sha1 of the relevant diff — correlates L1/L2/L3 events for one state."""
    if base:
        d = git(["diff", f"{base}..."])
    elif staged:
        d = git(["diff", "--cached"])
    else:
        d = git(["diff", "HEAD"]) + git(["ls-files", "--others", "--exclude-standard"])
    return hashlib.sha1(d.encode("utf-8", "replace")).hexdigest()[:8]


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
def run_detector(
    rule: dict, path: str, content: str, allowed: set[int] | None = None
) -> list[dict]:
    """Return a list of findings (each {line, snippet}) for one rule on one file.

    `allowed` (when not None) restricts grep matches to those NEW-file line numbers —
    used by --changed-only so static rules only flag freshly added lines.
    """
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
        requires = detect.get("requires")
        if requires and not re.search(requires, content):
            return []  # context the rule is about is absent from this file -> not our case
        has = detect.get("has")
        unless = detect.get("unless")
        if not has:
            return []
        has_re = re.compile(has)
        unless_re = re.compile(unless) if unless else None
        for n, line in enumerate(content.splitlines(), start=1):
            if allowed is not None and n not in allowed:
                continue
            if has_re.search(line):
                if unless_re and unless_re.search(line):
                    continue
                findings.append({"line": n, "snippet": line.strip()[:160]})
    return findings


# ---------------------------------------------------------------- main review
def review(
    files: list[str],
    rules: list[dict],
    staged: bool,
    changed_only: bool = False,
    added_map: dict[str, set[int]] | None = None,
    untracked: set[str] | None = None,
) -> list[dict]:
    results: list[dict] = []
    cache: dict[str, str | None] = {}
    added_map = added_map or {}
    untracked = untracked or set()
    for rule in rules:
        if rule.get("mode") == "process":
            continue
        globs = rule.get("globs") or []
        if not globs:
            continue
        is_static = rule.get("mode", "static") == "static"
        for path in files:
            if not matches_any(path, globs):
                continue
            # --changed-only: STATIC rules see only newly added content (runtime stays
            # full-content — it never blocks, and re-validating the whole file is fine).
            allowed: set[int] | None = None
            if changed_only and is_static:
                if path in untracked:
                    allowed = None  # a brand-new file is entirely "added"
                else:
                    added = added_map.get(path, set())
                    if not added:
                        continue  # tracked file with nothing newly added -> skip
                    allowed = added
            if path not in cache:
                cache[path] = file_content(path, staged)
            content = cache[path]
            if content is None:
                continue
            for hit in run_detector(rule, path, content, allowed):
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


# ---------------------------------------------------------------- telemetry
def write_log(
    log_path: str, entry: str, results: list[dict], files: list[str],
    blocked: bool, dhash: str,
) -> None:
    """Append one L1 event (JSONL) so the system's usefulness can be measured later.

    Logged on EVERY L1 invocation (stop-hook / pre-commit / manual), findings or not —
    clean runs are the denominator for per-rule false-positive rates. See stats.py.
    """
    root = git_root(None)
    proj = root.name if root else Path.cwd().name
    ev = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "layer": "L1",
        "project": proj,
        "entry": entry,
        "diff_hash": dhash,
        "files": len(files),
        "findings": {
            "static_high": sum(
                1 for r in results if r["mode"] == "static" and r["severity"] == "high"
            ),
            "static": sum(1 for r in results if r["mode"] == "static"),
            "runtime": sum(1 for r in results if r["mode"] == "runtime"),
        },
        "blocked": blocked,
        "rules": [
            {"id": r["id"], "area": r["area"], "mode": r["mode"], "sev": r["severity"],
             "file": r["file"], "line": r["line"]}
            for r in results
        ],
    }
    try:
        Path(log_path).parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
    except OSError as e:
        sys.stderr.write(f"review-rules: log write failed: {e}\n")


# ---------------------------------------------------------------- hook install
# Marker that identifies OUR hook inside a project's pre-commit file.
HOOK_MARKER = "review-rules/run.py"

HOOK_TEMPLATE = """#!/usr/bin/env bash
# Bug-pattern L1 static gate (installed by review-rules/run.py).
# Delegates to the global rule registry in ~/.claude/review-rules.
RUNNER="$HOME/.claude/review-rules/run.py"
[ -f "$RUNNER" ] || { echo "review-rules: runner not found at $RUNNER (skipping)"; exit 0; }
python "$RUNNER" --staged --changed-only \
  --log "$HOME/.claude/stats/review-rules-events.jsonl" --entry precommit
code=$?
[ "$code" -eq 3 ] && { echo "review-rules: tool error (setup) — not blocking commit"; exit 0; }
[ "$code" -ne 0 ] && {
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


def hooks_dir(start: str | None) -> Path | None:
    """Resolve the directory git actually reads hooks from.

    Must NOT be built as `<toplevel>/.git/hooks`: inside a linked worktree `.git`
    is a FILE (`gitdir: ...`), so that path never exists (hook_status wrongly
    reports 'absent') and mkdir on it fails with WinError 183. Hooks are shared
    across worktrees via the common dir.

    Order matches git's own: `core.hooksPath` wins when set, otherwise
    `--git-common-dir`/hooks. `--git-common-dir` is relative (".git") when run
    from a toplevel, so it is resolved against the git invocation cwd, not the
    toplevel.
    """
    cwd = start or "."

    cfg = subprocess.run(
        ["git", "-C", cwd, "config", "--get", "core.hooksPath"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if cfg.returncode == 0 and cfg.stdout.strip():
        p = Path(cfg.stdout.strip())
        return p.resolve() if p.is_absolute() else (Path(cwd) / p).resolve()

    common = subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--git-common-dir"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if common.returncode != 0 or not common.stdout.strip():
        return None
    p = Path(common.stdout.strip())
    if not p.is_absolute():
        p = Path(cwd) / p
    return (p / "hooks").resolve()


def repo_label(start: str | None, repo: Path) -> str:
    """Name to show the user. Inside a linked worktree the toplevel name is the
    worktree's ('push-token-dedup'), which misleads — the hook is shared, so name
    the owning repo and mark the worktree."""
    common = subprocess.run(
        ["git", "-C", start or ".", "rev-parse", "--git-common-dir"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if common.returncode == 0 and common.stdout.strip():
        p = Path(common.stdout.strip())
        if not p.is_absolute():
            p = Path(start or ".") / p
        owner = p.resolve().parent
        if owner != repo:
            return f"{owner.name} [worktree: {repo.name}]"
    return repo.name


def hook_status(start: str | None) -> tuple[str, Path | None]:
    """Return (status, path): 'installed' | 'absent' | 'foreign' | 'unknown'."""
    hooks = hooks_dir(start)
    if hooks is None:
        return ("unknown", None)
    target = hooks / "pre-commit"
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
    status, target = hook_status(start)
    label = repo_label(start, repo)
    if status == "installed":
        print(f"review-rules: pre-commit hook installed ({label})")
    elif status == "unknown":
        print(f"review-rules: cannot resolve hooks dir for {label} — hook state unknown")
    elif status == "absent":
        print(f"review-rules: pre-commit hook NOT installed ({label}) — run: python ~/.claude/review-rules/run.py --ensure-hook")
    else:
        print(f"review-rules: foreign pre-commit in {label} — add manually: python \"$HOME/.claude/review-rules/run.py\" --staged || exit 1")
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
    status, target = hook_status(start)
    label = repo_label(start, repo)
    if status == "installed":
        if explicit:
            print(f"review-rules: pre-commit hook already installed ({label})")
        return 0
    if status == "unknown" or target is None:
        if explicit:
            print(f"review-rules: cannot resolve hooks dir for {label} — not installing")
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
    ap.add_argument("--changed-only", action="store_true",
                    help="static rules flag only newly added lines (diff -U0), not legacy code")
    ap.add_argument("--log", metavar="PATH",
                    help="append an L1 event (JSONL) to PATH for effectiveness tracking")
    ap.add_argument("--entry", default="manual",
                    help="entry-point tag for the log (stop|precommit|endsession|manual); "
                         "'endsession' is the historic label used by /task-gate — do not rename")
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
        return 0  # nothing to review -> no log event (avoids noise on idle stops)

    rules = load_rules(args.area)
    added_map = added_lines(args.staged, args.base) if args.changed_only else {}
    untracked = (
        set(git(["ls-files", "--others", "--exclude-standard"]).splitlines())
        if args.changed_only else set()
    )
    results = review(files, rules, args.staged, args.changed_only, added_map, untracked)
    blk = blocking(results)

    if args.log:
        write_log(args.log, args.entry, results, files, blk,
                  diff_hash(args.staged, args.base))

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print_human(results)

    if args.warn_only:
        return 0
    return 1 if blk else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # any unexpected failure is a TOOL error, never a finding
        sys.stderr.write(f"review-rules: internal error: {exc}\n")
        sys.exit(3)
