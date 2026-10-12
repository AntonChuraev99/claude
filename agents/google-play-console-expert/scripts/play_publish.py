#!/usr/bin/env python3
"""
play_publish.py — публикация Android App Bundle (AAB) в Google Play
через ОФИЦИАЛЬНЫЙ Google Play Developer API v3.

Никаких сторонних плагинов сборки (GPP/Fastlane) — только google-api-python-client.
Один и тот же скрипт работает локально (из Claude Code) и в CI (GitLab/др.).
Полная инструкция по переиспользованию — ../README.md.

Поток (edits API): insert edit → [upload bundle] → tracks.list → assign track(s) объединённым
списком releases → read-back gate → [mapping.txt] → commit.
tracks.update заменяет список releases трека целиком, поэтому staged rollout сохраняет
completed-релиз трека, а promote/ramp уже живого versionCode копирует его notes и name.

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
import copy
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


def _codes_key(codes) -> tuple:
    """Множество versionCodes как сравнимый ключ (API отдаёт строки, флаги — int)."""
    return tuple(sorted(str(c) for c in codes or []))


def find_release(releases: Optional[List[dict]], version_codes) -> Optional[dict]:
    """Release трека с ровно этим набором versionCodes, иначе None."""
    key = _codes_key(version_codes)
    for r in releases or []:
        if _codes_key(r.get("versionCodes")) == key:
            return r
    return None


def find_notes_elsewhere(tracks: List[dict], version_codes, exclude_track: str) -> Optional[List[dict]]:
    """releaseNotes release'а с этими versionCodes из другого трека (ответ tracks.list), иначе None."""
    for t in tracks or []:
        if t.get("track") == exclude_track:
            continue
        r = find_release(t.get("releases"), version_codes)
        if r is not None and r.get("releaseNotes"):
            return copy.deepcopy(r["releaseNotes"])
    return None


def merge_track_releases(current_releases: Optional[List[dict]], new_release: dict) -> List[dict]:
    """
    Полный список releases для edits.tracks.update (update ЗАМЕНЯЕТ список целиком, issue #50).

    - Release с теми же versionCodes уже есть в треке (promote / ramp / halt) — берётся он
      дословно; status из new_release; releaseNotes и name из new_release переопределяют
      скопированные только если заданы флагами (ключ есть в new_release). userFraction:
      completed/draft — удаляется (Play отвергает его с completed), inProgress — из флага,
      halted — из флага, иначе прежний.
    - inProgress/halted: к нему добавляются completed-релизы трека ДОСЛОВНО (база для
      невыкаченной аудитории — при halt staged rollout она продолжает получать прежний релиз);
      прежние inProgress/halted выбрасываются (supersede).
    - completed/draft: единственный release (completed вытесняет всё, один на трек).
    """
    current = current_releases or []
    target = _codes_key(new_release["versionCodes"])
    existing = find_release(current, new_release["versionCodes"])
    if existing is not None:
        release = copy.deepcopy(existing)
        release["status"] = new_release["status"]
        for key in ("releaseNotes", "name"):
            if key in new_release:
                release[key] = copy.deepcopy(new_release[key])
        if new_release["status"] in ("completed", "draft"):
            release.pop("userFraction", None)
        elif "userFraction" in new_release:
            release["userFraction"] = new_release["userFraction"]
        elif new_release["status"] == "inProgress":
            release.pop("userFraction", None)
    else:
        release = copy.deepcopy(new_release)

    if release["status"] not in ("inProgress", "halted"):
        return [release]
    kept = [copy.deepcopy(r) for r in current
            if r.get("status") == "completed" and _codes_key(r.get("versionCodes")) != target]
    return [release] + kept


