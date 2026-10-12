#!/usr/bin/env python3
"""
play_publish.py — публикация Android App Bundle (AAB) в Google Play
через ОФИЦИАЛЬНЫЙ Google Play Developer API v3.

Никаких сторонних плагинов сборки (GPP/Fastlane) — только google-api-python-client.
Один и тот же скрипт работает локально (из Claude Code) и в CI (GitLab/др.).
Полная инструкция по переиспользованию — ../README.md.

Поток (edits API): insert edit → [upload bundle] → assign track(s) → [mapping.txt] → commit.

Режимы:
  --aab <файл>            загрузить новый AAB и назначить его в трек(и);
  --version-codes 123,124 без загрузки: собрать release из уже загруженных versionCode
                          (promote internal→production, смена userFraction / halt).

Пример:
  python play_publish.py \
      --package com.example.app \
      --aab build/outputs/bundle/release/app-release.aab \
      --track internal \
      --service-account ~/secrets/play-sa.json \
      --release-notes "@release-notes.txt"

Несколько языков и треков:
  python play_publish.py --package com.example.app --version-codes 124 \
      --track production --status inProgress --user-fraction 0.1 \
      --release-notes "en-US=@notes/en.txt" --release-notes "ru-RU=Исправления"
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
from typing import List, Optional

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload
    _IMPORT_ERROR: Optional[ImportError] = None
except ImportError as _e:  # --help и чистые функции работают и без зависимостей
    _IMPORT_ERROR = _e

    class HttpError(Exception):  # type: ignore[no-redef]
        """Заглушка, чтобы `except HttpError` компилировался без зависимостей."""

ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher"
STANDARD_TRACKS = ("internal", "alpha", "beta", "production")  # custom closed-треки тоже допустимы
VALID_STATUS = ("draft", "inProgress", "halted", "completed")

# `lang=текст` / `lang=@файл`. Язык — BCP-47-подобный тег с lowercase-первым сабтегом
# (en-US, ru-RU, pt-BR, zh-Hant-TW, es-419). Всё остальное — старая форма без языка.
_LANG_PREFIX = re.compile(r"^([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)=(.*)$", re.DOTALL)


def log(msg: str) -> None:
    line = f"[play-publish] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:  # консоль cp1251 и т.п.: emoji не должны ронять публикацию
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        print(line.encode(enc, "replace").decode(enc), flush=True)


def require_deps() -> None:
    if _IMPORT_ERROR is not None:
        sys.exit(
            "Не установлены зависимости. Установи их командой:\n"
            "  pip install -r requirements.txt\n"
            "(google-api-python-client, google-auth, google-auth-httplib2)"
        )


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


def _read_notes_text(text: str) -> str:
    if text.startswith("@"):  # @path — прочитать из файла
        path = os.path.expanduser(text[1:])
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except OSError as e:
            raise ValueError(f"не удалось прочитать файл release notes '{path}': {e}") from e
    return text.strip()


def parse_release_notes(values: Optional[List[str]], default_lang: str) -> List[dict]:
    """
    Разобрать значения --release-notes (флаг повторяемый) в releaseNotes API.

    Каждое значение — `lang=текст`, `lang=@файл`, либо старая форма `текст` / `@файл`,
    которой назначается default_lang (--release-notes-lang). Дубликат языка — ValueError.
    """
    notes: List[dict] = []
    seen = {}
    for raw in values or []:
        m = _LANG_PREFIX.match(raw)
        if m:
            lang, body = m.group(1), m.group(2)
        else:
            lang, body = default_lang, raw
        if lang in seen:
            raise ValueError(
                f"release notes для языка '{lang}' заданы дважды "
                f"('{seen[lang]}' и '{raw}'). Один --release-notes на язык; "
                f"значение без 'lang=' получает язык из --release-notes-lang ({default_lang})."
            )
        text = _read_notes_text(body)
        if not text:
            if not m:
                # Старая форма без 'lang=': пустое значение (пустой $NOTES в CI) = «без notes», как раньше.
                continue
            raise ValueError(f"пустые release notes для языка '{lang}' ('{raw}').")
        seen[lang] = raw
        notes.append({"language": lang, "text": text})
    return notes


def parse_version_codes(value: str) -> List[int]:
    """'123, 124' → [123, 124]. Пустые, нечисловые, <=0 и повторы — ValueError."""
    codes: List[int] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            raise ValueError(f"пустой элемент в --version-codes '{value}'.")
        try:
            code = int(part)
        except ValueError:
            raise ValueError(f"versionCode должен быть целым числом, получено '{part}'.") from None
        if code <= 0:
            raise ValueError(f"versionCode должен быть > 0, получено {code}.")
        if code in codes:
            raise ValueError(f"versionCode {code} указан дважды в --version-codes.")
        codes.append(code)
    return codes


def parse_tracks(values: Optional[List[str]]) -> List[str]:
    """Повторяемый --track → список без повторов, порядок сохранён. Default — ['internal']."""
    tracks: List[str] = []
    for t in values or ["internal"]:
        t = t.strip()
        if not t:
            raise ValueError("пустое имя трека в --track.")
        if t not in tracks:
            tracks.append(t)
    return tracks


def build_release(version_codes: List[int], status: str, fraction: Optional[float],
                  notes: Optional[List[dict]], name: Optional[str]) -> dict:
    """Тело одного release для edits.tracks.update (versionCodes в API — строки)."""
    release = {"versionCodes": [str(c) for c in version_codes], "status": status}
    if name:
        release["name"] = name
    if notes:
        release["releaseNotes"] = notes
    if fraction is not None:
        release["userFraction"] = fraction
    return release


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


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Публикация AAB в Google Play через официальный Play Developer API v3.",
    )
    p.add_argument("--package", required=True, help="applicationId, напр. com.example.app")
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument("--aab", help="путь к .aab — загрузить новый bundle")
    source.add_argument("--version-codes",
                        help="без загрузки: уже загруженные versionCode через запятую, напр. 123,124 "
                             "(promote между треками, смена userFraction, halt)")
    p.add_argument("--track", action="append",
                   help="трек Play: internal / alpha / beta / production или имя custom closed-трека. "
                        "Можно повторять — один release уйдёт в каждый трек одним edit "
                        "(default: internal)")
    p.add_argument("--service-account", help="путь к service-account JSON (или из env)")
    p.add_argument("--status", default="completed", choices=VALID_STATUS,
                   help="статус релиза (default: completed)")
    p.add_argument("--user-fraction", type=float,
                   help="доля раскатки 0..1 — только для status=inProgress (staged rollout)")
    p.add_argument("--release-notes", action="append",
                   help="what's-new: 'lang=текст' или 'lang=@файл', флаг можно повторять по языкам. "
                        "Без 'lang=' — текст или @файл на языке --release-notes-lang")
    p.add_argument("--release-notes-lang", default="en-US",
                   help="язык для --release-notes без 'lang=' (default en-US)")
    p.add_argument("--release-name", help="имя релиза (опц)")
    p.add_argument("--mapping", help="путь к mapping.txt для деобфускации (опц, только с --aab)")
    p.add_argument("--http-timeout", type=int, default=300,
                   help="socket timeout, сек, для больших AAB (default 300)")
    p.add_argument("--dry-run", action="store_true",
                   help="пройти insert+[upload]+track, но НЕ commit (edit истечёт сам, ничего не опубликуется)")
    return p


def main() -> None:
    p = build_parser()
    args = p.parse_args()

    try:
        tracks = parse_tracks(args.track)
        notes = parse_release_notes(args.release_notes, args.release_notes_lang)
        version_codes = parse_version_codes(args.version_codes) if args.version_codes else None
    except ValueError as e:
        p.error(str(e))

    if args.aab:
        args.aab = os.path.expanduser(args.aab)
        if not os.path.isfile(args.aab):
            sys.exit(f"AAB не найден: {args.aab}")
    if args.status == "inProgress" and args.user_fraction is None:
        sys.exit("status=inProgress требует --user-fraction (0..1).")
    if args.user_fraction is not None and not (0.0 < args.user_fraction < 1.0):
        sys.exit("--user-fraction должен быть в диапазоне (0,1).")
    if args.mapping:
        if not args.aab:
            sys.exit("--mapping загружается только вместе с --aab "
                     "(для уже загруженного versionCode — через Play Console).")
        args.mapping = os.path.expanduser(args.mapping)
        if not os.path.isfile(args.mapping):
            sys.exit(f"mapping не найден: {args.mapping}")

    if "production" in tracks:
        log("⚠️  PRODUCTION: релиз увидят реальные пользователи. Убедись, что это намеренно.")

    require_deps()
    socket.setdefaulttimeout(args.http_timeout)
    credentials = load_credentials(args.service_account)
    service = build("androidpublisher", "v3", credentials=credentials, cache_discovery=False)

    log(f"Создание edit для {args.package}")
    try:
        edit_id = service.edits().insert(packageName=args.package, body={}).execute()["id"]
    except HttpError as e:
        sys.exit(f"Не удалось создать edit: {_explain(e)}")

    try:
        if args.aab:
            version_codes = [upload_bundle(service, args.package, edit_id, args.aab)]
        else:
            log(f"Без загрузки AAB: versionCodes={version_codes}")

        release = build_release(version_codes, args.status, args.user_fraction,
                                notes, args.release_name)

        for track in tracks:
            log(f"Назначение в трек '{track}' (status={args.status})")
            service.edits().tracks().update(
                packageName=args.package, editId=edit_id, track=track,
                body={"releases": [release]},
            ).execute()

        if args.mapping:
            log(f"Загрузка mapping.txt (deobfuscation) для versionCode={version_codes[0]}")
            service.edits().deobfuscationfiles().upload(
                packageName=args.package, editId=edit_id,
                apkVersionCode=version_codes[0], deobfuscationFileType="proguard",
                media_body=MediaFileUpload(args.mapping, mimetype="application/octet-stream"),
            ).execute()

        if args.dry_run:
            log(f"DRY-RUN: release = {json.dumps(release, ensure_ascii=False)}")
            log("DRY-RUN: commit пропущен. Edit истечёт сам, ничего не опубликовано.")
            return

        log("Commit edit…")
        service.edits().commit(packageName=args.package, editId=edit_id).execute()
        vc = ",".join(str(c) for c in version_codes)
        log(f"✅ Опубликовано: {args.package} v{vc} → трек(и) {', '.join(tracks)} (status={args.status})")

    except HttpError as e:
        try:  # не оставлять висящий edit
            service.edits().delete(packageName=args.package, editId=edit_id).execute()
        except Exception:
            pass
        sys.exit(f"Ошибка публикации: {_explain(e)}")


if __name__ == "__main__":
    main()
