#!/usr/bin/env python3
"""harness-doctor: проверка машины, харнесса ~/.claude и проекта; починка по --fix.

Детерминированная часть скиллов `harness-doctor` и `setup`. Смысловой разбор
конфликтов инструкций делает агент по SKILL.md — скрипт только собирает список
источников (`instructions`) и ловит механические конфликты: тень агента или
скилла, allow против глобального deny, дубль хука, ссылка на несуществующего
агента.

Запуск:
  python doctor.py [--project PATH] [--fix] [--account EMAIL] [--json]
                   [--no-install] [--skip-index]

Статусы: ok · warn · fail · info. Код выхода 1 — остался хотя бы один fail.
Вид починки (`fix.kind`):
  auto   — скрипт чинит сам по --fix (CLI через winget, индекс ast-index,
           записи в gitignored-реестрах ~/.claude/config, git-хуки харнесса);
  edit   — правка tracked-файла проекта; применяет агент через worktree проекта;
  input  — нужен ответ пользователя (почта аккаунта для реестра кредов);
  manual — только руками пользователя (логин, установка с UAC, плагин).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

IS_WIN = sys.platform == "win32"
CLAUDE_MD_LINES = 200        # те же пороги, что у hooks/claude-md-size-guard.py
CLAUDE_MD_CHARS = 17500
ANDROID_CLI_MIN = "1.1.16919734"  # references/android-device-flows.md
SKIP_DIRS = {".git", "node_modules", "build", ".gradle", ".idea", "dist", ".next",
             "out", "target", ".venv", "venv", "__pycache__", ".claude", ".kotlin"}
WORKTREE_CANDIDATES = {"local.properties", "google-services.json", "GoogleService-Info.plist",
                       ".env", ".env.local", ".env.development", ".dev.vars",
                       "keystore.properties", "secrets.properties", "signing.properties"}

# id, exe, нужен когда (стек-ключ), winget id, npm-пакет, min-версия, почему
TOOLS = [
    ("git", "git", "always", "Git.Git", None, None, "ветки, worktree, хуки"),
    ("node", "node", "always", "OpenJS.NodeJS.LTS", None, None, "хуки харнесса на node"),
    ("python", "python", "always", "Python.Python.3.12", None, None, "хуки и скрипты скиллов"),
    ("pwsh", "pwsh", "always", "Microsoft.PowerShell", None, None, "хуки .ps1 (SessionStart, worktree)"),
    ("gh", "gh", "always", "GitHub.cli", None, None, "PR, issue, merge"),
    ("jq", "jq", "always", "jqlang.jq", None, None, "плагин warp, скрипты"),
    ("ast-index", "ast-index", "always", "defendend.ast-index", None, None, "поиск символов (CLAUDE.md)"),
    ("rg", "rg", "optional", "BurntSushi.ripgrep.MSVC", None, None, "быстрый поиск в скриптах"),
    ("uv", "uv", "python", "astral-sh.uv", None, None, "Python-проекты, google-ads MCP"),
    ("android", "android", "android", "Google.AndroidCLI", None, ANDROID_CLI_MIN,
     "дерево UI, preview render, device-flows"),
    ("adb", "adb", "android", "Google.PlatformTools", None, None, "установка APK, устройство"),
    ("firebase", "firebase", "firebase", None, "firebase-tools", None, "деплой Firebase"),
    ("gcloud", "gcloud", "firebase", "Google.CloudSDK", None, None, "Cloud Functions, логи, креды"),
    ("glab", "glab", "gitlab", "GLab.GLab", None, None, "MR в GitLab"),
    # gitleaks локально не требуем: hooks/pre-commit зовёт его, только если он стоит
]
# gcloud ставится в Program Files и просит UAC — молча не ставим (memory: dev-tools-update-pitfalls)
MANUAL_INSTALL = {"gcloud"}


# ---------------------------------------------------------------- утилиты
def run(cmd, cwd=None, timeout=60):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout,
                           creationflags=(0x08000000 if IS_WIN else 0))  # CREATE_NO_WINDOW
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"


def which(exe):
    p = shutil.which(exe)
    if p or not IS_WIN:
        return p
    links = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / f"{exe}.exe"
    return str(links) if links.exists() else None


def norm(p) -> str:
    return str(p).replace("\\", "/").rstrip("/").lower()


def glob_re(pat: str) -> re.Pattern:
    """gitignore/rules-подобный glob → regex по posix-пути: **, *, ?."""
    out, i = "", 0
    while i < len(pat):
        if pat.startswith("**/", i):
            out += "(?:.*/)?"; i += 3
        elif pat.startswith("**", i):
            out += ".*"; i += 2
        elif pat[i] == "*":
            out += "[^/]*"; i += 1
        elif pat[i] == "?":
            out += "[^/]"; i += 1
        else:
            out += re.escape(pat[i]); i += 1
    return re.compile(out + r"\Z")


def version_tuple(s: str):
    return tuple(int(x) for x in re.findall(r"\d+", s)[:4])


def write_registry(path: Path, text: str):
    """Реестр ~/.claude/config — gitignored, истории нет: копия перед каждой правкой."""
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + ".bak-doctor"))
    path.write_text(text, encoding="utf-8")


def walk(root: Path, max_depth=4):
    root_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        d = Path(dirpath)
        if len(d.parts) - root_depth >= max_depth:
            dirnames[:] = []
        dirnames[:] = [n for n in dirnames if n not in SKIP_DIRS]
        for f in filenames:
            yield d / f


class Report:
    def __init__(self):
        self.checks = []

    def add(self, area, cid, status, msg, fix=None):
        c = {"area": area, "id": cid, "status": status, "message": msg}
        if fix:
            c["fix"] = fix
        self.checks.append(c)
        return c


# ---------------------------------------------------------------- проект
def git_info(project: Path):
    rc, top, _ = run(["git", "rev-parse", "--show-toplevel"], cwd=project)
    if rc != 0:
        return None
    root = Path(top)
    _, common, _ = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=root)
    main_root = Path(common).parent if common else root
    _, branch, _ = run(["git", "branch", "--show-current"], cwd=root)
    rc, head, _ = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd=root)
    trunk = head.split("/", 1)[1] if rc == 0 and "/" in head else None
    if not trunk:
        for cand in ("develop", "main", "master"):
            if run(["git", "rev-parse", "--verify", "-q", cand], cwd=root)[0] == 0:
                trunk = cand
                break
    _, remote, _ = run(["git", "remote", "get-url", "origin"], cwd=root)
    return {"root": root, "main_root": main_root, "is_worktree": norm(root) != norm(main_root),
            "branch": branch, "trunk": trunk or "main", "remote": remote}


def detect_stacks(root: Path):
    stacks = set()
    rc, out, _ = run(["ast-index", "--format", "json", "detect-stacks"], cwd=root, timeout=60)
    if rc == 0 and out.startswith("{"):
        try:
            data = json.loads(out)
            stacks |= {s["kind"] for s in data.get("stacks", [])}
            if data.get("is_kmp"):
                stacks.add("kmp")
        except (ValueError, KeyError):
            pass
    names = {p.name for p in walk(root, 3)}
    if names & {"settings.gradle.kts", "settings.gradle"}:
        stacks.add("android")
    if "package.json" in names:
        stacks.add("web")
    if names & {"pyproject.toml", "requirements.txt"}:
        stacks.add("python")
    if names & {".firebaserc", "firebase.json", "google-services.json"}:
        stacks.add("firebase")
    if names & {"wrangler.toml", "wrangler.json", "wrangler.jsonc"}:
        stacks.add("cloudflare")
    if "kmp" in stacks:
        stacks.add("android")
    return stacks


def android_app_ids(root: Path):
    ids = []
    for p in walk(root, 3):
        if p.name in ("build.gradle.kts", "build.gradle"):
            txt = p.read_text(encoding="utf-8", errors="replace")
            if "com.android.application" in txt or "androidApplication" in txt:
                ids += re.findall(r'applicationId\s*=?\s*"([^"]+)"', txt)
    return ids


def infer_credentials(root: Path, gi):
    vals = {"gcp_project": "", "cf_account_id": "", "firebase_project": "",
            "play_package": "", "git_remote": gi["remote"] if gi else ""}
    rc_file = root / ".firebaserc"
    if rc_file.exists():
        try:
            vals["firebase_project"] = json.loads(rc_file.read_text(encoding="utf-8")) \
                .get("projects", {}).get("default", "")
        except ValueError:
            pass
    if not vals["firebase_project"]:
        for p in walk(root, 4):
            if p.name == "google-services.json":
                try:
                    vals["firebase_project"] = json.loads(p.read_text(encoding="utf-8")) \
                        .get("project_info", {}).get("project_id", "")
                except ValueError:
                    pass
                break
    vals["gcp_project"] = vals["firebase_project"]  # Firebase-проект и есть GCP-проект
    for name in ("wrangler.jsonc", "wrangler.json", "wrangler.toml"):
        f = root / name
        if f.exists():
            m = re.search(r'account_id\W+([0-9a-f]{32})', f.read_text(encoding="utf-8", errors="replace"))
            if m:
                vals["cf_account_id"] = m.group(1)
    ids = android_app_ids(root)
    if ids:
        vals["play_package"] = ids[0]
    return vals


def registry_match_protected(data, root: Path):
    """Как repoKeyMatch в hooks/protected-branch-guard.js: граница сегмента, первый по порядку."""
    r = norm(root) + "/"
    for key in data.get("repos", {}):
        k = norm(key) + "/"
        if k != "/" and (r == k or r.startswith(k) or ("/" + k) in r):
            return key
    return None


def credentials_rows(text: str):
    rows = []
    for line in text.splitlines():
        if line.startswith("|") and not re.match(r"^\|\s*-", line):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells and cells[0] != "repo_path":
                rows.append(cells)
    return rows


CREDENTIALS_HEADER = ("| repo_path | account | gcp_project | cf_account_id | firebase_project | play_package | git_remote |\n"
                      "|---|---|---|---|---|---|---|")


def insert_credentials_row(text: str, row: str) -> str:
    """Строка — в конец таблицы с заголовком `repo_path`, не в соседние таблицы файла."""
    lines = text.splitlines()
    head = next((i for i, l in enumerate(lines) if l.startswith("|") and "repo_path" in l), None)
    if head is None:
        return (text.rstrip("\n") + "\n\n" if text.strip() else "") + CREDENTIALS_HEADER + "\n" + row + "\n"
    end = head
    while end + 1 < len(lines) and lines[end + 1].startswith("|"):
        end += 1
    lines.insert(end + 1, row)
    return "\n".join(lines) + "\n"


def credentials_match(rows, root: Path):
    r = norm(root)
    for cells in sorted(rows, key=lambda c: -len(c[0])):
        rp = norm(cells[0])
        if rp and re.search(r"(^|/)" + re.escape(rp) + r"(/|$)", r):
            return cells
    return None


def worktreeinclude_covers(patterns, rel: str) -> bool:
    base = rel.rsplit("/", 1)[-1]
    for pat in patterns:
        p = pat.strip()
        if not p or p.startswith("#") or p.startswith("!"):
            continue
        anchored, is_dir = p.startswith("/"), p.endswith("/")
        p = p.strip("/")
        if is_dir and "/" not in p and not anchored:
            # `config/` — каталог с этим именем на любой глубине
            if any(glob_re(p).match(seg) for seg in rel.split("/")[:-1]):
                return True
        elif "/" not in p and not anchored:
            if glob_re(p).match(base):
                return True
        elif glob_re(p).match(rel) or rel.startswith(p + "/"):
            return True
    return False


def check_project(rep: Report, project: Path, harness: Path, args):
    gi = git_info(project)
    if not gi:
        rep.add("project", "git", "info", f"{project} — не git-репозиторий: worktree, реестр веток и PR-флоу не применяются")
        stacks = detect_stacks(project)
        return {"root": str(project), "stacks": sorted(stacks), "git": False}, stacks, project
    root, main_root = gi["root"], gi["main_root"]
    is_harness = norm(main_root) == norm(harness)
    # у харнесса маркеры стеков лежат в шаблонах скиллов и вложенных репо — не его стек
    stacks = {"harness"} if is_harness else detect_stacks(root)
    if "gitlab" in gi["remote"]:
        stacks.add("gitlab")
    rep.add("project", "git", "ok",
            f"репозиторий {main_root}, ветка {gi['branch'] or '(detached)'}, транк {gi['trunk']}"
            + (", сессия в worktree" if gi["is_worktree"] else ""))
    rep.add("project", "stacks", "info", "стек: " + (", ".join(sorted(stacks)) or "не определён"))

    # реестр защищённых веток
    pb = harness / "config" / "protected-branches.local.json"
    if not is_harness:
        try:
            data = json.loads(pb.read_text(encoding="utf-8")) if pb.exists() else {"defaults": {}, "repos": {}}
        except ValueError:
            data = None
            rep.add("project", "protected-branches", "fail", f"{pb} — невалидный JSON",
                    {"kind": "manual", "how": "почини JSON руками; бэкап не трогаем"})
        if data is not None:
            key = registry_match_protected(data, main_root)
            if key:
                rep.add("project", "protected-branches", "ok", f"запись в реестре веток: {key}")
            else:
                existing = [b for b in ("main", "master", "develop")
                            if run(["git", "rev-parse", "--verify", "-q", b], cwd=root)[0] == 0]
                entry = {"label": main_root.name, "trunk": gi["trunk"], "mrTarget": gi["trunk"],
                         "protected": sorted(set(existing + [gi["trunk"]])) + ["release/*"]}
                c = rep.add("project", "protected-branches", "fail", "репозитория нет в реестре защищённых веток",
                            {"kind": "auto", "how": f"добавить в {pb.name}: {json.dumps(entry, ensure_ascii=False)}"})
                if args.fix:
                    data.setdefault("repos", {})[str(main_root)] = entry
                    write_registry(pb, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
                    c["status"], c["fixed"] = "ok", True

    # реестр кредов — только если у проекта есть куда деплоить
    deploy = stacks & {"firebase", "cloudflare"} or android_app_ids(root)
    pc = harness / "config" / "project-credentials.local.md"
    if deploy and not is_harness:
        text = pc.read_text(encoding="utf-8") if pc.exists() else ""
        row = credentials_match(credentials_rows(text), main_root)
        if row:
            rep.add("project", "project-credentials", "ok", f"строка в реестре кредов: {row[0]} → {row[1] if len(row) > 1 else '?'}")
        else:
            vals = infer_credentials(root, gi)
            cols = [str(main_root), args.account or "<account>", vals["gcp_project"], vals["cf_account_id"],
                    vals["firebase_project"], vals["play_package"], vals["git_remote"]]
            line = "| " + " | ".join(cols) + " |"
            kind = "auto" if args.account else "input"
            c = rep.add("project", "project-credentials", "fail",
                        "у проекта есть деплой, а строки в реестре кредов нет — credentials-guard будет отклонять деплой",
                        {"kind": kind, "how": f"строка для {pc.name}: {line}",
                         "need": None if args.account else "почта аккаунта для деплоя → --account"})
            if args.fix and args.account:
                write_registry(pc, insert_credentials_row(text, line))
                c["status"], c["fixed"] = "ok", True

    # индекс ast-index — живёт у основного checkout'а, worktree читает его через хук
    if which("ast-index") and not args.skip_index:
        rc, out, _ = run(["ast-index", "--format", "json", "stats"], cwd=main_root, timeout=60)
        if out.startswith("{"):
            st = json.loads(out).get("stats", {})
            n = st.get("file_count", 0)
            rep.add("project", "ast-index", "ok" if n else "warn", f"индекс ast-index: {n} файлов, {st.get('symbol_count', 0)} символов")
        else:
            c = rep.add("project", "ast-index", "fail", "у проекта нет индекса ast-index — поиск символов не работает",
                        {"kind": "auto", "how": f"ast-index rebuild в {main_root} (основной checkout, не worktree)"})
            if args.fix:
                rc, out, err = run(["ast-index", "rebuild"], cwd=main_root, timeout=1800)
                if rc == 0:
                    c["status"], c["fixed"] = "ok", True
                else:
                    c["message"] += f"; rebuild упал: {(err or out)[-300:]}"

    # .worktreeinclude — gitignored-конфиги, без которых сборка в worktree не стартует
    wti = main_root / ".worktreeinclude"
    patterns = wti.read_text(encoding="utf-8").splitlines() if wti.exists() else []
    missing = []
    for p in walk(main_root, 4):
        if p.name in WORKTREE_CANDIDATES:
            rel = p.relative_to(main_root).as_posix()
            if run(["git", "check-ignore", "-q", rel], cwd=main_root)[0] == 0 and not worktreeinclude_covers(patterns, rel):
                missing.append(rel)
    if missing:
        rep.add("project", "worktreeinclude", "fail",
                "gitignored-конфиги не копируются в новый worktree: " + ", ".join(missing),
                {"kind": "edit", "file": str(wti), "append": missing})
    else:
        rep.add("project", "worktreeinclude", "ok", ".worktreeinclude покрывает gitignored-конфиги")

    if not is_harness:
        if run(["git", "check-ignore", "-q", "--no-index", ".claude/worktrees/x"], cwd=main_root)[0] == 0:
            rep.add("project", "gitignore-worktrees", "ok", ".claude/worktrees/ в .gitignore")
        else:
            rep.add("project", "gitignore-worktrees", "fail",
                    ".claude/worktrees/ не в .gitignore — worktree попадут в git status и в коммит",
                    {"kind": "edit", "file": str(main_root / ".gitignore"), "append": [".claude/worktrees/"]})

    if "android" in stacks:
        flows = main_root / "tests" / "device-flows"
        rep.add("project", "device-flows", "ok" if flows.exists() else "info",
                "tests/device-flows/ есть" if flows.exists()
                else "tests/device-flows/ нет — появится после первого /mcp-mobile-test")
    info = {"root": str(root), "main_root": str(main_root), "is_worktree": gi["is_worktree"],
            "trunk": gi["trunk"], "stacks": sorted(stacks), "git": True, "is_harness": is_harness}
    return info, stacks, main_root


# ---------------------------------------------------------------- инструкции
def frontmatter_paths(text: str):
    m = re.match(r"---\s*\n(.*?)\n---", text, re.S)
    if not m:
        return None
    block = re.search(r"^paths:\s*\n((?:\s+-.*\n?)+)", m.group(1) + "\n", re.M)
    if not block:
        return None
    return [x.strip().strip("-").strip().strip("\"'") for x in block.group(1).splitlines() if x.strip()]


def collect_instructions(rep: Report, root: Path, harness: Path, is_git: bool):
    sources = []

    def add(path: Path, scope):
        t = path.read_text(encoding="utf-8", errors="replace")
        sources.append({"path": str(path), "scope": scope, "lines": t.count("\n") + 1, "chars": len(t)})
        return t

    g = harness / "CLAUDE.md"
    if g.exists():
        add(g, "global")
    files = []
    if is_git:
        _, out, _ = run(["git", "ls-files"], cwd=root, timeout=60)
        files = out.splitlines()[:50000]
    for rule in sorted((harness / "rules").glob("*.md")):
        paths = frontmatter_paths(rule.read_text(encoding="utf-8", errors="replace"))
        if paths is None or any(glob_re(p).match(f) for p in paths for f in files):
            add(rule, "global-rule")
    if norm(root) == norm(harness):
        return sources
    for name, scope in (("CLAUDE.md", "project"), (".claude/CLAUDE.md", "project"),
                        ("CLAUDE.local.md", "project-local"), ("AGENTS.md", "project-agents-md")):
        p = root / name
        if p.exists():
            t = add(p, scope)
            if scope == "project" and (t.count("\n") + 1 > CLAUDE_MD_LINES or len(t) > CLAUDE_MD_CHARS):
                rep.add("instructions", "size", "warn",
                        f"{name}: {t.count(chr(10)) + 1} строк / {len(t)} символов — выше порога "
                        f"{CLAUDE_MD_LINES}/{CLAUDE_MD_CHARS}; вынеси детали в .claude/rules/ с paths")
    for p in sorted((root / ".claude" / "rules").glob("*.md")):
        add(p, "project-rule")
    for p in walk(root, 4):
        if p.name == "CLAUDE.md" and p.parent != root and ".claude" not in p.parts:
            add(p, "nested")
    return sources


def merge_settings(*parts):
    """Глубокое слияние: словари — рекурсивно, списки (allow, deny, хуки события) — сложением."""
    out = {}
    for part in parts:
        for k, v in part.items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = merge_settings(out[k], v)
            elif isinstance(v, list) and isinstance(out.get(k), list):
                out[k] = out[k] + v
            else:
                out[k] = v
    return out


def check_mechanical_conflicts(rep: Report, root: Path, harness: Path):
    if norm(root) == norm(harness):
        return
    for kind in ("agents", "skills"):
        local = root / ".claude" / kind
        if not local.exists():
            continue
        names = {p.stem if kind == "agents" else p.name for p in local.iterdir()}
        glob_names = {p.stem if kind == "agents" else p.name for p in (harness / kind).iterdir()} \
            if (harness / kind).exists() else set()
        for n in sorted(names & glob_names):
            rep.add("instructions", f"shadow-{kind}", "warn",
                    f"проектный {kind[:-1]} `{n}` перекрывает глобальный — глобальная версия в этом проекте не действует",
                    {"kind": "edit", "how": "переименуй проектный или удали, если он устарел"})
    gs = load_json(harness / "settings.json")
    ps = merge_settings(load_json(root / ".claude" / "settings.json"),
                        load_json(root / ".claude" / "settings.local.json"))
    gdeny = set(gs.get("permissions", {}).get("deny", []))
    for a in ps.get("permissions", {}).get("allow", []):
        if a in gdeny:
            rep.add("instructions", "allow-vs-deny", "warn",
                    f"проект разрешает `{a}`, глобальный settings.json это запрещает (deny сильнее — правило мёртвое)",
                    {"kind": "edit", "how": "удали мёртвое allow из .claude/settings*.json проекта"})
    for key in ("outputStyle", "model"):
        if key in ps and key in gs and ps[key] != gs[key]:
            rep.add("instructions", f"override-{key}", "info", f"проект меняет {key}: {gs[key]} → {ps[key]}")
    gcmds = {h.get("command") for arr in gs.get("hooks", {}).values() for m in arr for h in m.get("hooks", [])}
    for ev, arr in ps.get("hooks", {}).items():
        for m in arr:
            for h in m.get("hooks", []):
                if h.get("command") in gcmds:
                    rep.add("instructions", "hook-dup", "warn",
                            f"хук {ev} `{h['command'][:80]}` есть и в глобальном, и в проектном settings — "
                            "проектная копия лишняя и разойдётся с глобальной при правке",
                            {"kind": "edit", "how": "удали дубль из проектного settings"})
    agents = {p.stem for p in (harness / "agents").glob("*.md")} | \
             {p.stem for p in (root / ".claude" / "agents").glob("*.md")}
    for name in ("CLAUDE.md", ".claude/CLAUDE.md"):
        p = root / name
        if not p.exists():
            continue
        text = re.sub(r"```.*?```", "", p.read_text(encoding="utf-8", errors="replace"), flags=re.S)
        for ref in sorted(set(re.findall(r"(?<![\w.])@([a-z][a-z0-9]*-[a-z0-9-]+)(?![\w/-])", text))):
            if ref not in agents:
                rep.add("instructions", "dead-agent-ref", "warn",
                        f"{name} ссылается на агента @{ref}, которого нет ни в ~/.claude/agents, ни в .claude/agents",
                        {"kind": "edit", "how": "замени на актуального агента или удали"})


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except ValueError:
        return {}


# ---------------------------------------------------------------- машина и харнесс
def check_tools(rep: Report, stacks, args):
    need = {"always"} | stacks
    for tid, exe, when, winget, npm, minv, why in TOOLS:
        if when not in need and when != "optional":
            continue
        path = which(exe)
        if path:
            if minv:
                _, out, _ = run([path, "--version"], timeout=30)
                if not version_tuple(out):
                    rep.add("machine", tid, "warn", f"{tid} — {path}: версия не читается, минимум {minv} не проверен")
                    continue
                if version_tuple(out) < version_tuple(minv):
                    c = rep.add("machine", tid, "fail", f"{tid} {out or '?'} ниже {minv} — {why}",
                                {"kind": "auto", "how": f"winget upgrade -e --id {winget}"})
                    if args.fix and not args.no_install and IS_WIN:
                        rc, _, err = run(["winget", "upgrade", "-e", "--id", winget, "--silent",
                                          "--accept-source-agreements", "--accept-package-agreements"], timeout=900)
                        if rc == 0:
                            c["status"], c["fixed"] = "ok", True
                    continue
            rep.add("machine", tid, "ok", f"{tid} — {path}")
            if tid == "gh" and run([path, "auth", "status"], timeout=30)[0] != 0:
                rep.add("machine", "gh-auth", "warn", "gh не залогинен — PR и issue не создаются",
                        {"kind": "manual", "how": "! gh auth login"})
            continue
        status = "info" if when == "optional" else "fail"
        if tid in MANUAL_INSTALL or not IS_WIN or (not winget and not npm):
            how = (f"winget install -e --id {winget}" if winget else f"npm i -g {npm}")
            rep.add("machine", tid, status, f"{tid} не найден — {why}", {"kind": "manual", "how": how})
            continue
        how = f"winget install -e --id {winget}" if winget else f"npm i -g {npm}"
        c = rep.add("machine", tid, status, f"{tid} не найден — {why}", {"kind": "auto", "how": how})
        if args.fix and not args.no_install and when != "optional":
            cmd = (["winget", "install", "-e", "--id", winget, "--silent",
                    "--accept-source-agreements", "--accept-package-agreements"]
                   if winget else ["npm", "i", "-g", npm])
            if not winget and IS_WIN:
                cmd = ["cmd", "/c"] + cmd
            rc, out, err = run(cmd, timeout=900)
            if rc == 0:
                c["status"], c["fixed"] = "ok", True
                c["message"] += "; установлен — если CLI не виден, перезапусти терминал"
            else:
                c["message"] += f"; установка упала: {(err or out)[-300:]}"


def is_abs_missing(key: str) -> bool:
    """Ключ реестра — абсолютный путь, а каталога нет. Хвост пути (`<project>`) не трогаем."""
    p = Path(key)
    return p.is_absolute() and not p.exists()


def check_stale_registry(rep: Report, harness: Path, args):
    pb = harness / "config" / "protected-branches.local.json"
    data = load_json(pb)
    stale = [k for k in data.get("repos", {}) if is_abs_missing(k)]
    if stale:
        c = rep.add("harness", "stale-protected-branches", "warn",
                    "в реестре веток пути, которых нет на диске: " + ", ".join(stale),
                    {"kind": "auto", "how": f"убрать записи из {pb.name} (действуют defaults)"})
        if args.fix:
            for k in stale:
                del data["repos"][k]
            write_registry(pb, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            c["status"], c["fixed"] = "ok", True
    pc = harness / "config" / "project-credentials.local.md"
    if pc.exists():
        text = pc.read_text(encoding="utf-8")
        stale_rows = [r[0] for r in credentials_rows(text) if is_abs_missing(r[0])]
        if stale_rows:
            c = rep.add("harness", "stale-project-credentials", "warn",
                        "в реестре кредов пути, которых нет на диске: " + ", ".join(stale_rows),
                        {"kind": "auto", "how": f"убрать строки из {pc.name}"})
            if args.fix:
                keep = [l for l in text.splitlines()
                        if not (l.startswith("|") and l.strip().strip("|").split("|")[0].strip() in stale_rows)]
                write_registry(pc, "\n".join(keep) + "\n")
                c["status"], c["fixed"] = "ok", True


def example_to_local(name: str) -> str:
    """`x.example.md` → `x.local.md`; `x.local.example.md` → `x.local.md`."""
    return name.replace(".local.example.", ".local.").replace(".example.", ".local.")


def check_harness(rep: Report, harness: Path, args):
    st = harness / "settings.json"
    try:
        settings = json.loads(st.read_text(encoding="utf-8"))
        rep.add("harness", "settings", "ok", "settings.json читается")
    except (OSError, ValueError) as e:
        rep.add("harness", "settings", "fail", f"settings.json не читается: {e}",
                {"kind": "manual", "how": "почини JSON; копия — settings.json.bak-*"})
        return
    cmds = [h.get("command", "") for arr in settings.get("hooks", {}).values() for m in arr for h in m.get("hooks", [])]
    cmds.append((settings.get("statusLine") or {}).get("command", ""))
    missing = set()
    for cmd in cmds:
        for tok in re.findall(r'"([^"]+\.(?:js|py|ps1|sh))"|(\S+\.(?:js|py|ps1|sh))\b', cmd):
            p = Path(os.path.expandvars(os.path.expanduser(tok[0] or tok[1])))
            if not p.exists():
                missing.add(str(p))
    if missing:
        rep.add("harness", "hook-paths", "fail", "хук ссылается на несуществующий файл: " + ", ".join(sorted(missing)),
                {"kind": "manual", "how": "поправь путь в settings.json или верни файл"})
    else:
        rep.add("harness", "hook-paths", "ok", f"все {len(cmds)} команд хуков и statusLine указывают на существующие файлы")
    cache = harness / "plugins" / "cache"
    for pid, on in settings.get("enabledPlugins", {}).items():
        if not on or "@" not in pid:
            continue
        plugin, market = pid.split("@", 1)
        if not (cache / market / plugin).exists():
            rep.add("harness", f"plugin-{plugin}", "fail", f"плагин {pid} включён, но не установлен",
                    {"kind": "manual", "how": f"claude plugin install {pid}"})
    broken = [p.name for d in ("skills", "agents") if (harness / d).exists()
              for p in (harness / d).iterdir() if p.is_symlink() and not p.exists()]
    rep.add("harness", "symlinks", "fail" if broken else "ok",
            ("битые ссылки: " + ", ".join(broken)) if broken else "ссылки в skills/ и agents/ целы",
            {"kind": "manual", "how": "переустанови скилл или удали ссылку"} if broken else None)
    for example in sorted((harness / "config").glob("*.example.*")):
        local = example.with_name(example_to_local(example.name))
        if not local.exists():
            rep.add("harness", f"config-{local.name}", "warn", f"нет {local.name} — заведи из {example.name}",
                    {"kind": "manual", "how": f"скопируй {example.name} в {local.name} и заполни"})
    hooks_dir = harness / ".git" / "hooks"
    if hooks_dir.exists():
        for h in ("pre-commit", "commit-msg"):
            if (hooks_dir / h).exists():
                rep.add("harness", f"git-{h}", "ok", f"git-хук {h} стоит")
                continue
            c = rep.add("harness", f"git-{h}", "fail", f"git-хук {h} не стоит — анти-утечка не работает",
                        {"kind": "auto", "how": f"копия hooks/{h} в .git/hooks/{h}, затем впиши свой denylist"})
            if args.fix and (harness / "hooks" / h).exists():
                shutil.copy2(harness / "hooks" / h, hooks_dir / h)
                c["status"], c["fixed"] = "warn", True
                c["message"] = f"git-хук {h} поставлен копией — впиши свой denylist в .git/hooks/{h}"
    check_stale_registry(rep, harness, args)
    g = harness / "CLAUDE.md"
    if g.exists():
        t = g.read_text(encoding="utf-8")
        n = t.count("\n") + 1
        if n > CLAUDE_MD_LINES or len(t) > CLAUDE_MD_CHARS:
            rep.add("harness", "claude-md-size", "warn", f"глобальный CLAUDE.md {n} строк / {len(t)} символов — выше порога")


# ---------------------------------------------------------------- вывод
ICON = {"ok": "✅", "warn": "⚠️", "fail": "❌", "info": "ℹ️"}


def render_text(result):
    out = []
    for area, title in (("machine", "Машина"), ("harness", "Харнесс ~/.claude"),
                        ("project", "Проект"), ("instructions", "Инструкции")):
        items = [c for c in result["checks"] if c["area"] == area]
        if not items:
            continue
        out.append(f"\n## {title}")
        for c in items:
            line = f"{ICON[c['status']]} {c['id']}: {c['message']}"
            if c.get("fixed"):
                line += "  [починено]"
            elif c.get("fix") and c["status"] != "ok":
                line += f"\n    → {c['fix']['kind']}: {c['fix'].get('how') or c['fix'].get('append')}"
            out.append(line)
    src = result.get("instructions", [])
    if src:
        out.append(f"\nИсточники инструкций для разбора конфликтов ({sum(s['chars'] for s in src)} символов):")
        out += [f"  [{s['scope']}] {s['path']} ({s['lines']} строк)" for s in src]
    s = result["summary"]
    out.append(f"\nИтог: ✅ {s['ok']} · ⚠️ {s['warn']} · ❌ {s['fail']} · ℹ️ {s['info']} · починено {s['fixed']}")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--project", default=os.getcwd())
    ap.add_argument("--harness", default=os.environ.get("CLAUDE_HARNESS_DIR", str(Path.home() / ".claude")))
    ap.add_argument("--fix", action="store_true")
    ap.add_argument("--account")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-install", action="store_true", help="не ставить CLI даже с --fix")
    ap.add_argument("--skip-index", action="store_true", help="не трогать ast-index")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    rep = Report()
    harness, project = Path(args.harness), Path(args.project).resolve()
    if not project.is_dir():
        print(f"harness-doctor: каталог проекта не найден: {project}", file=sys.stderr)
        return 2
    proj_info, stacks, root = check_project(rep, project, harness, args)
    check_tools(rep, stacks, args)
    check_harness(rep, harness, args)
    sources = collect_instructions(rep, root, harness, proj_info.get("git", False))
    check_mechanical_conflicts(rep, root, harness)

    summary = {k: sum(1 for c in rep.checks if c["status"] == k) for k in ICON}
    summary["fixed"] = sum(1 for c in rep.checks if c.get("fixed"))
    result = {"project": proj_info, "checks": rep.checks, "instructions": sources, "summary": summary}
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else render_text(result))
    return 1 if summary["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