def check_gate(before: Optional[List[dict]], after: Optional[List[dict]], sent: dict) -> List[str]:
    """
    Within-edit read-back gate: сверить releases трека после update с отправленным release.
    Возвращает список ошибок (пусто — гейт пройден). name сверяется, только если он был в
    отправленном release (Play заполняет name на commit, в read-back внутри edit его может не быть).
    """
    errors: List[str] = []
    after = after or []
    target = _codes_key(sent["versionCodes"])
    status = sent["status"]
    matches = [r for r in after if _codes_key(r.get("versionCodes")) == target]

    if status == "inProgress":
        ip = [r for r in after if r.get("status") == "inProgress"]
        if len(ip) != 1:
            errors.append(f"ожидался ровно один inProgress, в треке {len(ip)}.")
        else:
            if _codes_key(ip[0].get("versionCodes")) != target:
                errors.append(f"inProgress с versionCodes {ip[0].get('versionCodes')}, "
                              f"ожидались {list(target)}.")
            frac = ip[0].get("userFraction")
            if frac is None or abs(float(frac) - float(sent["userFraction"])) > 1e-9:
                errors.append(f"userFraction={frac}, ожидалось {sent['userFraction']}.")
    elif status == "completed":
        if len(after) != 1:
            errors.append(f"ожидался ровно один release, в треке {len(after)}.")
        if len(matches) != 1 or matches[0].get("status") != "completed":
            errors.append(f"нет completed-релиза с versionCodes {list(target)}.")
        elif "userFraction" in matches[0]:
            errors.append("у completed-релиза осталась userFraction.")
    else:
        if not any(m.get("status") == status for m in matches):
            errors.append(f"нет релиза {list(target)} со status={status}.")

    if status in ("inProgress", "halted"):
        for r in before or []:
            if r.get("status") != "completed" or _codes_key(r.get("versionCodes")) == target:
                continue
            key = _codes_key(r.get("versionCodes"))
            if not any(a.get("status") == "completed" and _codes_key(a.get("versionCodes")) == key
                       for a in after):
                errors.append(f"пропал completed-релиз {list(key)} — база для невыкаченной аудитории.")

    if "name" in sent and not any(m.get("name") == sent["name"] for m in matches):
        errors.append(f"name релиза не совпал с отправленным '{sent['name']}'.")
    return errors


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
    if args.user_fraction is not None and args.status in ("completed", "draft"):
        sys.exit(f"--user-fraction несовместим со status={args.status} (Play принимает его только "
                 "для inProgress/halted).")
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

        # tracks.update ЗАМЕНЯЕТ список releases трека (issue #50): сначала читаем текущее
        # состояние всех треков этого edit, затем отправляем объединённый список.
        all_tracks = service.edits().tracks().list(
            packageName=args.package, editId=edit_id,
        ).execute().get("tracks", [])
        before_by_track = {t.get("track"): t.get("releases", []) for t in all_tracks}

        sent_by_track = {}
        for track in tracks:
            before = before_by_track.get(track, [])
            track_release = release
            if find_release(before, version_codes) is None and not args.aab:
                if "releaseNotes" not in release:
                    found = find_notes_elsewhere(all_tracks, version_codes, track)
                    if found is not None:
                        track_release = dict(release, releaseNotes=found)
                        log(f"  release notes для v{version_codes} взяты из другого трека этого edit "
                            f"({', '.join(n['language'] for n in found)}).")
                    else:
                        log(f"  ⚠️  v{version_codes} нет ни в одном треке с notes — release notes "
                            f"только из флагов (не переданы).")
                else:
                    log(f"  v{version_codes} нет в треке '{track}' — release notes только из флагов.")
            releases = merge_track_releases(before, track_release)
            sent_by_track[track] = releases[0]
            log(f"Назначение в трек '{track}' (status={args.status}, releases в треке: "
                f"{', '.join(r.get('status', '?') + ' ' + ','.join(r.get('versionCodes', [])) for r in releases)})")
            service.edits().tracks().update(
                packageName=args.package, editId=edit_id, track=track,
                body={"releases": releases},
            ).execute()

        # Within-edit read-back gate: без него ошибка слияния уходит в прод молча.
        gate_errors = []
        for track in tracks:
            after = service.edits().tracks().get(
                packageName=args.package, editId=edit_id, track=track,
            ).execute().get("releases", [])
            gate_errors += [f"трек '{track}': {e}"
                            for e in check_gate(before_by_track.get(track, []), after, sent_by_track[track])]
        if gate_errors:
            service.edits().delete(packageName=args.package, editId=edit_id).execute()
            sys.exit("Read-back gate не пройден, edit удалён, ничего не опубликовано:\n  "
                     + "\n  ".join(gate_errors))
        log("Read-back gate пройден.")

        if args.mapping:
            log(f"Загрузка mapping.txt (deobfuscation) для versionCode={version_codes[0]}")
            service.edits().deobfuscationfiles().upload(
                packageName=args.package, editId=edit_id,
                apkVersionCode=version_codes[0], deobfuscationFileType="proguard",
                media_body=MediaFileUpload(args.mapping, mimetype="application/octet-stream"),
            ).execute()

        if args.dry_run:
            for track, sent in sent_by_track.items():
                log(f"DRY-RUN: '{track}' release = {json.dumps(sent, ensure_ascii=False)}")
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
