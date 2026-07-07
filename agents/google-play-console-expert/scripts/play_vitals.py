#!/usr/bin/env python3
"""Fetch crash/ANR vitals and top error issues from Google Play Developer Reporting API.

Official API only (playdeveloperreporting.googleapis.com, v1beta1).
Auth: service account JSON with Play Console access ("View app information" is enough).

Usage:
  python play_vitals.py --package com.example.app --service-account ~/secrets/play-sa.json
  python play_vitals.py --package com.example.app --days 28 --by-version --issues 15

Outputs (stdout, human-readable):
  - daily crashRate / userPerceivedCrashRate / distinctUsers timeline
  - daily anrRate / userPerceivedAnrRate / distinctUsers timeline
  - optional breakdown by versionCode (last N days aggregated)
  - optional top error issues (clusters) by report count

Bad behaviour thresholds (Google Play visibility penalties):
  user-perceived crash rate  >= 1.09%
  user-perceived ANR rate    >= 0.47%
"""

import argparse
import json
import os
import sys
from datetime import date, timedelta

try:
    import google.auth.transport.requests
    from google.oauth2 import service_account
except ImportError:
    sys.exit("Missing deps. Run: pip install -r requirements.txt")

# Windows consoles default to legacy codepages (cp1251/cp866) and choke on unicode output.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = "https://playdeveloperreporting.googleapis.com/v1beta1"
SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting"
# Play aggregates DAILY metric sets in America/Los_Angeles; other zones are rejected.
DAILY_TZ = "America/Los_Angeles"

CRASH_THRESHOLD = 1.09  # % userPerceivedCrashRate
ANR_THRESHOLD = 0.47    # % userPerceivedAnrRate


def build_session(sa_path: str):
    creds = service_account.Credentials.from_service_account_file(sa_path, scopes=[SCOPE])
    return google.auth.transport.requests.AuthorizedSession(creds)


def explain_http_error(resp) -> str:
    try:
        err = resp.json().get("error", {})
    except Exception:
        return resp.text[:500]
    status, msg = err.get("status", ""), err.get("message", "")
    hints = {
        "PERMISSION_DENIED": "SA не приглашён в Play Console (Users & permissions → Invite, "
                             "право 'View app information') ИЛИ права ещё пропагируются (до 24-48ч).",
        "NOT_FOUND": "Проверь --package; SA видит только приложения, к которым выдан доступ.",
    }
    if "SERVICE_DISABLED" in msg or "has not been used" in msg:
        return (f"{msg}\nHint: включи API в GCP-проекте SA: "
                "gcloud services enable playdeveloperreporting.googleapis.com --project <SA_PROJECT>")
    return f"{status}: {msg}" + ("\nHint: " + hints[status] if status in hints else "")


def dt_obj(d: date, tz: str = DAILY_TZ) -> dict:
    return {"year": d.year, "month": d.month, "day": d.day, "timeZone": {"id": tz}}


def get_freshness_end(session, package: str, metric_set: str) -> date:
    """Latest DAILY date the metric set has data for (API rejects ranges beyond it)."""
    resp = session.get(f"{BASE}/apps/{package}/{metric_set}")
    if resp.status_code != 200:
        sys.exit(f"GET {metric_set} failed ({resp.status_code}):\n{explain_http_error(resp)}")
    for f in resp.json().get("freshnessInfo", {}).get("freshnesses", []):
        if f.get("aggregationPeriod") == "DAILY":
            t = f["latestEndTime"]
            return date(t["year"], t["month"], t["day"])
    sys.exit(f"{metric_set}: no DAILY freshness info")


