#!/usr/bin/env python3
"""Запуск официального Google Ads MCP (googleads/google-ads-mcp) с кредами текущего проекта.

Вызывается inline-сервером `google-ads` из frontmatter `agents/google-ads-expert.md`.
Cloud-проект берётся из колонки `gcp_project` реестра
`~/.claude/config/project-credentials.local.md` по корню git-репозитория
(для worktree — корень основного checkout). Ключ лежит по соглашению
`~/.config/google-ads-mcp/<gcp_project>/credentials.json` (service account
или authorized_user — `google.auth.default()` принимает оба).

Пакет перечитывает файл ключа на каждом вызове инструмента, поэтому ключ,
созданный на шаге setup уже после старта сервера, подхватывается без перезапуска.
Общий ADC (`%APPDATA%\\gcloud\\application_default_credentials.json`) сервер
не видит никогда: `GOOGLE_APPLICATION_CREDENTIALS` задаётся всегда, даже
когда проекта в реестре нет (тогда файл заведомо отсутствует и вызов
падает с понятной ошибкой).

stdout принадлежит протоколу MCP — диагностика идёт только в stderr.

    python mcp_launch.py                 # запустить сервер (stdio)
    python mcp_launch.py --print-config  # JSON с разрешённой конфигурацией, без запуска
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE = "google-ads-mcp==0.0.6"
UNCONFIGURED = "_unconfigured"


def registry_path(home: Path) -> Path:
    return home / ".claude" / "config" / "project-credentials.local.md"


def creds_root(home: Path) -> Path:
    return home / ".config" / "google-ads-mcp"


def _norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(path.strip()))


def _git(cwd: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = out.stdout.strip()
    return value if out.returncode == 0 and value else None


def repo_root(cwd: Path) -> Path:
    """Корень основного checkout: у worktree общий `.git` лежит в нём."""
    # Без --path-format=absolute (git >= 2.31): относительный путь достраивается от cwd.
    common = _git(cwd, "rev-parse", "--git-common-dir")
    if common:
        common_path = Path(common)
        if not common_path.is_absolute():
            common_path = (cwd / common_path).resolve()
        if common_path.name == ".git":
            return common_path.parent
    top = _git(cwd, "rev-parse", "--show-toplevel")
    return Path(top) if top else cwd


def gcp_project_for(root: Path, registry_text: str) -> str | None:
    """`gcp_project` строки реестра, чей `repo_path` совпадает с `root`.

    Реестр — markdown, в нём несколько таблиц; берутся только таблицы,
    у которых в шапке есть и `repo_path`, и `gcp_project`.
    """
    target = _norm(str(root))
    header: list[str] | None = None
    for line in registry_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            header = None
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if header is None:
            header = cells
            continue
        if set(stripped) <= set("|-: "):
            continue
        if "repo_path" not in header or "gcp_project" not in header:
            continue
        row = dict(zip(header, cells))
        if row.get("repo_path") and _norm(row["repo_path"]) == target:
            return row.get("gcp_project") or None
    return None


def resolve(cwd: Path, home: Path) -> dict:
    root = repo_root(cwd)
    registry = registry_path(home)
    try:
        text = registry.read_text(encoding="utf-8")
    except OSError:
        text = ""
    project = gcp_project_for(root, text)
    credentials = creds_root(home) / (project or UNCONFIGURED) / "credentials.json"
    return {
        "repo_root": str(root),
        "registry": str(registry),
        "registry_found": bool(text),
        "gcp_project": project,
        "credentials": str(credentials),
        "credentials_exists": credentials.is_file(),
        "package": PACKAGE,
    }


def build_env(base: dict, config: dict) -> dict:
    env = dict(base)
    env["GOOGLE_APPLICATION_CREDENTIALS"] = config["credentials"]
    if config["gcp_project"]:
        env["GOOGLE_CLOUD_PROJECT"] = config["gcp_project"]
    else:
        env.pop("GOOGLE_CLOUD_PROJECT", None)
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


def main(argv: list[str]) -> int:
    config = resolve(Path.cwd(), Path.home())
    if "--print-config" in argv:
        print(json.dumps(config, ensure_ascii=False, indent=2))
        return 0

    print(
        "google-ads-mcp launcher: repo={repo_root} gcp_project={gcp_project} "
        "credentials={credentials} exists={credentials_exists}".format(**config),
        file=sys.stderr,
    )
    uvx = shutil.which("uvx")
    if not uvx:
        print("google-ads-mcp launcher: uvx not found in PATH (install uv)", file=sys.stderr)
        return 127
    proc = subprocess.run(
        [uvx, "--from", PACKAGE, "google-ads-mcp"],
        env=build_env(dict(os.environ), config),
    )
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
