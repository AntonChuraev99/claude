#!/usr/bin/env python3
"""Проверка: собран ли APK после последней правки исходников.

/install-device и /install-emulator зовут скрипт перед сборкой: свежий APK
переустанавливается без `assembleDebug`.

Свежий = ни один не-ignored файл репозитория (tracked + untracked, без
gitignored — туда попадают build/, .gradle/, local.properties) не изменён
позже APK, ни один их каталог тоже (удаление, создание и переименование
записи — в т.ч. `git rm`/`git mv` — меняют mtime каталога, а у перенесённого
файла mtime старый), и в рабочем дереве нет unstaged-удалённых tracked-файлов
(момент удаления неизвестен — считаем, что после сборки). Файлы submodule'ей
проверяются тоже (`--recurse-submodules`).

Gitignored-конфиги (local.properties, secrets/keystore.properties) скрипт не
видит — их правку вызывающий учитывает сам.

    python ~/.claude/scripts/apk-freshness.py <path-to.apk> [--root <repo>]

Вывод и код выхода:
    0  FRESH <apk> (built <время>)
    1  STALE: <причина> + до 5 файлов новее APK
    2  ошибка: нет APK, не git-репозиторий
"""
import argparse
import datetime
import os
import subprocess
import sys


def git_files(root, *flags):
    out = subprocess.run(
        ["git", "-C", root, "ls-files", "-z", *flags],
        capture_output=True, check=True,
    ).stdout
    return [p for p in out.decode("utf-8", "replace").split("\0") if p]


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # cp1251-консоль Windows ломает кириллицу
    ap = argparse.ArgumentParser()
    ap.add_argument("apk")
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    if not os.path.isfile(args.apk):
        print(f"ERROR: APK не найден: {args.apk}")
        return 2
    try:
        root = subprocess.run(
            ["git", "-C", args.root, "rev-parse", "--show-toplevel"],
            capture_output=True, check=True, text=True,
        ).stdout.strip()
        files = git_files(root, "--cached", "--others", "--exclude-standard")
        # --recurse-submodules несовместим с --others: отдельным вызовом
        files += git_files(root, "--cached", "--recurse-submodules")
        deleted = git_files(root, "--deleted")
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"ERROR: git недоступен или не репозиторий: {e}")
        return 2

    apk_mtime = os.path.getmtime(args.apk)
    built = datetime.datetime.fromtimestamp(apk_mtime).isoformat(timespec="seconds")
    if deleted:
        print(f"STALE: удалены tracked-файлы после последнего коммита ({len(deleted)}): "
              + ", ".join(deleted[:5]))
        return 1

    paths = set(files)
    for rel in files:
        parent = os.path.dirname(rel)
        while parent:
            paths.add(parent)
            parent = os.path.dirname(parent)
    paths.add("")  # корень репозитория

    newer = []
    for rel in paths:
        try:
            if os.path.getmtime(os.path.join(root, rel)) > apk_mtime:
                newer.append(rel or ".")
        except OSError:
            continue
    if newer:
        newer.sort()
        print(f"STALE: {len(newer)} файл(ов) и каталог(ов) новее APK (built {built}): " + ", ".join(newer[:5]))
        return 1
    print(f"FRESH {args.apk} (built {built})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
