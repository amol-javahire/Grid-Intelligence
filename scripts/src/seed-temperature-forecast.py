#!/usr/bin/env python3
"""
Seed temperature_forecasts table using climatological projection.

Method:
  - For each future day (Jul 2026 – Jun 2029), find all matching calendar days
    (same month + day-of-month) in the historical iso_hourly_temps table.
  - Compute the average of those days' daily mean / min / max.
  - Apply a +0.3°F/year climate warming trend from a 2025.5 reference baseline.

This matches the "average of same day over previous years" approach and works
reliably for all 11 zones from the existing historical data.

Zones with CMIP6 data already seeded (COAS, NCEN, SP15) are left intact.
The remaining 8 zones use this climatological method.

Run from project root:
  cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-temperature-forecast.py
"""

import os, psycopg2
from datetime import date, timedelta

DATABASE_URL = os.environ["DATABASE_URL"]

FORECAST_START = date(2026, 7,  1)
FORECAST_END   = date(2029, 6, 30)
WARMING_PER_YEAR = 0.3          # °F per year climate warming trend
REFERENCE_YEAR   = 2025.5       # mid-2025 = baseline (no trend adjustment)

ZONES = [
    ("ERCOT", "COAS"),
    ("ERCOT", "NCEN"),
    ("ERCOT", "NRTH"),
    ("ERCOT", "EAST"),
    ("ERCOT", "SCEN"),
    ("ERCOT", "SOUT"),
    ("ERCOT", "FWES"),
    ("ERCOT", "WEST"),
    ("CAISO", "NP15"),
    ("CAISO", "SP15"),
    ("CAISO", "ZP26"),
]


def build_historical_profiles(cur) -> dict:
    """
    Build a lookup: (iso, zone, month, day) → (mean_f, min_f, max_f)
    aggregated across all historical years in iso_hourly_temps.
    """
    print("  Loading historical hourly data...")
    cur.execute("""
        SELECT iso, zone, year, month, day,
               AVG(temp_f)::float AS mean_f,
               MIN(temp_f)::float AS min_f,
               MAX(temp_f)::float AS max_f
        FROM iso_hourly_temps
        GROUP BY iso, zone, year, month, day
        ORDER BY iso, zone, year, month, day
    """)
    rows = cur.fetchall()
    print(f"    {len(rows):,} zone-days loaded from history")

    # bucket by (iso, zone, month, day) — average across years
    from collections import defaultdict
    buckets: dict = defaultdict(lambda: {"means": [], "mins": [], "maxs": []})
    for iso, zone, yr, mo, dy, mean_f, min_f, max_f in rows:
        key = (iso, zone, int(mo), int(dy))
        buckets[key]["means"].append(float(mean_f))
        buckets[key]["mins"].append(float(min_f))
        buckets[key]["maxs"].append(float(max_f))

    profiles = {}
    for key, vals in buckets.items():
        n = len(vals["means"])
        profiles[key] = (
            round(sum(vals["means"]) / n, 2),
            round(sum(vals["mins"])  / n, 2),
            round(sum(vals["maxs"])  / n, 2),
        )
    return profiles


def already_seeded(cur) -> set:
    cur.execute("""
        SELECT zone FROM temperature_forecasts
        GROUP BY zone HAVING COUNT(*) >= 1090
    """)
    return {r[0] for r in cur.fetchall()}


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    # Ensure table exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS temperature_forecasts (
            id          SERIAL PRIMARY KEY,
            iso         VARCHAR(10) NOT NULL,
            zone        VARCHAR(20) NOT NULL,
            year        SMALLINT    NOT NULL,
            month       SMALLINT    NOT NULL,
            day         SMALLINT    NOT NULL,
            temp_mean_f REAL        NOT NULL,
            temp_min_f  REAL        NOT NULL,
            temp_max_f  REAL        NOT NULL,
            model       VARCHAR(50) NOT NULL DEFAULT 'climatology',
            CONSTRAINT temperature_forecasts_uniq UNIQUE (iso, zone, year, month, day)
        )
    """)
    conn.commit()

    done = already_seeded(cur)
    if done:
        print(f"  Already complete: {', '.join(sorted(done))}")

    profiles = build_historical_profiles(cur)

    total = 0
    for (iso, zone) in ZONES:
        if zone in done:
            print(f"  ✓ {iso}/{zone} — already seeded, skipping")
            continue

        print(f"  Projecting {iso}/{zone}...")
        rows = []
        d = FORECAST_START
        while d <= FORECAST_END:
            key = (iso, zone, d.month, d.day)

            if key not in profiles:
                # Leap day (Feb 29) fallback to Feb 28
                if d.month == 2 and d.day == 29:
                    key = (iso, zone, 2, 28)
                else:
                    d += timedelta(days=1)
                    continue

            mean_base, min_base, max_base = profiles[key]

            # Climate warming: +0.3°F per year from 2025.5 baseline
            years_ahead = (d.year + (d.month - 1) / 12) - REFERENCE_YEAR
            trend = round(years_ahead * WARMING_PER_YEAR, 2)

            rows.append((
                iso, zone,
                d.year, d.month, d.day,
                round(mean_base + trend, 2),
                round(min_base  + trend, 2),
                round(max_base  + trend, 2),
                "climatology_+0.3F/yr",
            ))
            d += timedelta(days=1)

        # Upsert
        cur.executemany("""
            INSERT INTO temperature_forecasts
              (iso, zone, year, month, day, temp_mean_f, temp_min_f, temp_max_f, model)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT ON CONSTRAINT temperature_forecasts_uniq DO UPDATE
              SET temp_mean_f = EXCLUDED.temp_mean_f,
                  temp_min_f  = EXCLUDED.temp_min_f,
                  temp_max_f  = EXCLUDED.temp_max_f,
                  model       = EXCLUDED.model
        """, rows)
        conn.commit()
        total += len(rows)
        print(f"    ✓ {len(rows)} days inserted")

    # Summary
    cur.execute("""
        SELECT iso, zone, model, COUNT(*) as rows,
               MIN(year::text||'-'||LPAD(month::text,2,'0')||'-'||LPAD(day::text,2,'0')) as min_d,
               MAX(year::text||'-'||LPAD(month::text,2,'0')||'-'||LPAD(day::text,2,'0')) as max_d
        FROM temperature_forecasts
        GROUP BY iso, zone, model ORDER BY iso, zone
    """)
    summary = cur.fetchall()
    print(f"\n=== Forecast seeding complete: {total:,} new rows ===")
    for iso, zone, model, cnt, mn, mx in summary:
        print(f"  {iso}/{zone} [{model}]: {cnt} days  ({mn} → {mx})")

    conn.close()


if __name__ == "__main__":
    main()
