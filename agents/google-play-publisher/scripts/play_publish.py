#!/usr/bin/env python3
"""
play_publish.py — публикация Android App Bundle (AAB) в Google Play
через ОФИЦИАЛЬНЫЙ Google Play Developer API v3.

Никаких сторонних плагинов сборки (GPP/Fastlane) — только google-api-python-client.
Один и тот же скрипт работает локально (из Claude Code) и в CI (GitLab/др.).
Полная инструкция по переиспользованию — ../README.md.

Поток (edits API): insert edit → upload bundle → assign track → [mapping.txt] → commit.

Пример:
  python play_publish.py \
      --package com.example.app \
      --aab build/outputs/bundle/release/app-release.aab \
      --track internal \
      --service-account ~/secrets/play-sa.json \
      --release-notes "@release-notes.txt"
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from typing import Optional

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload
except ImportError:
    sys.exit(
        "Не установлены зависимости. Установи их командой:\n"
        "  pip install -r requirements.txt\n"
        "(google-api-python-client, google-auth, google-auth-httplib2)"
    )

ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher"
VALID_TRACKS = ("internal", "alpha", "beta", "production")
VALID_STATUS = ("draft", "inProgress", "halted", "completed")


def log(msg: str) -> None:
    print(f"[play-publish] {msg}", flush=True)


def load_credentials(sa_path: Optional[str]):
    """
    Порядок поиска service-account (секрет нигде не печатается):
      1. --service-account <path>
      2. env PLAY_SERVICE_ACCOUNT_JSON  — СОДЕРЖИМОЕ json (для CI-переменных)
      3. env GOOGLE_APPLICATION_CREDENTIALS — путь к файлу
    """
    scopes = [ANDROID_PUBLISHER_SCOPE]
    if sa_path:
        sa_path = os.path.expanduser(sa_path)
        log(f"Service account: файл {sa_path}")
        return service_account.Credentials.from_service_account_file(sa_path, scopes=scopes)

    raw = os.environ.get("PLAY_SERVICE_ACCOUNT_JSON")
    if raw:
        log("Service account: из env PLAY_SERVICE_ACCOUNT_JSON")
        return service_account.Credentials.from_service_account_info(json.loads(raw), scopes=scopes)

    gac = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if gac:
        log(f"Service account: из env GOOGLE_APPLICATION_CREDENTIALS ({gac})")
        return service_account.Credentials.from_service_account_file(gac, scopes=scopes)

    sys.exit(
        "Не задан service account. Укажи --service-account <path> "
        "или env PLAY_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS."
    )


def resolve_release_notes(text: Optional[str], lang: str):
    if not text:
        return None
    if text.startswith("@"):  # @path — прочитать из файла
        with open(os.path.expanduser(text[1:]), "r", encoding="utf-8") as f:
            text = f.read().strip()
    return [{"language": lang, "text": text}]


def upload_bundle(service, package, edit_id, aab_path) -> int:
    log(f"Загрузка AAB: {aab_path}")
    media = MediaFileUpload(
        aab_path,
        mimetype="application/octet-stream",
        resumable=True,               # обязательно для AAB (>5MB)
        chunksize=50 * 1024 * 1024,   # 50MB, кратно 256KB
    )
    request = service.edits().bundles().upload(
        packageName=package, editId=edit_id, media_body=media,
    )
    response = None
    while response is None:
        status, response = request.next_chunk(num_retries=3)
        if status:
            log(f"  загружено {int(status.progress() * 100)}%")
    version_code = response["versionCode"]
    log(f"AAB загружен, versionCode={version_code}")
    return version_code


def _explain(e: HttpError) -> str:
    """Расшифровать ошибку API в понятную подсказку (частые грабли)."""
    try:
        msg = json.loads(e.content.decode("utf-8")).get("error", {}).get("message", str(e))
    except Exception:
        msg = str(e)
    hints = {
        "already been used": "versionCode уже использован — подними versionCode сборки.",
        "not been published": "Приложение ещё не опубликовано — залей ПЕРВЫЙ релиз вручную через "
                              "Play Console UI, дальше API заработает.",
        "does not have permission": "У service-account нет прав. Play Console → Users & Permissions "
                                    "→ роль Release manager. Права пропагируются до 24-48ч.",
        "edit": "Возможно висит незакоммиченный edit (один open edit на пакет) — повтори запуск.",
    }
    for needle, hint in hints.items():
        if needle.lower() in msg.lower():
            return f"{msg}\n  ↳ {hint}"
    return msg


def main() -> None:
    p = argparse.ArgumentParser(
        description="Публикация AAB в Google Play через официальный Play Developer API v3.",
    )
    p.add_argument("--package", required=True, help="applicationId, напр. com.example.app")
    p.add_argument("--aab", required=True, help="путь к .aab")
    p.add_argument("--track", default="internal", choices=VALID_TRACKS,
                   help="трек Play (default: internal)")
    p.add_argument("--service-account", help="путь к service-account JSON (или из env)")
    p.add_argument("--status", default="completed", choices=VALID_STATUS,
                   help="статус релиза (default: completed)")
    p.add_argument("--user-fraction", type=float,
                   help="доля раскатки 0..1 — только для status=inProgress (staged rollout)")
    p.add_argument("--release-notes", help="текст what's-new или @путь_к_файлу")
    p.add_argument("--release-notes-lang", default="en-US", help="язык release notes (default en-US)")
    p.add_argument("--release-name", help="имя релиза (опц)")
    p.add_argument("--mapping", help="путь к mapping.txt для деобфускации (опц)")
    p.add_argument("--http-timeout", type=int, default=300,
                   help="socket timeout, сек, для больших AAB (default 300)")
    p.add_argument("--dry-run", action="store_true",
                   help="пройти insert+upload+track, но НЕ commit (edit истечёт сам, ничего не опубликуется)")
    args = p.parse_args()

    args.aab = os.path.expanduser(args.aab)
    if not os.path.isfile(args.aab):
        sys.exit(f"AAB не найден: {args.aab}")
    if args.status == "inProgress" and args.user_fraction is None:
        sys.exit("status=inProgress требует --user-fraction (0..1).")
    if args.user_fraction is not None and not (0.0 < args.user_fraction < 1.0):
        sys.exit("--user-fraction должен быть в диапазоне (0,1).")
    if args.mapping:
        args.mapping = os.path.expanduser(args.mapping)
        if not os.path.isfile(args.mapping):
            sys.exit(f"mapping не найден: {args.mapping}")

    if args.track == "production":
        log("⚠️  PRODUCTION: релиз увидят реальные пользователи. Убедись, что это намеренно.")

    socket.setdefaulttimeout(args.http_timeout)
    credentials = load_credentials(args.service_account)
    service = build("androidpublisher", "v3", credentials=credentials, cache_discovery=False)

    log(f"Создание edit для {args.package}")
    try:
        edit_id = service.edits().insert(packageName=args.package, body={}).execute()["id"]
    except HttpError as e:
        sys.exit(f"Не удалось создать edit: {_explain(e)}")

    try:
        version_code = upload_bundle(service, args.package, edit_id, args.aab)

        release = {"versionCodes": [str(version_code)], "status": args.status}
        if args.release_name:
            release["name"] = args.release_name
        notes = resolve_release_notes(args.release_notes, args.release_notes_lang)
        if notes:
            release["releaseNotes"] = notes
        if args.user_fraction is not None:
            release["userFraction"] = args.user_fraction

        log(f"Назначение в трек '{args.track}' (status={args.status})")
        service.edits().tracks().update(
            packageName=args.package, editId=edit_id, track=args.track,
            body={"releases": [release]},
        ).execute()

        if args.mapping:
            log(f"Загрузка mapping.txt (deobfuscation) для versionCode={version_code}")
            service.edits().deobfuscationfiles().upload(
                packageName=args.package, editId=edit_id,
                apkVersionCode=version_code, deobfuscationFileType="proguard",
                media_body=MediaFileUpload(args.mapping, mimetype="application/octet-stream"),
            ).execute()

        if args.dry_run:
            log("DRY-RUN: commit пропущен. Edit истечёт сам, ничего не опубликовано.")
            return

        log("Commit edit…")
        service.edits().commit(packageName=args.package, editId=edit_id).execute()
        log(f"✅ Опубликовано: {args.package} v{version_code} → трек '{args.track}' (status={args.status})")

    except HttpError as e:
        try:  # не оставлять висящий edit
            service.edits().delete(packageName=args.package, editId=edit_id).execute()
        except Exception:
            pass
        sys.exit(f"Ошибка публикации: {_explain(e)}")


if __name__ == "__main__":
    main()