def query_metric_set(session, package: str, metric_set: str, metrics: list[str],
                     start: date, end: date, dimensions: list[str] | None = None) -> list[dict]:
    body = {
        "timelineSpec": {
            "aggregationPeriod": "DAILY",
            "startTime": dt_obj(start),
            "endTime": dt_obj(end),
        },
        "metrics": metrics,
        "pageSize": 1000,
    }
    if dimensions:
        body["dimensions"] = dimensions
    rows, page_token = [], None
    while True:
        if page_token:
            body["pageToken"] = page_token
        resp = session.post(f"{BASE}/apps/{package}/{metric_set}:query", json=body)
        if resp.status_code != 200:
            sys.exit(f"query {metric_set} failed ({resp.status_code}):\n{explain_http_error(resp)}")
        data = resp.json()
        rows.extend(data.get("rows", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            return rows


def metric_value(row: dict, name: str) -> float | None:
    for m in row.get("metrics", []):
        if m.get("metric") == name:
            v = m.get("decimalValue", {}).get("value")
            return float(v) if v is not None else None
    return None


def row_date(row: dict) -> str:
    t = row.get("startTime", {})
    return f"{t.get('year')}-{t.get('month'):02d}-{t.get('day'):02d}"


def row_dimension(row: dict, dim: str) -> str:
    for d in row.get("dimensions", []):
        if d.get("dimension") == dim:
            return d.get("stringValue") or d.get("int64Value") or "?"
    return "?"


def print_timeline(title: str, rows: list[dict], rate_metric: str, perceived_metric: str,
                   threshold: float) -> None:
    print(f"\n=== {title} (DAILY) ===")
    print(f"{'date':<12}{'rate %':>9}{'user-perceived %':>19}{'distinct users':>16}")
    for row in sorted(rows, key=row_date):
        rate = metric_value(row, rate_metric)
        perceived = metric_value(row, perceived_metric)
        users = metric_value(row, "distinctUsers")
        flag = "  ⚠ OVER THRESHOLD" if perceived is not None and perceived * 100 >= threshold else ""
        print(f"{row_date(row):<12}"
              f"{(rate * 100 if rate is not None else float('nan')):>9.3f}"
              f"{(perceived * 100 if perceived is not None else float('nan')):>19.3f}"
              f"{(f'{users:,.0f}' if users is not None else '?'):>16}{flag}")
    print(f"(bad behaviour threshold: user-perceived >= {threshold}%)")


def print_by_version(title: str, rows: list[dict], rate_metric: str) -> None:
    # Aggregate: average rate per versionCode over the queried days, weighted by distinctUsers.
    agg: dict[str, dict] = {}
    for row in rows:
        ver = row_dimension(row, "versionCode")
        rate, users = metric_value(row, rate_metric), metric_value(row, "distinctUsers") or 0
        if rate is None:
            continue
        a = agg.setdefault(ver, {"rate_x_users": 0.0, "users": 0.0})
        a["rate_x_users"] += rate * users
        a["users"] += users
    print(f"\n=== {title} by versionCode (user-weighted avg) ===")
    print(f"{'versionCode':<14}{'rate %':>9}{'distinct users (sum of days)':>30}")
    for ver, a in sorted(agg.items(), key=lambda kv: -kv[1]["users"]):
        if a["users"] == 0:
            continue
        print(f"{ver:<14}{a['rate_x_users'] / a['users'] * 100:>9.3f}{a['users']:>30,.0f}")


def search_error_issues(session, package: str, start: date, end: date, limit: int) -> list[dict]:
    # errorIssues:search is a GET with proto fields flattened into query params. UTC interval.
    params = {
        "interval.startTime.year": start.year,
        "interval.startTime.month": start.month,
        "interval.startTime.day": start.day,
        "interval.startTime.timeZone.id": "UTC",
        "interval.endTime.year": end.year,
        "interval.endTime.month": end.month,
        "interval.endTime.day": end.day,
        "interval.endTime.timeZone.id": "UTC",
        "orderBy": "errorReportCount desc",
        "pageSize": limit,
    }
    resp = session.get(f"{BASE}/apps/{package}/errorIssues:search", params=params)
    if resp.status_code != 200:
        sys.exit(f"errorIssues:search failed ({resp.status_code}):\n{explain_http_error(resp)}")
    return resp.json().get("errorIssues", [])


def print_issues(issues: list[dict]) -> None:
    print(f"\n=== Top error issues (by report count) ===")
    for i, issue in enumerate(issues, 1):
        itype = issue.get("type", "?")
        cause = issue.get("cause", "?")
        location = issue.get("location", "?")
        reports = issue.get("errorReportCount", "?")
        users = issue.get("distinctUsers", "?")
        first = issue.get("firstAppVersion", {}).get("versionCode", "?")
        last = issue.get("lastAppVersion", {}).get("versionCode", "?")
        console_url = issue.get("issueUri", "")
        print(f"\n{i}. [{itype}] {cause}")
        print(f"   at: {location}")
        print(f"   reports: {reports}, distinct users: {users}, versions: {first}..{last}")
        if console_url:
            print(f"   console: {console_url}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--package", required=True, help="applicationId")
    ap.add_argument("--service-account",
                    default=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"),
                    help="path to SA JSON (or env GOOGLE_APPLICATION_CREDENTIALS)")
    ap.add_argument("--days", type=int, default=14, help="timeline window, default 14")
    ap.add_argument("--by-version", action="store_true", help="crash/ANR breakdown by versionCode")
    ap.add_argument("--issues", type=int, default=0, metavar="N", help="also print top-N error issues")
    ap.add_argument("--json", action="store_true", help="dump raw rows as JSON instead of tables")
    args = ap.parse_args()

    if not args.service_account:
        sys.exit("No credentials: pass --service-account or set GOOGLE_APPLICATION_CREDENTIALS")

    session = build_session(args.service_account)

    end = get_freshness_end(session, args.package, "crashRateMetricSet")
    start = end - timedelta(days=args.days - 1)

    crash_rows = query_metric_set(
        session, args.package, "crashRateMetricSet",
        ["crashRate", "userPerceivedCrashRate", "distinctUsers"], start, end)
    anr_rows = query_metric_set(
        session, args.package, "anrRateMetricSet",
        ["anrRate", "userPerceivedAnrRate", "distinctUsers"], start, end)

    if args.json:
        out = {"crash": crash_rows, "anr": anr_rows}

    print(f"Package: {args.package}")
    print(f"Window:  {start} .. {end} (DAILY, {DAILY_TZ})")
    print_timeline("Crash rate", crash_rows, "crashRate", "userPerceivedCrashRate", CRASH_THRESHOLD)
    print_timeline("ANR rate", anr_rows, "anrRate", "userPerceivedAnrRate", ANR_THRESHOLD)

    if args.by_version:
        ver_window = max(end - timedelta(days=6), start)
        crash_ver = query_metric_set(
            session, args.package, "crashRateMetricSet",
            ["crashRate", "distinctUsers"], ver_window, end, dimensions=["versionCode"])
        anr_ver = query_metric_set(
            session, args.package, "anrRateMetricSet",
            ["anrRate", "distinctUsers"], ver_window, end, dimensions=["versionCode"])
        print(f"\n(version breakdown window: {ver_window} .. {end})")
        print_by_version("Crash rate", crash_ver, "crashRate")
        print_by_version("ANR rate", anr_ver, "anrRate")
        if args.json:
            out.update({"crash_by_version": crash_ver, "anr_by_version": anr_ver})

    if args.issues:
        issues = search_error_issues(session, args.package, start, end, args.issues)
        print_issues(issues)
        if args.json:
            out["issues"] = issues

    if args.json:
        print("\n--- RAW JSON ---")
        print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
