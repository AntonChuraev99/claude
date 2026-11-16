"""Tests for skills/task-gate/scripts/gate-prep.py.
Run: python skills/task-gate/scripts/gate-prep.tests.py
Unit cases plus scenarios on throwaway git repositories (no network, no L1, no real stats).
"""
import importlib.util, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # keep __pycache__ out of the whitelisted skill dir
spec =importlib.util.spec_from_file_location("gate_prep", HERE / "gate-prep.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
    os.environ.pop(var, None)

fails = 0
passed = 0


def check(name, got, want):
    global fails, passed
    if got == want:
        passed += 1
    else:
        fails += 1
        print(f"FAIL: {name}: got {got!r}, want {want!r}")


# ---------------------------------------------------------------- unit: test files
TEST_PATHS = [
    ("app/src/test/kotlin/FooTest.kt", True),
    ("feature/src/commonTest/kotlin/Bar.kt", True),
    ("feature/src/androidHostTest/roborazzi/x.png", True),
    ("web/src/Button.test.tsx", True),
    ("web/src/__tests__/a.js", True),
    ("scripts/session-stages.tests.py", True),
    ("tools/test_parse.py", True),
    ("pkg/server_test.go", True),
    ("app/src/main/kotlin/Latest.kt", False),
    ("app/src/main/kotlin/Contest.kt", False),
    ("web/src/testing-utils.ts", False),
    ("hooks/foo.js", False),
]
for path, want in TEST_PATHS:
    check(f"is_test_path({path})", mod.is_test_path(path), want)

# ---------------------------------------------------------------- unit: mode (contract 4)
MODE_CASES = [
    # (files, harness, extra, want_mode, want_code_count)
    (["a.kt", "b.kt", "c.kt", "d.kt", "README.md", "docs/x.md", "docs/y.png"], False, [], "lite", 4),
    (["a.kt", "b.kt", "c.kt", "d.kt", "e.kts"], False, [], "full", 5),
    (["a.kt", "b.kt", "src/test/A.kt", "src/test/B.kt", "src/test/C.kt"], False, [], "lite", 2),
    (["improvements/2026-11-16-x.md", "docs/a.md", "docs/active/b.md"], True, [], "lite", 0),
    (["skills/task-gate/SKILL.md"], True, [], "full", 0),
    (["skills/task-gate/SKILL.md"], False, [], "lite", 0),
    (["settings.example.json"], True, [], "full", 1),
    ([".github/workflows/ci.yml"], False, [], "full", 1),
    (["functions/firestore.rules"], False, [], "full", 1),
    (["a.kt"], False, ["новый публичный контракт"], "full", 1),
    (["a.kt"], False, ["  "], "lite", 1),
]
for files, harness, extra, want_mode, want_code in MODE_CASES:
    mode, reasons, code = mod.choose_mode(files, harness, extra)
    check(f"choose_mode({files}, harness={harness}, extra={extra})", (mode, code), (want_mode, want_code))
    check(f"reasons present iff full for {files}", bool(reasons), want_mode == "full")

# ---------------------------------------------------------------- unit: docs-only class (Step 6)
DOCS_CLASS = [
    ("docs/solutions/a.md", False, True),
    ("README.md", False, True),
    ("CLAUDE.md", False, False),
    ("sub/AGENTS.md", False, False),
    (".claude/agents/x.md", False, False),
    ("src/content/post.md", False, False),
    ("improvements/2026-11-16-x.md", True, True),
    ("improvements/2026-11-16-x.md", False, False),
    ("skills/task-gate/SKILL.md", True, False),
    ("references/claude-md-precedents.md", True, False),
    ("settings.example.json", True, False),
]
for path, harness, want in DOCS_CLASS:
    check(f"is_docs_class({path}, harness={harness})", mod.is_docs_class(path, harness), want)

# ---------------------------------------------------------------- unit: branch policy
registry = {
    "defaults": {"protected": ["main", "master", "develop", "release/*"], "mrTarget": "main"},
    "repos": {"C:\\Work\\Proj": {"trunk": "develop", "protected": ["develop", "release/*"]}},
}
prot, trunk, default = mod.branch_policy(registry, "C:/Work/Proj")
check("branch_policy repo entry by backslash key", (trunk, prot), ("develop", ["develop", "release/*"]))
prot, trunk, default = mod.branch_policy(registry, "C:/Other")
check("branch_policy falls back to defaults", (trunk, default, "main" in prot), (None, "main", True))
check("release/* protected", mod.is_protected("release/1.2", prot), True)
check("feature not protected", mod.is_protected("feat/x", prot), False)
check("detached HEAD not protected", mod.is_protected("HEAD", prot), False)

# ---------------------------------------------------------------- unit: TODO parsing
DIFF = """diff --git a/app/Main.kt b/app/Main.kt
index 1111111..2222222 100644
--- a/app/Main.kt
+++ b/app/Main.kt
@@ -10,0 +11,2 @@ fun a() {
+    val x = 1
+    // TODO: wire the timer
@@ -20 +22 @@ fun b() {
--- old removed line that looks like a header
+    // FIXME: crash on null
diff --git a/app/src/test/MainTest.kt b/app/src/test/MainTest.kt
--- a/app/src/test/MainTest.kt
+++ b/app/src/test/MainTest.kt
@@ -1,0 +2 @@
+// TODO: more cases
diff --git a/web/a.ts b/web/a.ts
new file mode 100644
--- /dev/null
+++ b/web/a.ts
@@ -0,0 +1,2 @@
+const todo = 1 // TODO without colon is fine? no: TODO: yes
+// NOTE: not a marker
"""
got = [(i["file"], i["line"]) for i in mod.parse_added_todos(DIFF)]
check("parse_added_todos file:line", got, [("app/Main.kt", 12), ("app/Main.kt", 22), ("web/a.ts", 1)])
check("todo_status empty", mod.todo_status([]), "clean")
check("todo_status mixed", mod.todo_status([{"state": "anchored"}, {"state": "broken_anchor"}]), "broken_anchor")
check("todo_status unbacked wins", mod.todo_status([{"state": "broken_anchor"}, {"state": "unbacked"}]), "unbacked")


# ---------------------------------------------------------------- scenarios on a temp repo
def g(repo, *args):
    hooks = Path(repo) / ".nohooks"
    hooks.mkdir(exist_ok=True)
    p = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com",
                        "-c", f"core.hooksPath={hooks}", "-c", "commit.gpgsign=false",
                        "-c", "core.autocrlf=false", *args],
                       cwd=repo, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"git {args}: {p.stderr}")
    return p.stdout.strip()


