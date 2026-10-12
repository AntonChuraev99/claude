#!/usr/bin/env python3
"""Pure-logic tests for play_stats.py: CSV parsing and aggregation. No network, no Google libs.

Run: python test_play_stats.py
"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import play_stats as ps  # noqa: E402


def test_installs_sum_flows_keep_latest_state() -> None:
    raw = ("Date,Package Name,Country,Daily Device Installs,Daily User Uninstalls,Installs on active devices\n"
           "2026-09-01,com.x,US,10,1,100\n2026-09-02,com.x,US,5,2,103\n"
           "2026-09-01,com.x,DE,3,0,40\n2026-09-02,com.x,DE,4,1,42\n").encode("utf-16")
    rows = ps.parse_csv(raw)
    date_col, dims, numeric = ps.split_columns(rows)
    assert date_col == "Date" and dims == ["Country"], (date_col, dims)
    agg = ps.aggregate(rows, date_col, dims, numeric)
    assert agg[("US",)]["Daily Device Installs"] == 15
    assert agg[("US",)]["Daily User Uninstalls"] == 3
    assert agg[("US",)]["Installs on active devices"] == 103
    assert agg[("DE",)]["Installs on active devices"] == 42


def test_acquisition_recomputes_conversion() -> None:
    raw = ("Date,Package name,Traffic source,Search term,Store listing acquisitions,Store listing visitors,"
           "Store listing conversion rate\n"
           "2026-09-01,com.x,Google Play search,timer,10,100,10%\n"
           "2026-09-02,com.x,Google Play search,timer,30,100,30%\n").encode("utf-16")
    rows = ps.parse_csv(raw)
    date_col, dims, numeric = ps.split_columns(rows)
    assert dims == ["Traffic source", "Search term"], dims
    acc = ps.aggregate(rows, date_col, dims, numeric)[("Google Play search", "timer")]
    assert acc["Store listing acquisitions"] == 40 and acc["Store listing visitors"] == 200
    assert abs(acc["Conversion rate (acq/visitors) %"] - 20.0) < 1e-9
    assert "Store listing conversion rate" not in acc
    daily = ps.aggregate(rows, date_col, [date_col], numeric)
    assert daily[("2026-09-02",)]["Store listing acquisitions"] == 30


def test_daily_average_rating_is_mean_of_rated_days() -> None:
    raw = ("Date,Package Name,Daily Average Rating,Total Average Rating,Install events\n"
           "2026-09-01,com.x,4,4.5,2\n2026-09-02,com.x,0,4.5,3\n2026-09-03,com.x,2,4.4,1\n").encode("utf-16")
    rows = ps.parse_csv(raw)
    date_col, dims, numeric = ps.split_columns(rows)
    acc = ps.aggregate(rows, date_col, dims, numeric)[()]
    assert acc["Daily Average Rating"] == 3.0, acc
    assert acc["Total Average Rating"] == 4.4
    assert acc["Install events"] == 6
    assert ps.aggregate(rows[1:2], date_col, dims, numeric)[()]["Daily Average Rating"] == 0.0


def test_numeric_dimension_stays_dimension() -> None:
    raw = ("Date,Package Name,App Version Code,Daily Device Installs\n"
           "2026-09-01,com.x,120,5\n2026-09-01,com.x,121,7\n2026-09-02,com.x,121,3\n").encode("utf-16")
    rows = ps.parse_csv(raw)
    date_col, dims, numeric = ps.split_columns(rows)
    assert dims == ["App Version Code"], dims
    agg = ps.aggregate(rows, date_col, dims, numeric)
    assert agg[("121",)]["Daily Device Installs"] == 10 and agg[("120",)]["Daily Device Installs"] == 5


def test_daily_sums_state_across_dimension_values() -> None:
    raw = ("Date,Package Name,Country,Daily Device Installs,Installs on active devices,Total Average Rating\n"
           "2026-09-01,com.x,US,10,100,4.0\n2026-09-01,com.x,DE,3,40,5.0\n").encode("utf-16")
    rows = ps.parse_csv(raw)
    date_col, dims, numeric = ps.split_columns(rows)
    day = ps.aggregate_daily(rows, date_col, numeric)[("2026-09-01",)]
    assert day["Daily Device Installs"] == 13
    assert day["Installs on active devices"] == 140, day  # sum over countries, not the last row
    assert "Total Average Rating" not in day  # averages cannot be summed across countries


def test_month_keys_and_utf8_fallback() -> None:
    assert ps.month_keys(3, date(2026, 2, 10)) == ["202512", "202601", "202602"]
    assert ps.parse_csv("Date,X\n2026-01-01,1\n".encode("utf-8-sig"))[0]["X"] == "1"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"OK: {len(tests)} tests")
