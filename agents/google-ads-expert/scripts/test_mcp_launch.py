"""Тесты разрешения конфигурации лаунчера Google Ads MCP.

    python -m unittest discover -s agents/google-ads-expert/scripts -p "test_*.py"
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mcp_launch  # noqa: E402

REGISTRY = """# Реестр

| repo_path | account | gcp_project | git_remote |
|---|---|---|---|
| C:\\Work\\app-one | a@example.com | app-one-123 | https://example.com/one.git |
| C:\\Work\\parent | a@example.com |  | |
| C:\\Work\\parent\\child | a@example.com | child-proj | |

## Другая таблица

| play_package | service account | key file |
|---|---|---|
| com.example.one | sa@app-one-123.iam.gserviceaccount.com | C:\\Work\\app-one |
"""


class GcpProjectForTest(unittest.TestCase):
    def test_exact_match_returns_project(self):
        self.assertEqual(
            mcp_launch.gcp_project_for(Path("C:/Work/app-one"), REGISTRY), "app-one-123"
        )

    @unittest.skipUnless(os.name == "nt", "регистр путей не важен только на Windows")
    def test_match_ignores_case_and_slashes_on_windows(self):
        self.assertEqual(
            mcp_launch.gcp_project_for(Path("c:/work/APP-ONE/"), REGISTRY), "app-one-123"
        )

    def test_empty_cell_returns_none(self):
        self.assertIsNone(mcp_launch.gcp_project_for(Path("C:/Work/parent"), REGISTRY))

    def test_nested_repo_matches_only_itself(self):
        self.assertEqual(
            mcp_launch.gcp_project_for(Path("C:/Work/parent/child"), REGISTRY), "child-proj"
        )

    def test_unknown_repo_returns_none(self):
        self.assertIsNone(mcp_launch.gcp_project_for(Path("C:/Work/other"), REGISTRY))

    def test_table_without_columns_is_ignored(self):
        # key file колонка совпадает с repo_path первой таблицы, но шапка другая
        text = REGISTRY.split("## Другая таблица")[1]
        self.assertIsNone(mcp_launch.gcp_project_for(Path("C:/Work/app-one"), text))


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.home / ".claude" / "config").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write_registry(self, project: str):
        text = (
            "| repo_path | gcp_project |\n|---|---|\n"
            f"| {self.repo} | {project} |\n"
        )
        mcp_launch.registry_path(self.home).write_text(text, encoding="utf-8")

    def test_project_from_registry_and_credentials_path(self):
        self.write_registry("proj-x")
        config = mcp_launch.resolve(self.repo, self.home)
        self.assertEqual(config["gcp_project"], "proj-x")
        expected = self.home / ".config" / "google-ads-mcp" / "proj-x" / "credentials.json"
        self.assertEqual(Path(config["credentials"]), expected)
        self.assertFalse(config["credentials_exists"])

    def test_credentials_exists_flag(self):
        self.write_registry("proj-x")
        key = self.home / ".config" / "google-ads-mcp" / "proj-x" / "credentials.json"
        key.parent.mkdir(parents=True)
        key.write_text("{}", encoding="utf-8")
        self.assertTrue(mcp_launch.resolve(self.repo, self.home)["credentials_exists"])

    def test_subdirectory_resolves_to_repo_root(self):
        self.write_registry("proj-x")
        sub = self.repo / "app" / "src"
        sub.mkdir(parents=True)
        self.assertEqual(mcp_launch.resolve(sub, self.home)["gcp_project"], "proj-x")

    def test_missing_registry_falls_back_to_unconfigured(self):
        config = mcp_launch.resolve(self.repo, self.home)
        self.assertIsNone(config["gcp_project"])
        self.assertFalse(config["registry_found"])
        self.assertIn(mcp_launch.UNCONFIGURED, config["credentials"])


class BuildEnvTest(unittest.TestCase):
    def test_always_sets_credentials_and_never_leaks_shared_adc(self):
        config = {"credentials": "C:/k/_unconfigured/credentials.json", "gcp_project": None}
        env = mcp_launch.build_env({"GOOGLE_CLOUD_PROJECT": "stale"}, config)
        self.assertEqual(env["GOOGLE_APPLICATION_CREDENTIALS"], config["credentials"])
        self.assertNotIn("GOOGLE_CLOUD_PROJECT", env)

    def test_sets_project(self):
        config = {"credentials": "C:/k/p/credentials.json", "gcp_project": "p"}
        env = mcp_launch.build_env({}, config)
        self.assertEqual(env["GOOGLE_CLOUD_PROJECT"], "p")


if __name__ == "__main__":
    unittest.main()
