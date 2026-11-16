"""Tests for skills/task-gate/scripts/gate-log.py.
Run: python skills/task-gate/scripts/gate-log.tests.py
Schema validation plus the 5.2 state update on a throwaway git repository.
"""
import importlib.util, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # keep __pycache__ out of the whitelisted skill dir
spec =importlib.util.spec_from_file_location("gate_log", HERE / "gate-log.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
prep = mod.prep

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


# ---------------------------------------------------------------- verdict normalization
VERDICTS = [
    ("READY", "READY"),
    ("ready with warnings", "READY WITH WARNINGS"),
    ("READY_WITH_WARNINGS", "READY WITH WARNINGS"),
    ("  NOT  READY ", "NOT READY"),
    ("NOT_READY", "NOT READY"),
    ("OK", None),
    ("", None),
    (None, None),
]
for raw, want in VERDICTS:
    check(f"normalize_verdict({raw!r})", mod.normalize_verdict(raw), want)

# ---------------------------------------------------------------- row validation
GOOD = {"ts": "2026-11-16T07:45:00Z", "repo": ".claude", "branch": "feat/x", "mode": "lite",
        "gate_sec": 288, "review_sec": None, "l1_sec": 3, "agents": 1, "files": 12,
        "verdict": "READY", "artifact": "other"}
check("good row", mod.validate_row(dict(GOOD)), [])


def bad(**changes):
    row = dict(GOOD)
    row.update(changes)
    return mod.validate_row(row)


ROW_CASES = [
    ("mode medium", bad(mode="medium")),
    ("verdict with underscores", bad(verdict="READY_WITH_WARNINGS")),
    ("artifact null", bad(artifact=None)),
    ("artifact unknown", bad(artifact="screenshot")),
    ("gate_sec empty string", bad(gate_sec="")),
    ("gate_sec negative", bad(gate_sec=-1)),
    ("agents bool", bad(agents=True)),
    ("files missing", bad(files=None)),
    ("ts without Z", bad(ts="2026-11-16 07:45:00")),
    ("empty branch", bad(branch="")),
]
for name, errors in ROW_CASES:
    check(f"rejects {name}", len(errors) >= 1, True)
row = dict(GOOD)
row["extra"] = 1
check("rejects extra key", len(mod.validate_row(row)), 1)
check("artifact none accepted", bad(artifact="none"), [])
check("fmt_sec", (mod.fmt_sec(None), mod.fmt_sec(3), mod.fmt_sec(372)), ("—", "3с", "6м12с"))


# ---------------------------------------------------------------- end-to-end on a temp repo
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


def run_prep(repo, scratch):
    args = prep.build_parser().parse_args(
        ["--scratchpad", str(scratch), "--no-l1", "--no-remote",
         "--registry", str(scratch / "none.json"), "--stats-dir", str(scratch / "stats")])
    return prep.prepare(args, str(repo))


def run_log(repo, scratch, *argv):
    args = mod.build_parser().parse_args(["--scratchpad", str(scratch), "--stats-dir",
                                          str(scratch / "stats"), *argv])
    return mod.run(args, str(repo))


def state_of(scratch):
    return json.loads((scratch / "task-gate-state.json").read_text(encoding="utf-8"))


def log_lines(scratch):
    p = scratch / "stats" / "task-gate-timings.jsonl"
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()] if p.exists() else []


