#!/usr/bin/env python3
"""gate-prep -- facts for /task-gate in one call instead of hand-written shell lines.

Run from the task repository (main checkout or worktree):

  python ~/.claude/skills/task-gate/scripts/gate-prep.py --scratchpad <session-scratchpad>
      [--full "<reason>"] [--start-sha <sha>]                    # Step 1 + 2.0
  python ~/.claude/skills/task-gate/scripts/gate-prep.py --todo-only [--staged]
                                                                 # TODO scan (2.8, /commit)
  python ~/.claude/skills/task-gate/scripts/gate-prep.py --docs-only <path> [<path> ...]
                                                                 # 2.7b for DOCS_WRITTEN/ARCHIVED

Prints one JSON object. Findings are data, not errors: exit 0; 2 -- bad arguments;
3 -- internal error. Stdlib only, Python 3.12, Windows + Git Bash.

Why a script: the old SKILL.md lines with `$(...)`, shell variables and `{ ...; } > file`
were refused inside worktrees as "too complex to verify" (9% of the timing-line calls),
and hand substitution let the log schema drift.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
HARNESS_ROOT = SCRIPT_DIR.parents[2]          # skills/task-gate/scripts -> repo root
HOME_CLAUDE = Path.home() / ".claude"
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
PACKAGE_LIMIT = 2 * 1024 * 1024
LIST_CAP = 20
REMOTE_TIMEOUT = 20

# 2.8 / /commit: extensions scanned for TODO markers.
TODO_EXT = (".kt", ".kts", ".java", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
            ".swift", ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".hpp", ".m", ".mm")
TODO_RE = re.compile(r"\b(TODO|FIXME|STOPSHIP):")
PENDING_RE = re.compile(r"Pending:\s*(docs/todos/[^\s`'\")*]+\.md)")
ISSUE_RE = re.compile(r"Issue:\s*https?://\S+")
HUNK_RE = re.compile(r"^@@ -\S+ \+(\d+)(?:,\d+)? @@")

# 2.3b: what counts as code for the smell baseline.
REVIEW_CODE_EXT = {".kt", ".kts", ".java", ".swift", ".ts", ".tsx", ".js", ".jsx", ".mjs",
                   ".cjs", ".py", ".rb", ".go", ".rs", ".php", ".sql", ".sh", ".ps1"}
REVIEW_CODE_NAMES = {"Podfile", "package.json"}

# 1.1: instructions and executables of the ~/.claude harness.
HARNESS_PREFIXES = ("agents/", "skills/", "rules/", "model-overlays/", "output-styles/",
                    "commands/", "hooks/", "scripts/", "review-rules/")
HARNESS_FILES = ("CLAUDE.md", "settings.json", "settings.example.json")
# Step 6 docs-only exception: harness paths that are agent instructions, not docs.
HARNESS_INSTRUCTION_PREFIXES = ("rules/", "skills/", "agents/", "model-overlays/",
                                "output-styles/", "commands/", "hooks/", "references/")

# 1.1: deploy, infrastructure, environment configuration (path heuristic).
DEPLOY_RE = re.compile(
    r"(^|/)(\.gitlab-ci\.yml|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|wrangler\.(toml|jsonc?)"
    r"|firebase\.json|\.firebaserc|vercel\.json|netlify\.toml|cloudbuild\.ya?ml|app\.yaml"
    r"|[^/]*\.rules)$|^\.github/workflows/|\.tf$|(^|/)\.env[^/]*$")

TEST_DIRS = {"test", "tests", "spec", "specs", "__tests__"}
TEST_NAME_RE = re.compile(
    r"(Tests?|Spec)\.(kt|kts|java|swift|scala)$|[._-](test|tests|spec)\.(c|m)?[jt]sx?$"
    r"|^test_[^/]*\.py$|_test\.(py|go)$|\.tests\.py$|_spec\.rb$")

SUSPICIOUS_RE = re.compile(r"\.env|\.key$|\.pem$|id_rsa|credentials|secret", re.I)

DOCS_SITE_FILES = ("mkdocs.yml", ".readthedocs.yaml", "book.toml", ".gitbook.yaml")


# ---------------------------------------------------------------- git helpers

def git(args: list[str], cwd, *, binary: bool = False):
    p = subprocess.run(["git", "-c", "core.quotepath=off", "-c", "color.ui=never", *args],
                       cwd=cwd, capture_output=True)
    return p.returncode, (p.stdout if binary else p.stdout.decode("utf-8", "replace"))


def nonempty_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip()]


def resolve(ref: str | None, cwd) -> str | None:
    if not ref:
        return None
    rc, out = git(["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], cwd)
    return (out.strip() or None) if rc == 0 else None


def is_ancestor(a: str, b: str, cwd) -> bool:
    return git(["merge-base", "--is-ancestor", a, b], cwd)[0] == 0


def norm_path(p) -> str:
    return os.path.normcase(os.path.normpath(str(p))).replace("\\", "/").rstrip("/")


def repo_facts(cwd) -> dict | None:
    rc, top = git(["rev-parse", "--show-toplevel"], cwd)
    if rc != 0:
        return None
    top = top.strip()
    _, common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], top)
    common = common.strip().rstrip("/")
    main_root = common[: -len("/.git")] if common.endswith("/.git") else common
    rc, branch = git(["symbolic-ref", "--short", "-q", "HEAD"], top)
    return {"top": top, "main_root": main_root, "name": Path(main_root).name,
            "branch": branch.strip() if rc == 0 else "HEAD", "head": resolve("HEAD", top)}


def is_harness(main_root: str) -> bool:
    root = Path(main_root)
    if norm_path(root) == norm_path(HOME_CLAUDE):
        return True
    return (root / "review-rules" / "run.py").is_file() and (root / "skills" / "task-gate").is_dir()


def diff_fingerprint(top, merge_base: str) -> str:
    """sha1 of the merge-base -> working tree diff. Same call in 2.0 and before reviewedSha."""
    git(["add", "-N", "--ignore-removal", "."], top)
    _, raw = git(["diff", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", merge_base],
                 top, binary=True)
    return hashlib.sha1(raw).hexdigest()


# ---------------------------------------------------------------- files and json

def load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")), None
    except FileNotFoundError:
        return {}, None
    except (OSError, ValueError) as exc:
        return {}, f"{type(exc).__name__}: {exc}"


def save_json(path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def capped(items: list, cap: int = LIST_CAP) -> list:
    return items[:cap]


# ---------------------------------------------------------------- classification

def is_test_path(path: str) -> bool:
    parts = path.split("/")
    for seg in parts[:-1]:
        if seg.lower() in TEST_DIRS or re.search(r"[a-z]Test$", seg):
            return True
    return bool(TEST_NAME_RE.search(parts[-1]))


def is_doc_path(path: str) -> bool:
    low = path.lower()
    return low.startswith("docs/") or low.endswith(".md") or low.startswith("improvements/")


def is_harness_instruction(path: str) -> bool:
    return path in HARNESS_FILES or path.startswith(HARNESS_PREFIXES)


def is_review_code(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    if name in REVIEW_CODE_NAMES or name.endswith((".gradle", ".gradle.kts")):
        return True
    if Path(name).suffix.lower() in REVIEW_CODE_EXT:
        return True
    return bool(DEPLOY_RE.search(path)) and not name.startswith(".env")


def is_docs_class(path: str, harness: bool) -> bool:
    """Step 6 docs-only exception: True when the file is documentation, not instructions."""
    name = path.rsplit("/", 1)[-1]
    low = path.lower()
    if name in ("CLAUDE.md", "AGENTS.md", "GEMINI.md") or path.startswith(".claude/"):
        return False
    if harness and (path.startswith(HARNESS_INSTRUCTION_PREFIXES)
                    or (name.startswith("settings") and name.endswith(".json"))):
        return False
    if low.startswith("docs/"):
        return True
    if "/" not in path and low.endswith(".md"):
        return True
    return harness and path.startswith("improvements/")


def summarize(paths: list[str], cap: int = 3) -> str:
    head = ", ".join(paths[:cap])
    return head + (f" и ещё {len(paths) - cap}" if len(paths) > cap else "")


def choose_mode(files: list[str], harness: bool, extra: list[str]):
    """1.1: full if any trigger fires; contract: 5+ CODE files (no docs/**, *.md, tests, improvements/)."""
    code = [f for f in files if not is_doc_path(f) and not is_test_path(f)]
    reasons = []
    if len(code) >= 5:
        reasons.append(f"{len(code)} файлов кода (порог 5; без docs/**, *.md, тестов и improvements/)")
    if harness:
        touched = [f for f in files if is_harness_instruction(f)]
        if touched:
            reasons.append("инструкции или исполняемые файлы ~/.claude: " + summarize(touched))
    deploy = [f for f in files if DEPLOY_RE.search(f)]
    if deploy:
        reasons.append("деплой, инфраструктура или окружение: " + summarize(deploy))
    reasons += [f"главный: {r}" for r in extra if r.strip()]
    return ("full" if reasons else "lite"), reasons, len(code)


# ---------------------------------------------------------------- branch policy

def branch_policy(registry: dict, main_root: str):
    defaults = registry.get("defaults") or {}
    protected = defaults.get("protected") or ["main", "master", "develop", "release/*"]
    trunk = None
    for key, conf in (registry.get("repos") or {}).items():
        if isinstance(conf, dict) and norm_path(key) == norm_path(main_root):
            protected = conf.get("protected") or protected
            trunk = conf.get("trunk") or conf.get("mrTarget")
            break
    return list(protected), trunk, defaults.get("mrTarget")


def detect_trunk(registry_trunk, default_trunk, cwd) -> str | None:
    if registry_trunk:
        return registry_trunk
    rc, out = git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], cwd)
    if rc == 0 and out.strip().startswith("origin/"):
        return out.strip()[len("origin/"):]
    for cand in [c for c in (default_trunk, "main", "master") if c]:
        if resolve(f"origin/{cand}", cwd):
            return cand
    return default_trunk


def is_protected(branch: str | None, patterns: list[str]) -> bool:
    return bool(branch) and any(fnmatch.fnmatchcase(branch, p) for p in patterns)


# ---------------------------------------------------------------- task diff

def task_files(top, ref: str) -> list[str]:
    _, out = git(["diff", "--name-only", ref], top)
    _, untracked = git(["ls-files", "--others", "--exclude-standard"], top)
    return sorted(set(nonempty_lines(out)) | set(nonempty_lines(untracked)))


def merge_base_of(ref: str | None, head: str | None, top) -> str | None:
    if not head:
        return EMPTY_TREE
    if ref is None:
        return head
    rc, out = git(["merge-base", ref, "HEAD"], top)
    return out.strip() if rc == 0 and out.strip() else None


# ---------------------------------------------------------------- TODO scan (2.8, /commit)

def parse_added_todos(diff_text: str) -> list[dict]:
    found, cur, line_no, header = [], None, 0, False
    for line in diff_text.splitlines():
        if line.startswith("diff --git "):
            header, cur = True, None
            continue
        if header:
            if line.startswith("+++ "):
                path = line[4:].rstrip("\t")
                cur = None if path == "/dev/null" else (path[2:] if path.startswith("b/") else path)
                continue
            if not line.startswith("@@"):
                continue
            header = False
        if line.startswith("@@"):
            m = HUNK_RE.match(line)
            line_no = int(m.group(1)) if m else 0
            continue
        if cur is None:
            continue
        if line.startswith("+"):
            if TODO_RE.search(line[1:]) and not is_test_path(cur):
                found.append({"file": cur, "line": line_no, "text": line[1:].strip()[:200]})
            line_no += 1
        elif line.startswith(" "):
            line_no += 1
    return found


def scan_untracked(top, files: list[str]) -> list[dict]:
    found = []
    for f in files:
        if not f.lower().endswith(TODO_EXT) or is_test_path(f):
            continue
        try:
            text = (Path(top) / f).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if TODO_RE.search(line):
                found.append({"file": f, "line": i, "text": line.strip()[:200]})
    return found


def check_anchors(items: list[dict], top, harness: bool) -> list[dict]:
    cache: dict[str, list[str]] = {}
    for it in items:
        if it["file"] not in cache:
            try:
                cache[it["file"]] = (Path(top) / it["file"]).read_text(
                    encoding="utf-8", errors="replace").splitlines()
            except OSError:
                cache[it["file"]] = []
        lines = cache[it["file"]]
        i = it["line"] - 1
        anchor = None
        for text in lines[max(0, i - 1): i + 2]:
            m = PENDING_RE.search(text)
            if m:
                anchor = m.group(1)
                break
            if harness and ISSUE_RE.search(text):
                anchor = "issue"
                break
        it["anchor"] = anchor
        if anchor is None:
            it["state"] = "unbacked"
        elif anchor == "issue" or (Path(top) / anchor).is_file():
            it["state"] = "anchored"
        else:
            it["state"] = "broken_anchor"
    return items


def todo_status(items: list[dict]) -> str:
    states = {it["state"] for it in items}
    if not items:
        return "clean"
    if "unbacked" in states:
        return "unbacked"
    if "broken_anchor" in states:
        return "broken_anchor"
    return "anchors_valid"


def todo_scan(top, ref: str | None, *, staged: bool, harness: bool) -> dict:
    pathspec = [f"*{e}" for e in TODO_EXT]
    if staged:
        _, diff = git(["diff", "--cached", "-U0", "--src-prefix=a/", "--dst-prefix=b/", "--",
                       *pathspec], top)
        untracked: list[str] = []
    else:
        _, diff = git(["diff", "-U0", "--src-prefix=a/", "--dst-prefix=b/", ref or EMPTY_TREE,
                       "--", *pathspec], top)
        _, out = git(["ls-files", "--others", "--exclude-standard"], top)
        untracked = nonempty_lines(out)
    items = check_anchors(parse_added_todos(diff) + scan_untracked(top, untracked), top, harness)
    status = todo_status(items)
    return {"status": status, "count": len(items),
            "unbacked": sum(1 for i in items if i["state"] == "unbacked"),
            "items": capped(items),
            "next": None if status in ("clean", "anchors_valid") else
            "references/deferred-work-scan.md -> «Действие при unbacked TODO»"}


# ---------------------------------------------------------------- 2.7b docs

def docs_check(top, paths: list[str]) -> list[dict]:
    result = []
    for p in paths:
        p = p.strip().replace("\\", "/")
        if not p:
            continue
        exists = (Path(top) / p).exists()
        _, st = git(["status", "--porcelain", "--", p], top)
        in_git = git(["ls-files", "--error-unmatch", "--", p], top)[0] == 0
        if not exists and not in_git:
            state = "missing"
        elif st.strip():
            state = "uncommitted"
        else:
            state = "committed"
        result.append({"path": p, "state": state})
    return result


def docs_gitignored(top) -> bool:
    return git(["check-ignore", "-q", "docs"], top)[0] == 0


# ---------------------------------------------------------------- 5.1 / 5.1.1

def commit_facts(top) -> dict:
    _, st = git(["status", "--porcelain", "-uall"], top)
    entries = []
    for line in st.splitlines():
        if len(line) < 4:
            continue
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        entries.append((line[:2], path.strip('"')))
    suspicious = []
    for code, p in entries:
        reason = "имя" if SUSPICIOUS_RE.search(p) else None
        if reason is None and "D" not in code:
            try:
                if (Path(top) / p).stat().st_size > 1_048_576:
                    reason = "размер > 1 МБ"
            except OSError:
                pass
        if reason:
            suspicious.append({"path": p, "reason": reason})
    return {"dirty": len(entries), "dirty_total": len(entries),
            "dirty_truncated": len(entries) > LIST_CAP,
            "dirty_files": capped([p for _, p in entries]), "suspicious": suspicious}


# ---------------------------------------------------------------- 5.1a

def remote_platform(top) -> str:
    rc, url = git(["remote", "get-url", "origin"], top)
    url = url.strip().lower() if rc == 0 else ""
    if not url:
        return "none"
    return "github" if "github" in url else "gitlab" if "gitlab" in url else "other"


def run_cli(cmd: list[str], cwd):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, timeout=REMOTE_TIMEOUT)
    except FileNotFoundError:
        return None, f"{cmd[0]} не установлен"
    except subprocess.TimeoutExpired:
        return None, f"{cmd[0]}: таймаут {REMOTE_TIMEOUT} с"
    return p, None


def find_open_mr(top, platform: str, branch: str):
    if platform == "github":
        p, err = run_cli(["gh", "pr", "view", branch, "--json", "url,state"], top)
        if err or p.returncode != 0:
            return None, err
        data = json.loads(p.stdout.decode("utf-8", "replace") or "{}")
        return ({"url": data.get("url"), "state": data.get("state")} if data.get("url") else None), None
    p, err = run_cli(["glab", "mr", "list", "--source-branch", branch, "-F", "json"], top)
    if err or p.returncode != 0:
        return None, err
    data = json.loads(p.stdout.decode("utf-8", "replace") or "[]")
    if isinstance(data, list) and data:
        return {"url": data[0].get("web_url"), "state": data[0].get("state")}, None
    return None, None


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def deploy_signals(top, trunk: str | None) -> dict:
    root = Path(top)
    signals = []
    gitlab = read_text(root / ".gitlab-ci.yml")
    if re.search(r"\b(deploy|publish|release)\b", gitlab, re.I):
        signals.append(".gitlab-ci.yml: есть deploy/publish -- сверить rules на транк")
    workflows = root / ".github" / "workflows"
    if workflows.is_dir():
        for f in sorted(list(workflows.glob("*.yml")) + list(workflows.glob("*.yaml"))):
            text = read_text(f)
            on_push = re.search(r"^\s*push\s*:", text, re.M) or re.search(r"\bon\s*:\s*\[?[^\n]*\bpush\b", text)
            if on_push and (not trunk or "branches" not in text or re.search(rf"\b{re.escape(trunk)}\b", text)):
                signals.append(f".github/workflows/{f.name}: on push ({trunk or 'любая ветка'})")
    for name in ("wrangler.toml", "wrangler.jsonc", "wrangler.json"):
        if (root / name).is_file():
            signals.append(f"{name}: Cloudflare Workers -- проверить Workers Builds на транке")
    for name in ("vercel.json", "netlify.toml"):
        if (root / name).is_file():
            signals.append(f"{name}: production branch -- сверить с транком")
    docs_site = [n for n in DOCS_SITE_FILES if (root / n).is_file()]
    docs_site += sorted(p.name for p in root.glob("docusaurus.config.*"))
    return {"signals": signals, "docs_site": docs_site, "checked": "корень репозитория"}


def merge_facts(top, repo: dict, trunk, protected: list[str], harness: bool, remote: bool) -> dict:
    branch = repo["branch"]
    rc, up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], top)
    platform = remote_platform(top)
    open_mr, mr_error = None, None
    if remote and branch and branch != "HEAD" and platform in ("github", "gitlab"):
        try:
            open_mr, mr_error = find_open_mr(top, platform, branch)
        except ValueError as exc:
            mr_error = f"ответ не JSON: {exc}"
    elif not remote:
        mr_error = "не проверялось (--no-remote)"
    docs_only, non_doc = None, []
    base = resolve(f"origin/{trunk}", top) if trunk else None
    mb = merge_base_of(base, repo["head"], top) if base else None
    if mb:
        files = task_files(top, mb)
        non_doc = [f for f in files if not is_docs_class(f, harness)]
        docs_only = bool(files) and not non_doc
    return {"branch": branch, "trunk": trunk, "protected": is_protected(branch, protected),
            "upstream": up.strip() if rc == 0 else None, "platform": platform,
            "open_mr": open_mr, "open_mr_error": mr_error, "deploy": deploy_signals(top, trunk),
            "docs_only_files": docs_only, "non_doc_files": capped(non_doc, 10)}


# ---------------------------------------------------------------- 2.0: L1 and review package

def run_l1(top, base_sha: str | None, scratch: Path, short: str, stats_dir: Path,
           runner: Path | None = None) -> dict:
    """L1 once per gate. run.py exits 0 (clean / non-blocking), 1 (static HIGH), 2 (bad
    arguments), 3 (tool error). Anything but 0/1, or no stdout, is a failed L1 -- never
    "static clean": a silent [] here would skip L2 and unblock static HIGH."""
    out_path = scratch / f"l1-{short}.json"
    cmd = [sys.executable, str(runner or HARNESS_ROOT / "review-rules" / "run.py"), "--changed-only",
           "--json", "--log", str(stats_dir / "review-rules-events.jsonl"), "--entry", "endsession"]
    if base_sha:
        cmd[2:2] = ["--base", base_sha]
    t0 = time.monotonic()
    p = subprocess.run(cmd, cwd=top, capture_output=True)
    sec = round(time.monotonic() - t0)
    stdout = p.stdout.decode("utf-8", "replace")
    stderr_tail = p.stderr.decode("utf-8", "replace").strip()[-300:]
    out_path.write_text(stdout, encoding="utf-8")
    res = {"ran": True, "json": str(out_path), "exit": p.returncode, "sec": sec,
           "static_high": 0, "static": 0, "runtime": 0, "error": None}
    if p.returncode not in (0, 1) or not stdout.strip():
        res["error"] = f"run.py exit {p.returncode}: {stderr_tail or 'пустой вывод'}"
        return res
    try:
        findings = json.loads(stdout)
        if not isinstance(findings, list):
            raise ValueError("ожидался JSON-массив")
    except ValueError as exc:
        res["error"] = f"run.py exit {p.returncode}: вывод не JSON ({exc}); {stderr_tail}"[:400]
        return res
    res["static_high"] = sum(1 for r in findings if r.get("mode") == "static" and r.get("severity") == "high")
    res["static"] = sum(1 for r in findings if r.get("mode") == "static")
    res["runtime"] = sum(1 for r in findings if r.get("mode") == "runtime")
    return res


def write_package(top, merge_base: str, head: str | None, path: Path, label: str) -> dict:
    git(["add", "-N", "--ignore-removal", "."], top)
    _, stat = git(["diff", "--stat", merge_base], top)
    if not stat.strip():
        return {"skip": "пустой дифф"}
    _, names = git(["diff", "--name-only", merge_base], top)
    files = nonempty_lines(names)
    _, raw = git(["diff", "--src-prefix=a/", "--dst-prefix=b/", merge_base], top, binary=True)
    truncated = None
    if len(raw) > PACKAGE_LIMIT:
        _, raw = git(["diff", "--src-prefix=a/", "--dst-prefix=b/", merge_base, "--", ".",
                      ":(exclude)*.lock", ":(exclude)*-lock.json", ":(exclude)*.svg"], top, binary=True)
        truncated = "исключены *.lock, *-lock.json, *.svg: полный дифф больше 2 МБ"
    log = git(["log", "--oneline", f"{merge_base}..HEAD"], top)[1] if head and merge_base != EMPTY_TREE else ""
    header = (f"# Review package ({label})\n\nБАЗА: {merge_base} -> рабочее дерево\n"
              + (f"УСЕЧЕНО: {truncated}\n" if truncated else "")
              + f"\n## Файлы\n{stat}\n## Коммиты\n{log or '(нет)'}\n\n## Дифф\n")
    path.write_bytes(header.encode("utf-8") + raw)
    return {"skip": None, "package": str(path), "files": len(files),
            "has_code": any(is_review_code(f) for f in files), "truncated": truncated}


def review_facts(top, repo, state, base_sha, trunk, protected, scratch: Path, short: str) -> dict:
    head = repo["head"]
    reviewed = resolve(state.get("reviewedSha"), top)
    if reviewed and head and is_ancestor(reviewed, "HEAD", top):
        base, source = reviewed, "reviewedSha"
    elif not is_protected(repo["branch"], protected) and trunk:
        base, source = f"origin/{trunk}", f"origin/{trunk}"
        if not resolve(base, top):
            return {"base": base, "base_source": source,
                    "skip": f"база {base} не резолвится (git fetch origin {trunk})"}
    elif base_sha:
        base, source = base_sha, "BASE_SHA"
    else:
        base, source = None, "HEAD (рабочее дерево)"
    mb = merge_base_of(base, head, top)
    if not mb:
        return {"base": base, "base_source": source, "skip": f"нет merge-base у {base} и HEAD"}
    pkg = write_package(top, mb, head, scratch / f"review-package-{short}.md", "2.3b")
    res = {"base": base, "base_source": source, "merge_base": mb,
           "repeat": source == "reviewedSha", **pkg}
    if not pkg["skip"]:
        res["fingerprint"] = diff_fingerprint(top, mb)
        res["over_30_files"] = pkg["files"] > 30
    return res


# ---------------------------------------------------------------- main

def prepare(args, cwd) -> dict:
    t_start = time.time()
    repo = repo_facts(cwd)
    if repo is None:
        return {"git": False, "note": "не git-репозиторий: шаги с git -> ✅ N/A (no git)"}
    top, head = repo["top"], repo["head"]
    harness = is_harness(repo["main_root"])

    if args.todo_only:
        return {"git": True, "todo": todo_scan(top, head or EMPTY_TREE, staged=args.staged,
                                               harness=harness)}
    if args.docs_only:
        return {"git": True, "docs": {"gitignored": docs_gitignored(top),
                                      "paths": docs_check(top, args.docs_only)}}

    scratch = Path(args.scratchpad) if args.scratchpad else Path(tempfile.gettempdir()) / "task-gate"
    scratch.mkdir(parents=True, exist_ok=True)
    stats_dir = Path(args.stats_dir) if args.stats_dir else HOME_CLAUDE / "stats"
    state_path = Path(args.state) if args.state else scratch / "task-gate-state.json"
    state, state_error = load_json(state_path)
    if not isinstance(state, dict):
        state, state_error = {}, "state не JSON-объект"
    registry, registry_error = load_json(
        Path(args.registry) if args.registry else HOME_CLAUDE / "config" / "protected-branches.local.json")
    protected, reg_trunk, default_trunk = branch_policy(registry if isinstance(registry, dict) else {},
                                                        repo["main_root"])
    trunk = detect_trunk(reg_trunk, default_trunk, top)

    base_sha, base_source = None, "none (рабочее дерево)"
    for source, ref in (("lastGateSha", state.get("lastGateSha")), ("startSha", args.start_sha)):
        sha = resolve(ref, top)
        if sha:
            base_sha, base_source = sha, source
            break
    task_ref = base_sha or head or EMPTY_TREE
    files = task_files(top, task_ref)
    mode, reasons, code_count = choose_mode(files, harness, args.full or [])
    files_excl_docs = sum(1 for f in files if not f.startswith("docs/"))
    short = (head or "nohead")[:10]

    review = review_facts(top, repo, state, base_sha, trunk, protected, scratch, short)
    l1 = {"ran": False, "note": "--no-l1"} if args.no_l1 else run_l1(top, base_sha, scratch, short, stats_dir)
    if (l1.get("static") or l1.get("error")) and not review.get("skip"):
        l2_mb = merge_base_of(base_sha, head, top)
        if l2_mb and l2_mb != review.get("merge_base"):
            l2 = write_package(top, l2_mb, head, scratch / f"review-package-l2-{short}.md", "L2")
            review["l2_package"] = l2.get("package")
        else:
            review["l2_package"] = review.get("package")

    result = {
        "git": True,
        "repo": {"name": repo["name"], "top": top, "branch": repo["branch"], "head": head,
                 "harness": harness},
        "state": {"path": str(state_path), "error": state_error,
                  "gate_run": int(state.get("gateRuns", 0)) + 1,
                  "once_done": state.get("onceChecks") or {},
                  "artifact_server": state.get("artifactServer")},
        "scratchpad": str(scratch) + ("" if args.scratchpad else " (по умолчанию: передай --scratchpad)"),
        "base": {"sha": base_sha, "source": base_source},
        "task": {"files_total": len(files), "code_files": code_count,
                 "files_excl_docs": files_excl_docs, "files": capped(files)},
        "mode": {"value": mode, "reasons": reasons,
                 "judgement": "новый модуль, миграция, публичный контракт, деплой без CI-файла, "
                              "просьба пользователя: --full \"<причина>\" -- при первом запуске; "
                              "поднять режим после -- --mode full в gate-log.py, gate-prep.py "
                              "не перезапускать (второй прогон L1)"},
        "l1": l1,
        "review": review,
        "todo": todo_scan(top, task_ref, staged=False, harness=harness),
        "docs": {"gitignored": docs_gitignored(top)},
        "commit": commit_facts(top),
        "merge": merge_facts(top, repo, trunk, protected, harness, not args.no_remote),
        "registry_error": registry_error,
    }
    state["prep"] = {"ts": int(t_start), "mode": mode, "files": files_excl_docs,
                     "l1Sec": l1.get("sec"), "baseSha": base_sha,
                     "review": {"mergeBase": review.get("merge_base"),
                                "fingerprint": review.get("fingerprint")},
                     "logged": False}
    save_json(state_path, state)
    return result


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="facts for /task-gate (Step 1, 2.0, 2.7b, 2.8, 5.1a)")
    ap.add_argument("--scratchpad", help="session scratchpad: state file and review packages")
    ap.add_argument("--state", help="state file (default: <scratchpad>/task-gate-state.json)")
    ap.add_argument("--start-sha", help="START_SHA of the session, used when there is no lastGateSha")
    ap.add_argument("--full", action="append", metavar="REASON",
                    help="force full: new module/migration/contract, deploy, user request")
    ap.add_argument("--todo-only", action="store_true", help="only the TODO scan (2.8, /commit)")
    ap.add_argument("--staged", action="store_true", help="with --todo-only: staged diff only")
    ap.add_argument("--docs-only", nargs="+", metavar="PATH", help="only the 2.7b check of these paths")
    ap.add_argument("--no-l1", action="store_true", help="skip review-rules/run.py (tests)")
    ap.add_argument("--no-remote", action="store_true", help="skip gh/glab calls")
    ap.add_argument("--stats-dir", help="stats directory (default: ~/.claude/stats)")
    ap.add_argument("--registry", help="protected-branches registry (default: ~/.claude/config/...)")
    return ap


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    print(json.dumps(prepare(args, os.getcwd()), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # tool error, never a finding
        sys.stderr.write(f"gate-prep: internal error: {type(exc).__name__}: {exc}\n")
        sys.exit(3)
