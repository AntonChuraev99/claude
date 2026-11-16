#!/usr/bin/env python3
"""Tests for review-rules/run.py: --changed-only scope + positive/negative controls
for rules narrowed 2026-10-08 (replay of L2 verdicts 09-08..10-08).

Run:  python review-rules/run.tests.py
RR_DIR=<dir> points the tests at another copy of run.py + *.yaml (e.g. a HEAD snapshot
to show the red state before a change).
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

RR_DIR = Path(os.environ.get("RR_DIR") or Path(__file__).resolve().parent)
_spec = importlib.util.spec_from_file_location("review_rules_run", RR_DIR / "run.py")
rr = importlib.util.module_from_spec(_spec)
_argv, sys.argv = sys.argv, ["run.py"]
_spec.loader.exec_module(rr)
sys.argv = _argv
rr.RULES_DIR = RR_DIR

RULES = {r["id"]: r for r in rr.load_rules(None) if r.get("id")}


def hits(rule_id: str, content: str) -> list[dict]:
    """Detector hits of one registry rule on a whole (new) file."""
    return rr.run_detector(RULES[rule_id], "x", content, None)


class Registry(unittest.TestCase):
    def test_every_yaml_parses(self):
        import yaml
        for yml in sorted(RR_DIR.glob("*.yaml")):
            with self.subTest(file=yml.name):
                yaml.safe_load(yml.read_text(encoding="utf-8"))

    def test_rules_have_message_and_compiling_regexes(self):
        import re
        for rid, rule in RULES.items():
            with self.subTest(rule=rid):
                self.assertTrue(rule.get("message"), "message missing (broken YAML key?)")
                for key in ("has", "lacks", "requires", "unless"):
                    pat = (rule.get("detect") or {}).get(key)
                    if pat:
                        re.compile(pat)


class ChangedOnlyScope(unittest.TestCase):
    """--changed-only must restrict RUNTIME rules to added lines too, not only static."""

    def setUp(self):
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        os.chdir(self._tmp.name)
        Path("Screen.kt").write_text(
            "fun legacy() {\n"
            "    marker()\n"      # line 2: untouched legacy line
            "}\n"
            "fun fresh() {\n"
            "    marker()\n"      # line 5: added in this diff
            "}\n",
            encoding="utf-8",
        )
        self.rule = {"id": "synthetic-runtime", "mode": "runtime", "severity": "medium",
                     "globs": ["**/*.kt"], "detect": {"type": "grep", "has": r"marker\("}}

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def test_runtime_hit_on_untouched_line_is_dropped(self):
        res = rr.review(["Screen.kt"], [self.rule], False, True, {"Screen.kt": {4, 5, 6}}, set())
        self.assertEqual([r["line"] for r in res], [5])

    def test_runtime_rule_skips_touched_file_without_added_lines(self):
        res = rr.review(["Screen.kt"], [self.rule], False, True, {}, set())
        self.assertEqual(res, [])

    def test_runtime_untracked_file_is_entirely_added(self):
        res = rr.review(["Screen.kt"], [self.rule], False, True, {}, {"Screen.kt"})
        self.assertEqual([r["line"] for r in res], [2, 5])

    def test_without_changed_only_runtime_sees_whole_file(self):
        res = rr.review(["Screen.kt"], [self.rule], False, False, {}, set())
        self.assertEqual([r["line"] for r in res], [2, 5])

    def test_edge_to_edge_on_added_line_still_fires(self):
        # positive control of the only confirmed runtime L1 hit (09-23): MainActivity:23 is added
        Path("MainActivity.kt").write_text("\n" * 22 + "        enableEdgeToEdge()\n", encoding="utf-8")
        res = rr.review(["MainActivity.kt"], [RULES["edge-to-edge-bar-tint"]], False, True,
                        {"MainActivity.kt": set(range(1, 24))}, set())
        self.assertEqual([(r["id"], r["line"]) for r in res], [("edge-to-edge-bar-tint", 23)])


class NarrowedRules(unittest.TestCase):
    def test_live_harness_generation_surface_fires(self):
        src = "await page.mouse.click(10, 20);\nawait send({type: 'portal/generate'});\n"
        self.assertTrue(hits("live-harness-outbound-bridge-guard-missing", src))

    def test_live_harness_guarded_is_silent(self):
        src = ("globalThis.__appJsScreenEmit = wrap(globalThis.__appJsScreenEmit);\n"
               "await page.mouse.click(10, 20); // portal/generate\n")
        self.assertEqual(hits("live-harness-outbound-bridge-guard-missing", src), [])

    def test_live_harness_purchase_harness_is_silent(self):
        src = ("await page.getByRole('button', { name: 'Pay' }).click();\n"
               "await page.mouse.click(5, 5); // consent\n")
        self.assertEqual(hits("live-harness-outbound-bridge-guard-missing", src), [])

    def test_padding_horizontal_scroll_fires(self):
        src = "Row(modifier.padding(16.dp).horizontalScroll(rememberScrollState())) {}\n"
        self.assertTrue(hits("padding-outside-scroll-clips-viewport", src))

    def test_padding_vertical_scroll_is_silent(self):
        src = "Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {}\n"
        self.assertEqual(hits("padding-outside-scroll-clips-viewport", src), [])

    def test_raw_textfield_with_placeholder_fires(self):
        src = ("import androidx.compose.material3.OutlinedTextField\n"
               "OutlinedTextField(value, onChange, placeholder = { Text(hint) })\n")
        self.assertTrue(hits("raw-material-textfield-outside-designsystem", src))

    def test_raw_textfield_without_slots_is_silent(self):
        src = ("import androidx.compose.material3.OutlinedTextField\n"
               "OutlinedTextField(value, onChange, singleLine = true)\n")
        self.assertEqual(hits("raw-material-textfield-outside-designsystem", src), [])

    def test_raw_textfield_inside_any_app_wrapper_is_silent(self):
        src = ("import androidx.compose.material3.OutlinedTextField\n"
               "@Composable fun AppSearchField(value: String) {\n"
               "    OutlinedTextField(value, {}, placeholder = { Text(\"q\") })\n}\n")
        self.assertEqual(hits("raw-material-textfield-outside-designsystem", src), [])

    def test_static_guard_source_only_fires(self):
        src = 'const studioPath = join(root, "web-react", "src", "Studio.tsx");\n'
        self.assertTrue(hits("web-react-static-guard-asserts-source-not-bundle", src))

    def test_static_guard_with_bundle_path_literal_is_silent(self):
        src = ('const studioPath = join(root, "web-react", "src", "Studio.tsx");\n'
               'const SHELL_BUNDLE = join(root, "public", "web-react.js");\n')
        self.assertEqual(hits("web-react-static-guard-asserts-source-not-bundle", src), [])

    def test_toast_in_launch_fires(self):
        src = ("import android.widget.Toast\n"
               "scope.launch { Toast.makeText(ctx, \"saved\", Toast.LENGTH_SHORT).show() }\n")
        self.assertTrue(hits("toast-crashes-on-background-thread", src))

    def test_toast_in_plain_click_callback_is_silent(self):
        src = ("import android.widget.Toast\n"
               "Button(onClick = { Toast.makeText(ctx, \"hi\", Toast.LENGTH_SHORT).show() }) {}\n")
        self.assertEqual(hits("toast-crashes-on-background-thread", src), [])

    def test_symbol_glyph_in_composable_fires(self):
        src = "@Composable\nfun Price() { Text(\"→ 9.99\") }\n"
        self.assertTrue(hits("wasmjs-nonemoji-symbol-glyph-tofu", src))

    def test_symbol_glyph_in_non_ui_file_is_silent(self):
        src = "class BuyPremiumUseCase { val tag = \"buy → confirm\" }\n"
        self.assertEqual(hits("wasmjs-nonemoji-symbol-glyph-tofu", src), [])


class StatsPrecision(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("review_rules_stats", RR_DIR / "stats.py")
        self.st = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.st)

    def test_precision_split_by_mode_with_registry_fallback_and_own(self):
        registry = {"s-rule": {"mode": "static"}, "r-rule": {"mode": "runtime"}}
        l2 = [
            {"ts": "2026-10-01T00:00:00", "judged": [
                {"id": "s-rule", "mode": "static", "verdict": "confirmed"},
                {"id": "r-rule", "verdict": "dismissed"},        # legacy row: mode from registry
                {"id": "class-finding", "verdict": "confirmed"},  # not in registry -> own
            ], "own": [{"id": "x", "verdict": "confirmed"}]},
            {"ts": "2026-08-01T00:00:00", "judged": [{"id": "s-rule", "verdict": "dismissed"}]},
        ]
        p = self.st.l2_precision(l2, registry)
        self.assertEqual(p["static"], {"conf": 1, "dism": 1})
        self.assertEqual(p["runtime"], {"conf": 0, "dism": 1})
        self.assertEqual(p["own"], {"conf": 2, "dism": 0})
        p30 = self.st.l2_precision(l2, registry, "2026-09-08")
        self.assertEqual(p30["static"], {"conf": 1, "dism": 0})


class StopGate(unittest.TestCase):
    """--stop-gate (port of stop-gate.ps1): block once per diff, skip a repeated diff
    within one session, never block on a clean tree or on setup errors."""

    RULE = {"id": "synthetic-high", "area": "synthetic", "mode": "static", "severity": "high",
            "globs": ["**/*.kt"], "detect": {"type": "grep", "has": r"BADCALL\("}, "fix": "drop BADCALL"}

    def setUp(self):
        import io
        import json
        import subprocess
        self.io, self.json, self.sp = io, json, subprocess
        self._cwd = os.getcwd()
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()
        g = lambda *a: subprocess.run(["git", "-C", str(self.repo), *a], capture_output=True, check=True)
        g("init", "-q", "-b", "main")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
        self.git = g
        os.environ["REVIEW_RULES_STOPGATE_STATE"] = str(Path(self._tmp.name) / "state")
        os.environ.pop("REVIEW_RULES_NO_STOPGATE", None)
        self._load, self._log = rr.load_rules, rr.STOP_LOG
        self.calls = 0

        def load(area):
            self.calls += 1
            return [dict(self.RULE)]
        rr.load_rules = load
        rr.STOP_LOG = Path(self._tmp.name) / "events.jsonl"

    def tearDown(self):
        rr.load_rules, rr.STOP_LOG = self._load, self._log
        os.environ.pop("REVIEW_RULES_STOPGATE_STATE", None)
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def stop(self, session="s1", cwd=None):
        old_in, old_out = sys.stdin, sys.stdout
        sys.stdin = self.io.StringIO(self.json.dumps({"session_id": session, "cwd": str(cwd or self.repo)}))
        sys.stdout = buf = self.io.StringIO()
        try:
            code = rr.stop_gate()
        finally:
            sys.stdin, sys.stdout = old_in, old_out
        out = buf.getvalue().strip()
        return code, (self.json.loads(out) if out else None)

    def test_clean_tree_passes(self):
        self.assertEqual(self.stop(), (0, None))

    def test_high_blocks_once_then_passes(self):
        (self.repo / "A.kt").write_text("fun f() { BADCALL() }\n", encoding="utf-8")
        code, out = self.stop()
        self.assertEqual(code, 0)
        self.assertEqual(out["decision"], "block")
        self.assertIn("synthetic/synthetic-high", out["reason"])
        self.assertIn("drop BADCALL", out["reason"])
        # same diff, same session -> skipped before the review runs
        calls = self.calls
        self.assertEqual(self.stop(), (0, None))
        self.assertEqual(self.calls, calls, "repeated diff must not re-run the review")
        # same diff, another session -> review runs, ack marker lets it pass
        self.assertEqual(self.stop(session="s2"), (0, None))
        self.assertEqual(self.calls, calls + 1)

    def test_edit_inside_untracked_file_is_judged_again(self):
        # Regression guard: the plain diff hash lists untracked NAMES only. A clean stop,
        # then a static-HIGH typed into the same untracked file, must still block.
        (self.repo / "A.kt").write_text("fun f() { ok() }\n", encoding="utf-8")
        self.assertEqual(self.stop(), (0, None))
        (self.repo / "A.kt").write_text("fun f() { ok(); BADCALL() }\n", encoding="utf-8")
        code, out = self.stop()
        self.assertEqual((code, out and out["decision"]), (0, "block"))

    def test_changed_diff_is_judged_again(self):
        (self.repo / "A.kt").write_text("fun f() { BADCALL() }\n", encoding="utf-8")
        self.assertEqual(self.stop()[1]["decision"], "block")
        (self.repo / "B.kt").write_text("fun g() { BADCALL() }\n", encoding="utf-8")
        self.assertEqual(self.stop()[1]["decision"], "block")

    def test_fixed_diff_clears_the_marker(self):
        (self.repo / "A.kt").write_text("fun f() { BADCALL() }\n", encoding="utf-8")
        self.stop()
        marker = self.repo / ".git" / "review-rules-ack"
        self.assertTrue(marker.exists())
        (self.repo / "A.kt").write_text("fun f() { ok() }\n", encoding="utf-8")
        self.assertEqual(self.stop(), (0, None))
        self.assertFalse(marker.exists())

    def test_worktree_marker_lives_in_git_dir(self):
        # stop-gate.ps1 wrote <root>/.git/review-rules-ack; in a linked worktree .git is a
        # file, the write failed and the same diff re-blocked on every stop.
        wt = Path(self._tmp.name) / "wt"
        self.git("worktree", "add", "-q", str(wt), "-b", "feat")
        (wt / "A.kt").write_text("fun f() { BADCALL() }\n", encoding="utf-8")
        self.assertEqual(self.stop(cwd=wt)[1]["decision"], "block")
        self.assertEqual(self.stop(session="s2", cwd=wt), (0, None), "ack must hold in a worktree")

    def test_opt_out_and_setup_error_never_block(self):
        (self.repo / "A.kt").write_text("fun f() { BADCALL() }\n", encoding="utf-8")
        os.environ["REVIEW_RULES_NO_STOPGATE"] = "1"
        try:
            self.assertEqual(self.stop(), (0, None))
        finally:
            os.environ.pop("REVIEW_RULES_NO_STOPGATE", None)
        saved, rr.yaml = rr.yaml, None
        try:
            self.assertEqual(self.stop(session="s3"), (0, None))
        finally:
            rr.yaml = saved

    def test_cli_entry_point(self):
        (self.repo / "A.kt").write_text("fun f() { ok() }\n", encoding="utf-8")
        p = self.sp.run([sys.executable, str(RR_DIR / "run.py"), "--stop-gate"],
                        input=self.json.dumps({"session_id": "cli", "cwd": str(self.repo)}),
                        capture_output=True, text=True, encoding="utf-8",
                        env=dict(os.environ, REVIEW_RULES_STOPGATE_STATE=str(Path(self._tmp.name) / "s")))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main(verbosity=1)