root = Path(tempfile.mkdtemp(prefix="gate-log-tests-"))
try:
    repo, scratch = root / "repo", root / "scratch"
    repo.mkdir()
    g(repo, "init", "-q", "-b", "main")
    write(repo, ".gitignore", ".nohooks/\n")
    write(repo, "a.kt", "fun a() = 1\n")
    g(repo, "add", "-A")
    g(repo, "commit", "-q", "-m", "init")
    g(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    g(repo, "checkout", "-q", "-b", "feat/x")

    # run 1: reviewed, committed without further edits -> lastGateSha and reviewedSha advance
    write(repo, "b.kt", "fun b() = 2\n")
    run_prep(repo, scratch)
    g(repo, "add", "-A")
    g(repo, "commit", "-q", "-m", "b")
    head1 = g(repo, "rev-parse", "HEAD")
    code, out = run_log(repo, scratch, "--verdict", "ready_with_warnings", "--artifact", "OTHER",
                        "--agents", "1", "--review-clean", "--once", "hookSetup,rollup")
    check("run1 exit", code, 0)
    lines = log_lines(scratch)
    check("run1 one line", len(lines), 1)
    check("run1 schema order", tuple(lines[0]), mod.SCHEMA)
    check("run1 normalized", (lines[0]["verdict"], lines[0]["artifact"], lines[0]["mode"]),
          ("READY WITH WARNINGS", "other", "lite"))
    check("run1 repo/branch from git", (lines[0]["repo"], lines[0]["branch"]), ("repo", "feat/x"))
    check("run1 gate_sec measured", isinstance(lines[0]["gate_sec"], int), True)
    check("run1 l1_sec null without L1", lines[0]["l1_sec"], None)
    st = state_of(scratch)
    check("run1 lastGateSha", st["lastGateSha"], head1)
    check("run1 reviewedSha advanced", (out["reviewed_advanced"], st.get("reviewedSha")), (True, head1))
    check("run1 once flags", st["onceChecks"], {"hookSetup": True, "rollup": True})
    check("run1 gateRuns", st["gateRuns"], 1)

    # duplicate log for the same prep is refused, nothing written
    code, out = run_log(repo, scratch, "--verdict", "READY", "--artifact", "other", "--agents", "1")
    check("duplicate refused", (code, len(log_lines(scratch))), (2, 1))

    # run 2: an edit after the review -> reviewedSha must NOT advance
    write(repo, "c.kt", "fun c() = 3\n")
    run_prep(repo, scratch)
    write(repo, "c.kt", "fun c() = 33 // edited after review\n")
    g(repo, "add", "-A")
    g(repo, "commit", "-q", "-m", "c")
    head2 = g(repo, "rev-parse", "HEAD")
    code, out = run_log(repo, scratch, "--verdict", "READY", "--artifact", "other", "--agents", "1",
                        "--review-clean", "--artifact-task", "b12", "--artifact-url", "http://localhost:3000/x")
    st = state_of(scratch)
    check("run2 exit", code, 0)
    check("run2 reviewedSha kept", (out["reviewed_advanced"], out["reason"], st["reviewedSha"]),
          (False, "diff changed after review", head1))
    check("run2 lastGateSha moves", st["lastGateSha"], head2)
    check("run2 artifact server", st["artifactServer"], {"taskId": "b12", "url": "http://localhost:3000/x"})

    # run 3: NOT READY -> line written, lastGateSha stays
    write(repo, "d.kt", "fun d() = 4\n")
    run_prep(repo, scratch)
    code, out = run_log(repo, scratch, "--verdict", "NOT READY", "--artifact", "none", "--agents", "2",
                        "--review-clean")
    st = state_of(scratch)
    check("run3 exit", code, 0)
    check("run3 line written", log_lines(scratch)[-1]["verdict"], "NOT READY")
    check("run3 lastGateSha unchanged", st["lastGateSha"], head2)
    check("run3 reviewed not advanced", out["reviewed_advanced"], False)

    # invalid artifact -> exit 2, no line, state untouched
    run_prep(repo, scratch)
    before = len(log_lines(scratch))
    code, out = run_log(repo, scratch, "--verdict", "READY", "--artifact", "screenshot", "--agents", "1")
    check("invalid artifact refused", (code, len(log_lines(scratch))), (2, before))
    check("state not marked logged", state_of(scratch)["prep"]["logged"], False)
    code, out = run_log(repo, scratch, "--verdict", "MAYBE", "--artifact", "other", "--agents", "1")
    check("invalid verdict refused", code, 2)
    code, out = run_log(repo, scratch, "--verdict", "READY", "--artifact", "other", "--agents", "1",
                        "--once", "bogus")
    check("invalid once key refused", code, 2)

    # no prep at all: mode/files must be passed explicitly
    scratch2 = root / "scratch2"
    scratch2.mkdir()
    code, out = run_log(repo, scratch2, "--verdict", "READY", "--artifact", "other", "--agents", "0")
    check("no prep, no mode -> refused", code, 2)
    code, out = run_log(repo, scratch2, "--verdict", "READY", "--artifact", "other", "--agents", "0",
                        "--mode", "full", "--files", "3", "--review-sec", "65")
    check("no prep with overrides", (code, out["row"]["mode"], out["row"]["gate_sec"], out["timings"]),
          (0, "full", None, "⏱ Timings: gate — · review 1м05с · L1 —"))

    # mode raised after gate-prep: --mode full in gate-log, prep.ts (gate start) untouched
    write(repo, "e.kt", "fun e() = 5\n")
    run_prep(repo, scratch)
    ts_before = state_of(scratch)["prep"]["ts"]
    mode_before = state_of(scratch)["prep"]["mode"]
    code, out = run_log(repo, scratch, "--verdict", "READY", "--artifact", "other", "--agents", "1",
                        "--mode", "full")
    st = state_of(scratch)
    check("mode raised via gate-log", (code, mode_before, out["row"]["mode"]), (0, "lite", "full"))
    check("prep.ts kept, gate_sec from it", (st["prep"]["ts"] == ts_before, isinstance(out["row"]["gate_sec"], int)),
          (True, True))
finally:
    shutil.rmtree(root, ignore_errors=True)

print(f"{passed} passed, {fails} failed")
sys.exit(1 if fails else 0)
