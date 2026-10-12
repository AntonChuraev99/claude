#!/usr/bin/env python3
"""Store statistics from Google Play Console: installs, ratings, acquisition, subscriptions, reviews.

Official sources only:
  - Cloud Storage bulk reports in the developer bucket (Play Console -> Download reports ->
    Copy Cloud Storage URI). The name is pubsite_prod_<devId> or pubsite_prod_rev_<id> depending
    on the account: take it from the URI, do not build it. Monthly CSV, UTF-16, data lands with
    a 3-7 day lag; store_performance for a month is finalized around the 12th of the next one.
  - Play Developer API v3 reviews.list for the freshest reviews (short window, text reviews).
Auth: service account JSON invited to Play Console with "View app information and download
bulk reports" (GCS) and "View app information" (reviews API). The bucket is Google-managed:
on some developer accounts the SA key gets 403 there. Then download with
`gcloud storage cp` as the owner account and parse the files with --local-dir.

Usage:
  python play_stats.py --package com.example.app --bucket pubsite_prod_123 --list
  python play_stats.py --package com.example.app --bucket pubsite_prod_123 --report installs --dimension country
  python play_stats.py --package com.example.app --bucket pubsite_prod_123 --report acquisition --dimension traffic_source --months 3
  python play_stats.py --package com.example.app --bucket pubsite_prod_123 --report ratings --daily
  python play_stats.py --package com.example.app --bucket pubsite_prod_123 --report reviews --top 30
  python play_stats.py --package com.example.app --report reviews-api
  python play_stats.py --package com.example.app --local-dir ./play-csv --report installs --dimension country

Report -> GCS path:
  installs      stats/installs/installs_<pkg>_YYYYMM_<dimension>.csv
                dimensions: overview, app_version, carrier, country, device, language, os_version
  ratings       stats/ratings/ratings_<pkg>_YYYYMM_<dimension>.csv (same dimensions)
  crashes       stats/crashes/crashes_<pkg>_YYYYMM_<dimension>.csv (overview, app_version, device, os_version)
  acquisition   stats/store_performance/store_performance_<pkg>_YYYYMM_<country|traffic_source>.csv
  subscriptions financial-stats/subscriptions/subscriptions_<pkg>_<productId>_YYYYMM_country.csv
  reviews       reviews/reviews_<pkg>_YYYYMM.csv
Earnings and sales (earnings/, sales/) are zip archives without a package filter: download them
with `gcloud storage cp` — this script does not parse them.
"""

import argparse
import csv
import io
import json
import os
import re
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import quote

# Windows consoles default to legacy codepages (cp1251/cp866) and choke on unicode output.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

GCS = "https://storage.googleapis.com/storage/v1"
PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3"
SCOPES = [
    "https://www.googleapis.com/auth/devstorage.read_only",
    "https://www.googleapis.com/auth/androidpublisher",
]

REPORT_PREFIX = {
    "installs": "stats/installs/installs_{pkg}_",
    "ratings": "stats/ratings/ratings_{pkg}_",
    "crashes": "stats/crashes/crashes_{pkg}_",
    "acquisition": "stats/store_performance/store_performance_{pkg}_",
    "subscriptions": "financial-stats/subscriptions/subscriptions_{pkg}_",
    "reviews": "reviews/reviews_{pkg}_",
}
DEFAULT_DIMENSION = {"acquisition": "country", "subscriptions": "country"}

# Columns summed over the window. "Daily Average Rating" is a mean over days that had ratings
# (0 = no ratings that day). Every other numeric column shows its latest value
# (state metrics such as "Active Device Installs", "Total Average Rating").
SUM_MARKERS = ("daily ", "events", "acquisitions", "visitors", "new subscriptions", "canceled subscriptions")


