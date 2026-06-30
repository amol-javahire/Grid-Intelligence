"""
seed-ercot-real-data.py

Replaces synthetic data in ercot_load_by_zone and ercot_fuel_mix with
REAL hourly data from EIA-930 (Hourly Electric Grid Monitor).

Sources:
  Zone load:      EIA-930 /v2/electricity/rto/region-sub-ba-data/data/
                  (parent=ERCO) → 8 sub-BAs: COAS EAST FWES NCEN NRTH SCEN SOUT WEST
  Generation mix: EIA-930 /v2/electricity/rto/fuel-type-data/data/
                  (respondent=ERCO) → COL NG NUC OTH SUN WAT WND [BAT]

Coverage: Jan 2024 – Jun 2026  (~30 months, ~130k load rows + ~100k fuel rows)

Run:
  cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-ercot-real-data.py
"""

import os
import sys
import time
import psycopg2
import psycopg2.extras
import requests
from datetime import date, timedelta

EIA_KEY = os.environ.get("EIA_API_KEY")
if not EIA_KEY:
    sys.exit("EIA_API_KEY not set")

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    sys.exit("DATABASE_URL not set")

START_YEAR, START_MONTH = 2024, 1
END_YEAR,   END_MONTH   = 2026, 6

FUEL_MAP = {
    "COL": "coal",
    "NG":  "natural_gas",
    "NUC": "nuclear",
    "OTH": "other",
    "SUN": "solar",
    "WAT": "hydro",
    "WND": "wind",
    "BAT": "storage",
}

EIA_BASE = "https://api.eia.gov/v2/electricity/rto"


def eia_fetch_all(endpoint: str, extra_params: dict) -> list:
    """Fetch every page from an EIA v2 hourly endpoint."""
    url = f"{EIA_BASE}/{endpoint}/data/"
    params = {
        "api_key": EIA_KEY,
        "frequency": "hourly",
        "length": 5000,
        **extra_params,
    }
    rows: list = []
    offset = 0
    while True:
        params["offset"] = offset
        resp = requests.get(url, params=params, timeout=60)
        if resp.status_code == 429:
            print("  [rate-limit] sleeping 30s …", flush=True)
            time.sleep(30)
            continue
        if resp.status_code != 200:
            print(f"  EIA {resp.status_code}: {resp.text[:200]}", flush=True)
            break
        body = resp.json().get("response", {})
        batch = body.get("data", [])
        rows.extend(batch)
        total = int(body.get("total", len(rows)))
        if len(rows) >= total or not batch:
            break
        offset += 5000
        time.sleep(0.3)
    return rows


def month_window(year: int, month: int):
    """Return (start_iso, end_iso) covering every hour in the month."""
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        end = date(year, month + 1, 1) - timedelta(days=1)
    return start.isoformat(), end.isoformat()


def parse_period(period: str):
    """'2024-01-15T14' → (2024, 1, 15, 14)"""
    date_part, h = period.split("T")
    y, m, d = map(int, date_part.split("-"))
    return y, m, d, int(h)


def main():
    conn = psycopg2.connect(DB_URL)
    cur  = conn.cursor()

    print("Truncating existing data …")
    cur.execute(
        "TRUNCATE TABLE ercot_load_by_zone, ercot_fuel_mix RESTART IDENTITY CASCADE"
    )
    conn.commit()
    print("Truncated.\n")

    total_load = 0
    total_fuel = 0

    year, month = START_YEAR, START_MONTH
    while (year, month) <= (END_YEAR, END_MONTH):
        start_d, end_d = month_window(year, month)
        label = f"{year}-{month:02d}"
        print(f"  {label} …", end=" ", flush=True)

        # ── Zone load ──────────────────────────────────────────────────────
        load_rows = eia_fetch_all(
            "region-sub-ba-data",
            {
                "data[0]": "value",
                "facets[parent][]": "ERCO",
                "start": f"{start_d}T00",
                "end":   f"{end_d}T23",
            },
        )
        load_insert = []
        for row in load_rows:
            subba = row.get("subba", "")
            if subba not in ("COAS", "EAST", "FWES", "NCEN", "NRTH", "SCEN", "SOUT", "WEST"):
                continue
            val = row.get("value")
            if val is None:
                continue
            try:
                y, m, d, h = parse_period(row["period"])
                load_insert.append((y, m, d, h, subba, float(val)))
            except (ValueError, KeyError):
                continue

        if load_insert:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO ercot_load_by_zone (year, month, day, hour, zone, load_mw)
                VALUES %s
                ON CONFLICT DO NOTHING
                """,
                load_insert,
                template="(%s,%s,%s,%s,%s,%s)",
                page_size=2000,
            )
            total_load += len(load_insert)

        # ── Fuel mix ───────────────────────────────────────────────────────
        fuel_rows = eia_fetch_all(
            "fuel-type-data",
            {
                "data[0]": "value",
                "facets[respondent][]": "ERCO",
                "start": f"{start_d}T00",
                "end":   f"{end_d}T23",
            },
        )
        fuel_insert = []
        for row in fuel_rows:
            ft = FUEL_MAP.get(row.get("fueltype", ""))
            if not ft:
                continue
            val = row.get("value")
            if val is None:
                continue
            try:
                y, m, d, h = parse_period(row["period"])
                fuel_insert.append((y, m, d, h, ft, float(val)))
            except (ValueError, KeyError):
                continue

        if fuel_insert:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO ercot_fuel_mix (year, month, day, hour, fuel_type, gen_mw)
                VALUES %s
                ON CONFLICT DO NOTHING
                """,
                fuel_insert,
                template="(%s,%s,%s,%s,%s,%s)",
                page_size=2000,
            )
            total_fuel += len(fuel_insert)

        conn.commit()
        print(f"load={len(load_insert):5,}  fuel={len(fuel_insert):5,}")

        # Advance month
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1

        time.sleep(0.5)

    cur.close()
    conn.close()

    print(f"\nDone!")
    print(f"  ercot_load_by_zone : {total_load:,} rows")
    print(f"  ercot_fuel_mix     : {total_fuel:,} rows")


if __name__ == "__main__":
    main()