def write(repo, rel, text):
    p = Path(repo) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")


def args_for(scratch, *extra):
    return mod.build_parser().parse_args(
        ["--scratchpad", str(scratch), "--no-l1", "--no-remote",
         "--registry", str(Path(scratch) / "no-registry.json"),
         "--stats-dir", str(Path(scratch) / "stats"), *extra])


root = Path(tempfile.mkdtemp(prefix="gate-prep-tests-"))
try:
    repo = root / "repo"
    scratch = root / "scratch"
    repo.mkdir()
    g(repo, "init", "-q", "-b", "main")
    write(repo, ".gitignore", ".nohooks/\n")
    write(repo, "README.md", "# r\n")
    write(repo, "app/Old.kt", "fun old() = 1\n")
    g(repo, "add", "-A")
    g(repo, "commit", "-q", "-m", "init")
    g(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    g(repo, "checkout", "-q", "-b", "feat/x")

    # task: 2 code files (one new, untracked), a doc, an unbacked TODO and an anchored one
    write(repo, "app/Old.kt", "fun old() = 1\n// TODO: handle offline\n")
    write(repo, "app/New.kt", "fun new() = 2\n// TODO: later\n// Pending: docs/todos/2026-11-16-later.md\n")
    write(repo, "docs/todos/2026-11-16-later.md", "x\n")
    write(repo, "docs/active/task.md", "doc\n")
    write(repo, ".env.local", "KEY=1\n")

    r = mod.prepare(args_for(scratch), str(repo))
    check("git repo detected", r["git"], True)
    check("base source without state", r["base"]["source"].startswith("none"), True)
    check("mode full: .env.local is environment config",
          (r["mode"]["value"], r["task"]["code_files"]), ("full", 3))
    check("mode reason names the env file", any(".env.local" in x for x in r["mode"]["reasons"]), True)
    check("review base origin/main", r["review"]["base_source"], "origin/main")
    pkg = Path(r["review"]["package"])
    text = pkg.read_text(encoding="utf-8")
    check("package contains untracked new file", "fun new() = 2" in text, True)
    check("package header names base", "БАЗА:" in text, True)
    check("package has_code", r["review"]["has_code"], True)
    check("review not repeat", r["review"]["repeat"], False)
    check("todo status unbacked", r["todo"]["status"], "unbacked")
    states = sorted((i["file"], i["line"], i["state"]) for i in r["todo"]["items"])
    check("todo items", states, [("app/New.kt", 2, "anchored"), ("app/Old.kt", 2, "unbacked")])
    check("suspicious .env.local", [s["path"] for s in r["commit"]["suspicious"]], [".env.local"])
    check("merge trunk/protected", (r["merge"]["trunk"], r["merge"]["protected"]), ("main", False))
    check("merge upstream none", r["merge"]["upstream"], None)
    check("not docs-only", r["merge"]["docs_only_files"], False)
    check("docs not ignored", r["docs"]["gitignored"], False)
    st = json.loads((scratch / "task-gate-state.json").read_text(encoding="utf-8"))
    check("state prep written", (st["prep"]["mode"], st["prep"]["logged"]), ("full", False))
    fp_before = st["prep"]["review"]["fingerprint"]
    mb = st["prep"]["review"]["mergeBase"]

    # fingerprint survives the commit (5.2 compares after /commit)
    Path(repo / ".env.local").unlink()
    g(repo, "reset", "-q", "--", ".env.local")
    fp_no_env = mod.diff_fingerprint(str(repo), mb)
    g(repo, "add", "-A")
    g(repo, "commit", "-q", "-m", "task")
    check("fingerprint stable across commit", mod.diff_fingerprint(str(repo), mb), fp_no_env)
    check("fingerprint differs when diff changed", fp_no_env != fp_before, True)

    # --full reason forces full
    r2 = mod.prepare(args_for(scratch, "--full", "новый модуль"), str(repo))
    check("--full forces full", (r2["mode"]["value"], r2["mode"]["reasons"][-1]), ("full", "главный: новый модуль"))

    # second gate run: lastGateSha = HEAD -> scope is only new work; reviewedSha -> repeat review
    head = g(repo, "rev-parse", "HEAD")
    st = json.loads((scratch / "task-gate-state.json").read_text(encoding="utf-8"))
    st.update({"lastGateSha": head, "reviewedSha": head})
    (scratch / "task-gate-state.json").write_text(json.dumps(st), encoding="utf-8")
    write(repo, "app/Third.kt", "fun third() = 3\n")
    r3 = mod.prepare(args_for(scratch), str(repo))
    check("base from lastGateSha", r3["base"]["source"], "lastGateSha")
    check("task scope = increment", r3["task"]["files"], ["app/Third.kt"])
    check("review base reviewedSha + repeat", (r3["review"]["base_source"], r3["review"]["repeat"]), ("reviewedSha", True))
    check("todo clean on increment", r3["todo"]["status"], "clean")
    check("gate_run counts from state", r3["state"]["gate_run"], 1)

    # empty diff -> review skipped, not crashed
    Path(repo / "app/Third.kt").unlink()
    g(repo, "reset", "-q")
    r4 = mod.prepare(args_for(scratch), str(repo))
    check("empty diff skips review", r4["review"]["skip"], "пустой дифф")

    # unresolvable origin/<trunk> on a merge-bound branch -> fail fast with a reason
    g(repo, "update-ref", "-d", "refs/remotes/origin/main")
    write(repo, "app/Fourth.kt", "fun f() = 4\n")
    (scratch / "task-gate-state.json").write_text("{}", encoding="utf-8")
    reg = scratch / "registry.json"
    reg.write_text(json.dumps({"defaults": {"mrTarget": "main"}}), encoding="utf-8")
    r5 = mod.prepare(args_for(scratch, "--registry", str(reg)), str(repo))
    check("missing origin trunk -> skip with reason", "не резолвится" in (r5["review"]["skip"] or ""), True)
    g(repo, "update-ref", "refs/remotes/origin/main", "HEAD~1")

    # --todo-only --staged (used by /commit after staging)
    write(repo, "app/Staged.kt", "// FIXME: staged marker\n")
    g(repo, "add", "app/Staged.kt")
    r6 = mod.prepare(mod.build_parser().parse_args(["--todo-only", "--staged"]), str(repo))
    check("todo-only staged", [(i["file"], i["state"]) for i in r6["todo"]["items"]], [("app/Staged.kt", "unbacked")])
    r7 = mod.prepare(mod.build_parser().parse_args(["--todo-only"]), str(repo))
    check("todo-only default sees staged + untracked", r7["todo"]["count"], 1)

    # broken Pending anchor
    write(repo, "app/Broken.kt", "// TODO: x\n// Pending: docs/todos/missing.md\n")
    r8 = mod.prepare(mod.build_parser().parse_args(["--todo-only"]), str(repo))
    broken = [i for i in r8["todo"]["items"] if i["file"] == "app/Broken.kt"]
    check("broken anchor detected", broken[0]["state"], "broken_anchor")

    # 2.7b docs-only check
    write(repo, "docs/solutions/new.md", "x\n")
    r9 = mod.prepare(mod.build_parser().parse_args(
        ["--docs-only", "docs/solutions/new.md", "docs/active/task.md", "docs/archive/ghost.md"]), str(repo))
    check("docs states", [p["state"] for p in r9["docs"]["paths"]], ["uncommitted", "committed", "missing"])

    # docs-only diff against the trunk (Step 6 exception input)
    repo2 = root / "repo2"
    repo2.mkdir()
    g(repo2, "init", "-q", "-b", "main")
    write(repo2, ".gitignore", ".nohooks/\n")
    write(repo2, "README.md", "# r\n")
    g(repo2, "add", "-A")
    g(repo2, "commit", "-q", "-m", "init")
    g(repo2, "update-ref", "refs/remotes/origin/main", "HEAD")
    g(repo2, "checkout", "-q", "-b", "docs/x")
    write(repo2, "docs/guide.md", "g\n")
    write(repo2, "README.md", "# r2\n")
    r10 = mod.prepare(args_for(root / "scratch2"), str(repo2))
    check("docs-only diff", (r10["merge"]["docs_only_files"], r10["mode"]["value"]), (True, "lite"))
    check("docs-only review has no code", r10["review"]["has_code"], False)

    # not a git repo
    plain = root / "plain"
    plain.mkdir()
    check("no git", mod.prepare(args_for(root / "scratch3"), str(plain))["git"], False)

    # judgement hint: raise the mode via gate-log, never a second gate-prep (second L1 run)
    check("judgement points to gate-log --mode full", "--mode full" in r10["mode"]["judgement"], True)

    # commit.dirty_files is capped -> total and truncation flag are reported (guard 4)
    repo3 = root / "repo3"
    repo3.mkdir()
    g(repo3, "init", "-q", "-b", "main")
    write(repo3, ".gitignore", ".nohooks/\n")
    for i in range(22):
        write(repo3, f"f{i:02d}.txt", "x\n")
    cf = mod.commit_facts(str(repo3))
    check("dirty total/truncated/cap", (cf["dirty_total"], cf["dirty_truncated"], len(cf["dirty_files"])),
          (23, True, 20))
    check("dirty not truncated under cap", mod.commit_facts(str(repo2))["dirty_truncated"], False)

    # L1 tool failure must never read as "static clean"
    fakes = root / "fake-l1"
    fakes.mkdir()
    l1_scratch = root / "scratch-l1"
    l1_scratch.mkdir()
    FAKES = {
        "crash.py": "import sys\nsys.stderr.write('review-rules: internal error: boom\\n')\nsys.exit(3)\n",
        "empty.py": "import sys\nsys.exit(0)\n",
        "notlist.py": "print('{\"x\": 1}')\n",
        "high.py": "import json, sys\nprint(json.dumps([{'mode': 'static', 'severity': 'high'},"
                   " {'mode': 'runtime', 'severity': 'medium'}]))\nsys.exit(1)\n",
        "clean.py": "print('[]')\n",
    }
    for name, body in FAKES.items():
        (fakes / name).write_text(body, encoding="utf-8")
    l1 = {name: mod.run_l1(str(repo3), None, l1_scratch, name, l1_scratch / "stats", runner=fakes / name)
          for name in FAKES}
    check("L1 exit 3 -> error with stderr tail", (l1["crash.py"]["exit"], "boom" in (l1["crash.py"]["error"] or "")),
          (3, True))
    check("L1 exit 0 + empty stdout -> error", bool(l1["empty.py"]["error"]), True)
    check("L1 non-list JSON -> error", bool(l1["notlist.py"]["error"]), True)
    check("L1 exit 1 with findings counted", (l1["high.py"]["error"], l1["high.py"]["static_high"],
                                              l1["high.py"]["static"], l1["high.py"]["runtime"]), (None, 1, 1, 1))
    check("L1 clean", (l1["clean.py"]["error"], l1["clean.py"]["static"]), (None, 0))
finally:
    shutil.rmtree(root, ignore_errors=True)

print(f"{passed} passed, {fails} failed")
sys.exit(1 if fails else 0)