# Dimension columns whose values are numbers ("App Version Code", "Android OS Version"):
# without this they would be taken for metrics and the breakdown would collapse into one row.
# Whole word: "conversion rate" must stay a metric.
NUMERIC_DIMENSION = re.compile(r"\bversion\b", re.IGNORECASE)


def is_mean_col(col: str) -> bool:
    return "daily average" in col.lower()


def build_session(sa_path: str):
    # Imported lazily: --local-dir parsing works without Google libraries installed.
    try:
        import google.auth.transport.requests
        from google.oauth2 import service_account
    except ImportError:
        sys.exit("Missing deps. Run: pip install -r requirements.txt")
    # No quota-project header: with x-goog-user-project the SA gets 403 serviceusage on the
    # Google-managed bucket, without it the SA bills its own project.
    creds = service_account.Credentials.from_service_account_file(sa_path, scopes=SCOPES)
    return google.auth.transport.requests.AuthorizedSession(creds)


def explain_http_error(resp) -> str:
    try:
        err = resp.json().get("error", {})
    except Exception:
        return resp.text[:500]
    code, msg = err.get("code", resp.status_code), err.get("message", "")
    if code in (401, 403):
        return (f"{code}: {msg}\nHint: SA не приглашён в Play Console или у него нет права "
                "'View app information and download bulk reports' (GCS) / доступа к отзывам; "
                "права пропагируются до 24-48 ч. На части аккаунтов бакет закрыт для SA совсем — "
                "скачай CSV `gcloud storage cp` под аккаунтом владельца и запусти с --local-dir.")
    if code == 404:
        return (f"{code}: {msg}\nHint: имя бакета бывает pubsite_prod_<devId> и pubsite_prod_rev_<id> — "
                "возьми его из Play Console → Download reports → Copy Cloud Storage URI; проверь --package.")
    return f"{code}: {msg}"


def month_keys(count: int, today: date | None = None) -> list[str]:
    """Last `count` months as YYYYMM, oldest first, current month included."""
    today = today or date.today()
    y, m, keys = today.year, today.month, []
    for _ in range(count):
        keys.append(f"{y}{m:02d}")
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return list(reversed(keys))


def list_objects(session, bucket: str, prefix: str) -> list[str]:
    names, token = [], None
    while True:
        params = {"prefix": prefix, "fields": "items(name),nextPageToken"}
        if token:
            params["pageToken"] = token
        resp = session.get(f"{GCS}/b/{bucket}/o", params=params)
        if resp.status_code != 200:
            sys.exit(f"GCS list {prefix} failed:\n{explain_http_error(resp)}")
        data = resp.json()
        names.extend(item["name"] for item in data.get("items", []))
        token = data.get("nextPageToken")
        if not token:
            return names


def download_csv(session, bucket: str, name: str) -> list[dict]:
    resp = session.get(f"{GCS}/b/{bucket}/o/{quote(name, safe='')}", params={"alt": "media"})
    if resp.status_code != 200:
        sys.exit(f"GCS download {name} failed:\n{explain_http_error(resp)}")
    return parse_csv(resp.content)


