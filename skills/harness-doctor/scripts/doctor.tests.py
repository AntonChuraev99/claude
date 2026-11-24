"""Тесты doctor.py: python doctor.tests.py"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("doctor", HERE / "doctor.py")
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)


def args(**kw):
    base = dict(fix=False, account=None, no_install=True, skip_index=True)
    base.update(kw)
    return types.SimpleNamespace(**base)


def git(cwd, *a):
    subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)


class GlobTests(unittest.TestCase):
    def test_double_star_matches_any_depth(self):
        r = doctor.glob_re("**/*.kt")
        self.assertTrue(r.match("A.kt"))
        self.assertTrue(r.match("app/src/main/A.kt"))
        self.assertFalse(r.match("app/A.kts"))

    def test_single_star_stops_at_slash(self):
        self.assertFalse(doctor.glob_re("docs/*").match("docs/a/b.md"))
        self.assertTrue(doctor.glob_re("docs/**").match("docs/a/b.md"))


class WorktreeIncludeTests(unittest.TestCase):
    def test_basename_pattern_matches_nested(self):
        self.assertTrue(doctor.worktreeinclude_covers(["google-services.json"], "app/google-services.json"))

    def test_anchored_pattern_only_at_root(self):
        self.assertTrue(doctor.worktreeinclude_covers(["/local.properties"], "local.properties"))
        self.assertFalse(doctor.worktreeinclude_covers(["/local.properties"], "sub/local.properties"))

    def test_comments_and_negation_ignored(self):
        self.assertFalse(doctor.worktreeinclude_covers(["# .env", "!.env"], ".env"))

    def test_directory_pattern_covers_children(self):
        self.assertTrue(doctor.worktreeinclude_covers(["config/"], "config/.env"))


class RegistryMatchTests(unittest.TestCase):
    def test_protected_matches_like_hook(self):
        # первый совпавший по порядку, регистр не важен — как repoKeyMatch в protected-branch-guard.js
        data = {"repos": {"C:\\Users\\X\\Projects\\App": {"n": 1}, "App": {"n": 2}}}
        self.assertEqual(doctor.registry_match_protected(data, Path("c:/users/x/projects/app")),
                         "C:\\Users\\X\\Projects\\App")

    def test_protected_tail_key_needs_segment_boundary(self):
        data = {"repos": {"app": {}}}
        self.assertIsNone(doctor.registry_match_protected(data, Path("C:/dev/webapp")))
        self.assertEqual(doctor.registry_match_protected(data, Path("C:/dev/app")), "app")

    def test_credentials_row_goes_into_repo_path_table(self):
        text = ("# R\n\n| repo_path | account |\n|---|---|\n| /a | x@x |\n\n"
                "## Другое\n\n| play_package | sa |\n|---|---|\n| com.x | y |\n")
        out = doctor.insert_credentials_row(text, "| /b | z@z |").splitlines()
        self.assertEqual(out.index("| /b | z@z |"), out.index("| /a | x@x |") + 1)

    def test_credentials_row_creates_table_when_absent(self):
        out = doctor.insert_credentials_row("", "| /b | z@z |")
        self.assertTrue(out.startswith("| repo_path |"))
        self.assertIn("| /b | z@z |", out)

    def test_merge_settings_keeps_lists_from_both(self):
        m = doctor.merge_settings({"permissions": {"allow": ["A"]}, "hooks": {"Stop": [1]}},
                                  {"permissions": {"allow": ["B"]}, "hooks": {"Stop": [2]}})
        self.assertEqual(m["permissions"]["allow"], ["A", "B"])
        self.assertEqual(m["hooks"]["Stop"], [1, 2])

    def test_credentials_row_needs_segment_boundary(self):
        text = "| repo_path | account |\n|---|---|\n| myapp | a@x |\n"
        rows = doctor.credentials_rows(text)
        self.assertEqual(rows, [["myapp", "a@x"]])
        self.assertIsNotNone(doctor.credentials_match(rows, Path("/home/u/myapp")))
        self.assertIsNone(doctor.credentials_match(rows, Path("/home/u/myapp-staging")))


class SmallHelpersTests(unittest.TestCase):
    def test_example_to_local(self):
        self.assertEqual(doctor.example_to_local("jira.example.md"), "jira.local.md")
        self.assertEqual(doctor.example_to_local("ab.local.example.md"), "ab.local.md")

    def test_frontmatter_paths(self):
        t = '---\npaths:\n  - "**/*.kt"\n  - docs/**\n---\n# x'
        self.assertEqual(doctor.frontmatter_paths(t), ["**/*.kt", "docs/**"])
        self.assertIsNone(doctor.frontmatter_paths("# no frontmatter"))

    def test_version_compare(self):
        self.assertLess(doctor.version_tuple("1.0.99"), doctor.version_tuple(doctor.ANDROID_CLI_MIN))
        self.assertGreaterEqual(doctor.version_tuple("android 1.1.16919734"),
                                doctor.version_tuple(doctor.ANDROID_CLI_MIN))

    def test_tail_key_is_not_stale(self):
        self.assertFalse(doctor.is_abs_missing("<your-project>"))
        self.assertTrue(doctor.is_abs_missing(str(Path(tempfile.gettempdir()) / "no-such-dir-doctor")))


class FixTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.harness = base / "harness"
        (self.harness / "config").mkdir(parents=True)
        (self.harness / "agents").mkdir()
        (self.harness / "agents" / "feature-expert.md").write_text("x", encoding="utf-8")
        self.repo = base / "app"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i")

    def tearDown(self):
        self.tmp.cleanup()

    def test_fix_adds_protected_branch_entry_with_backup(self):
        pb = self.harness / "config" / "protected-branches.local.json"
        pb.write_text('{"defaults": {}, "repos": {}}', encoding="utf-8")
        rep = doctor.Report()
        doctor.check_project(rep, self.repo, self.harness, args(fix=True))
        data = json.loads(pb.read_text(encoding="utf-8"))
        entry = data["repos"][str(self.repo)]
        self.assertEqual(entry["trunk"], "main")
        self.assertIn("main", entry["protected"])
        self.assertTrue((pb.parent / (pb.name + ".bak-doctor")).exists())
        c = next(c for c in rep.checks if c["id"] == "protected-branches")
        self.assertTrue(c.get("fixed"))

    def test_missing_worktree_gitignore_reported_as_edit(self):
        rep = doctor.Report()
        doctor.check_project(rep, self.repo, self.harness, args())
        c = next(c for c in rep.checks if c["id"] == "gitignore-worktrees")
        self.assertEqual(c["status"], "fail")
        self.assertEqual(c["fix"]["kind"], "edit")

    def test_gitignored_config_not_in_worktreeinclude(self):
        (self.repo / ".gitignore").write_text("local.properties\n.claude/worktrees/\n", encoding="utf-8")
        (self.repo / "local.properties").write_text("sdk.dir=x", encoding="utf-8")
        rep = doctor.Report()
        doctor.check_project(rep, self.repo, self.harness, args())
        c = next(c for c in rep.checks if c["id"] == "worktreeinclude")
        self.assertEqual(c["fix"]["append"], ["local.properties"])
        (self.repo / ".worktreeinclude").write_text("local.properties\n", encoding="utf-8")
        rep = doctor.Report()
        doctor.check_project(rep, self.repo, self.harness, args())
        self.assertEqual(next(c for c in rep.checks if c["id"] == "worktreeinclude")["status"], "ok")

    def test_stale_registry_rows_removed(self):
        gone = str(Path(self.tmp.name) / "gone")
        pc = self.harness / "config" / "project-credentials.local.md"
        pc.write_text(f"| repo_path | account |\n|---|---|\n| {gone} | a@x |\n| {self.repo} | b@x |\n",
                      encoding="utf-8")
        rep = doctor.Report()
        doctor.check_stale_registry(rep, self.harness, args(fix=True))
        text = pc.read_text(encoding="utf-8")
        self.assertNotIn(gone, text)
        self.assertIn(str(self.repo), text)

    def test_mechanical_conflicts(self):
        (self.harness / "settings.json").write_text(
            json.dumps({"permissions": {"deny": ["Bash(rm -rf *)"]}}), encoding="utf-8")
        (self.repo / ".claude" / "agents").mkdir(parents=True)
        (self.repo / ".claude" / "agents" / "feature-expert.md").write_text("y", encoding="utf-8")
        (self.repo / ".claude" / "settings.json").write_text(
            json.dumps({"permissions": {"allow": ["Bash(rm -rf *)"]}}), encoding="utf-8")
        (self.repo / "CLAUDE.md").write_text(
            "Зови @doc-writer и @feature-expert. Пакет @anthropic-ai/sdk.\n```\n@ghost-agent\n```\n",
            encoding="utf-8")
        rep = doctor.Report()
        doctor.check_mechanical_conflicts(rep, self.repo, self.harness)
        ids = sorted(c["id"] for c in rep.checks)
        self.assertEqual(ids, ["allow-vs-deny", "dead-agent-ref", "shadow-agents"])
        dead = next(c for c in rep.checks if c["id"] == "dead-agent-ref")
        self.assertIn("@doc-writer", dead["message"])


if __name__ == "__main__":
    sys.exit(unittest.main(verbosity=1))