def parse_csv(raw: bytes) -> list[dict]:
    # Play bulk reports are UTF-16 with BOM; fall back to UTF-8 for re-saved files.
    for enc in ("utf-16", "utf-8-sig"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        sys.exit("CSV is neither UTF-16 nor UTF-8")
    return [{k.strip(): (v or "").strip() for k, v in row.items() if k}
            for row in csv.DictReader(io.StringIO(text))]


def to_number(value: str) -> float | None:
    v = value.replace(",", "").replace("%", "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def find_col(columns: list[str], *needles: str) -> str | None:
    for col in columns:
        low = col.lower()
        if all(n in low for n in needles):
            return col
    return None


def split_columns(rows: list[dict]) -> tuple[str, list[str], list[str]]:
    """Return (date column, dimension columns, numeric columns)."""
    columns = list(rows[0].keys())
    date_col = find_col(columns, "date") or columns[0]
    numeric, dims = [], []
    for col in columns:
        if col == date_col or col.lower().startswith("package"):
            continue
        values = [r[col] for r in rows if r[col]]
        if NUMERIC_DIMENSION.search(col):
            dims.append(col)
        elif values and all(to_number(v) is not None for v in values):
            numeric.append(col)
        else:
            dims.append(col)
    return date_col, dims, numeric


def is_sum_col(col: str) -> bool:
    low = col.lower()
    return not is_mean_col(col) and any(m in low for m in SUM_MARKERS)


def aggregate(rows: list[dict], date_col: str, key_cols: list[str], numeric: list[str]) -> dict:
    """Sum flow metrics and keep the latest value of state metrics per key."""
    out: dict[tuple, dict] = {}
    for row in sorted(rows, key=lambda r: r[date_col]):
        key = tuple(row[c] for c in key_cols)
        acc = out.setdefault(key, {"_days": set(), "_mean": {}})
        acc["_days"].add(row[date_col])
        for col in numeric:
            if "conversion rate" in col.lower():
                continue  # recomputed from acquisitions / visitors
            num = to_number(row[col])
            if num is None:
                continue
            if is_mean_col(col):
                if num:
                    total, count = acc["_mean"].get(col, (0.0, 0))
                    acc["_mean"][col] = (total + num, count + 1)
                acc.setdefault(col, 0.0)
            else:
                acc[col] = acc.get(col, 0.0) + num if is_sum_col(col) else num
    for acc in out.values():
        for col, (total, count) in acc.pop("_mean").items():
            acc[col] = total / count
        acq = next((v for k, v in acc.items() if "acquisitions" in str(k).lower()), None)
        vis = next((v for k, v in acc.items() if "visitors" in str(k).lower()), None)
        if acq is not None and vis:
            acc["Conversion rate (acq/visitors) %"] = acq / vis * 100
    return out


def aggregate_daily(rows: list[dict], date_col: str, numeric: list[str]) -> dict:
    """Per-date totals across all dimension values of the file.

    Every count, flow or state, is summed over the rows of a day (US 100 + DE 40 active
    devices = 140). Averages cannot be summed: they are kept only when a day has one row
    (the overview file) and dropped otherwise.
    """
    by_date: dict[str, list[dict]] = {}
    for row in rows:
        by_date.setdefault(row[date_col], []).append(row)
    out: dict[tuple, dict] = {}
    for day, day_rows in by_date.items():
        acc: dict = {"_days": {day}}
        for col in numeric:
            low = col.lower()
            if "conversion rate" in low or ("average" in low and len(day_rows) > 1):
                continue
            nums = [n for n in (to_number(r[col]) for r in day_rows) if n is not None]
            if nums:
                acc[col] = sum(nums)
        acq = next((v for k, v in acc.items() if "acquisitions" in str(k).lower()), None)
        vis = next((v for k, v in acc.items() if "visitors" in str(k).lower()), None)
        if acq is not None and vis:
            acc["Conversion rate (acq/visitors) %"] = acq / vis * 100
        out[(day,)] = acc
    return out


def fmt(v) -> str:
    if isinstance(v, float):
        return f"{v:,.2f}" if abs(v) < 100 and v != int(v) else f"{v:,.0f}"
    return str(v)


def print_table(title: str, agg: dict, key_cols: list[str], top: int, by_date: bool = False) -> None:
    metrics = []
    for acc in agg.values():
        metrics.extend(k for k in acc if k != "_days" and k not in metrics)
    print(f"\n=== {title} ===")
    print("(сумма за окно: Daily*/events/acquisitions/visitors/new/canceled; Daily Average — среднее по дням "
          "с оценками; остальное — последнее значение окна)")
    if by_date:
        # Timeline: the most recent `top` days, oldest first.
        items = sorted(agg.items())[-top:]
        skipped = len(agg) - len(items)
    else:
        sort_col = next((m for m in metrics if is_sum_col(m)), metrics[0] if metrics else None)
        items = sorted(agg.items(), key=lambda kv: -(kv[1].get(sort_col) or 0))
        print(f"(сортировка по '{sort_col}')")
        skipped = max(len(items) - top, 0)
        items = items[:top]
    print(" | ".join(key_cols + metrics))
    for key, acc in items:
        print(" | ".join(list(key) + [fmt(acc.get(m, "")) for m in metrics]))
    if skipped:
        print(f"... ещё {skipped} строк (--top)")


def source_names(session, args, prefix: str) -> list[str]:
    """Report files: from --local-dir (files saved by `gcloud storage cp`) or from the bucket."""
    if args.local_dir:
        base = prefix.rsplit("/", 1)[-1]
        return sorted(str(p) for p in Path(args.local_dir).rglob(f"{base}*.csv"))
    return list_objects(session, args.bucket, prefix)


def read_rows(session, args, name: str) -> list[dict]:
    if args.local_dir:
        return parse_csv(Path(name).read_bytes())
    return download_csv(session, args.bucket, name)


def run_report(session, args) -> None:
    dimension = args.dimension or DEFAULT_DIMENSION.get(args.report, "overview")
    prefix = REPORT_PREFIX[args.report].format(pkg=args.package)
    months = month_keys(args.months)
    names = source_names(session, args, prefix)
    if args.report == "reviews":
        wanted = [n for n in names if any(n.endswith(f"_{m}.csv") for m in months)]
    else:
        wanted = [n for n in names if any(f"_{m}_{dimension}.csv" in n for m in months)]
    if not wanted:
        found = sorted({n.rsplit("_", 1)[-1] for n in names})
        sys.exit(f"Нет файлов {prefix}*{{{','.join(months)}}}* для dimension '{dimension}'.\n"
                 f"Есть суффиксы: {', '.join(found) or 'ничего — проверь --package и права SA'}")

    rows = []
    for name in sorted(wanted):
        rows.extend(read_rows(session, args, name))
    print(f"Package: {args.package}\nFiles:   " + "\n         ".join(sorted(wanted)))
    if not rows:
        sys.exit("Файлы пустые.")

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if args.report == "reviews":
        print_reviews_csv(rows, args.top)
        return

    date_col, dims, numeric = split_columns(rows)
    dates = sorted({r[date_col] for r in rows})
    print(f"Window:  {dates[0]} .. {dates[-1]} ({len(dates)} дней с данными; GCS отстаёт на 3-7 дней)")
    if args.daily:
        print_table(f"{args.report} по дням (все значения {dimension} суммированы; средние — только в overview)",
                    aggregate_daily(rows, date_col, numeric), [date_col], args.top, by_date=True)
    else:
        print_table(f"{args.report} by {dimension}", aggregate(rows, date_col, dims, numeric), dims, args.top)


def print_reviews_csv(rows: list[dict], top: int) -> None:
    cols = list(rows[0].keys())
    c_date = find_col(cols, "review submit date") or find_col(cols, "date")
    c_star = find_col(cols, "star rating")
    c_text = find_col(cols, "review text")
    c_lang = find_col(cols, "reviewer language")
    c_ver = find_col(cols, "app version code")
    c_reply = find_col(cols, "developer reply text")
    stars = Counter(r.get(c_star, "?") for r in rows)
    with_text = [r for r in rows if c_text and r.get(c_text)]
    replied = sum(1 for r in rows if c_reply and r.get(c_reply))
    print(f"\n=== Reviews: {len(rows)} оценок, {len(with_text)} с текстом, {replied} с ответом ===")
    print("Распределение звёзд: " + ", ".join(f"{k}★={v}" for k, v in sorted(stars.items())))
    print(f"\nПоследние {min(top, len(with_text))} с текстом:")
    for r in sorted(with_text, key=lambda r: r.get(c_date, ""), reverse=True)[:top]:
        print(f"- {r.get(c_date, '?')} {r.get(c_star, '?')}★ v{r.get(c_ver, '?')} "
              f"[{r.get(c_lang, '?')}] {r[c_text][:300]}")


def run_reviews_api(session, args) -> None:
    reviews, token = [], None
    while len(reviews) < args.top:
        params = {"maxResults": 100}
        if token:
            params["token"] = token
        resp = session.get(f"{PUBLISHER}/applications/{args.package}/reviews", params=params)
        if resp.status_code != 200:
            sys.exit(f"reviews.list failed:\n{explain_http_error(resp)}")
        data = resp.json()
        reviews.extend(data.get("reviews", []))
        token = (data.get("tokenPagination") or {}).get("nextPageToken")
        if not token:
            break
    if args.json:
        print(json.dumps(reviews[:args.top], ensure_ascii=False, indent=2))
        return
    print(f"Package: {args.package}\n=== reviews.list: {len(reviews)} отзывов "
          f"(короткое окно свежих отзывов с текстом; история — --report reviews из GCS) ===")
    for rev in reviews[:args.top]:
        user = next((c["userComment"] for c in rev.get("comments", []) if "userComment" in c), {})
        reply = next((c["developerComment"] for c in rev.get("comments", []) if "developerComment" in c), None)
        ts = user.get("lastModified", {}).get("seconds")
        when = datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d") if ts else "?"
        print(f"- {when} {user.get('starRating', '?')}★ v{user.get('appVersionName', '?')} "
              f"[{user.get('reviewerLanguage', '?')}] {user.get('device', '')}"
              f"{' (есть ответ)' if reply else ''}\n  {(user.get('text') or '').strip()[:300]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--package", required=True, help="applicationId")
    ap.add_argument("--service-account", default=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"),
                    help="path to SA JSON (or env GOOGLE_APPLICATION_CREDENTIALS)")
    ap.add_argument("--bucket", help="имя бакета из Copy Cloud Storage URI (gs:// можно оставить)")
    ap.add_argument("--local-dir", help="папка с CSV, скачанными `gcloud storage cp` — вместо --bucket")
    ap.add_argument("--report", choices=sorted(REPORT_PREFIX) + ["reviews-api"], help="что выгрузить")
    ap.add_argument("--dimension", help="суффикс файла: overview, country, app_version, device, "
                                        "language, os_version, carrier, traffic_source")
    ap.add_argument("--months", type=int, default=2, help="сколько последних месяцев, default 2")
    ap.add_argument("--daily", action="store_true", help="timeline по дням вместо разбивки по dimension")
    ap.add_argument("--top", type=int, default=20, help="сколько строк вывести, default 20")
    ap.add_argument("--list", action="store_true", help="перечислить файлы пакета в бакете")
    ap.add_argument("--json", action="store_true", help="сырые строки JSON вместо таблиц")
    args = ap.parse_args()

    if not args.list and not args.report:
        sys.exit("Нужен --report или --list")
    needs_api = args.report == "reviews-api" or not args.local_dir
    if (args.list or args.report != "reviews-api") and not (args.bucket or args.local_dir):
        sys.exit("Нужен --bucket (Play Console → Download reports → Copy Cloud Storage URI) или --local-dir")
    if needs_api and not args.service_account:
        sys.exit("No credentials: pass --service-account or set GOOGLE_APPLICATION_CREDENTIALS")
    if args.bucket:
        args.bucket = args.bucket.removeprefix("gs://").strip("/")

    session = build_session(args.service_account) if needs_api else None
    if args.list:
        for prefix in REPORT_PREFIX.values():
            for name in source_names(session, args, prefix.format(pkg=args.package)):
                print(name)
    elif args.report == "reviews-api":
        run_reviews_api(session, args)
    else:
        run_report(session, args)


if __name__ == "__main__":
    main()
