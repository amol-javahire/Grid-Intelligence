#!/usr/bin/env python3
"""
seed-iso-temps.py — hourly temperatures for every ISO load zone, from Open-Meteo.

REPLACES seed-temperatures.py, seed-temperatures-fast.py and
seed-temperatures-completion.py. Those three all wrote to the same table with
no source column, so real and synthetic rows became indistinguishable. Worse,
the real one stored a HOST-DEPENDENT timezone: it requested local time, asked
for unixtime, then called datetime.fromtimestamp(ts) with no tz argument, which
resolves against whatever timezone the machine happens to be set to. Running it
on the VM and on a laptop produced different data from identical inputs.

THIS SEEDER'S CONVENTIONS — all deliberate, all recorded in iso_table_metadata:

  * timezone=UTC is passed EXPLICITLY to Open-Meteo, and timestamps are parsed
    from ISO-8601 strings rather than unix epochs. Output is identical on any
    host, in any timezone, forever.

  * hour is UTC hour-beginning 0..23, matching ercot/caiso/pjm_hourly_zonal_load
    exactly, so the temperature/load regression joins on (year,month,day,hour)
    with no conversion. This is the whole reason the table exists.

  * Zones are the ACTUAL codes present in the load tables, read from the
    database on 2026-08-03 rather than recalled. PJM's largest zone is AEP, and
    ATSI/DEOK/EKPC/RECO exist — none of which would survive being guessed at.

  * method='single_centroid'. One representative point per zone, which is what
    the ISOs publish themselves. See the note in the schema migration on when
    load-weighting would actually be worth the extra dependency.

Degree days are computed in MARKET-LOCAL time, not UTC — a degree day is a
local-calendar concept, and a UTC rollup would mix the tail of one local day
into the next.

Flags:
  --inspect          probe Open-Meteo for one zone, print, write nothing
  --iso ERCOT        restrict to one ISO
  --only hourly|dd|both   (default both)
  --start 2024-01    override start month
  --truncate         wipe matching rows first (transactional, scoped)

Run:
  cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-iso-temps.py
"""

import argparse
import datetime as dt
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import psycopg2
import psycopg2.extras
import requests

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    sys.exit("DATABASE_URL not set")

ARCHIVE_URL  = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# Open-Meteo's ERA5 archive lags real time by ~5 days. Anything newer comes
# from the forecast endpoint's `past_days` window instead.
ARCHIVE_LAG_DAYS = 6

# Degree-day bases. 18.3 C == 65 F; both are stored so neither unit forces a
# conversion at query time.
HDD_BASE_C, HDD_BASE_F = 18.3, 65.0


# ── Zones ───────────────────────────────────────────────────────────────────
# (iso, zone) -> (label, lat, lon, market_timezone)
#
# Zone codes verified against the live load tables on 2026-08-03:
#   SELECT zone, ROUND(AVG(load_mw)) FROM {market}_hourly_zonal_load GROUP BY zone
# Do NOT edit a code here without re-running that query — a code that does not
# exist in the load table produces a silently empty join, not an error.
#
# Coordinates are the conventional weather proxy for each utility territory:
# the population/load centre, not the geometric centroid, because load responds
# to the temperature where the people are.

ZONES: dict[tuple[str, str], tuple[str, float, float, str]] = {
    # ── ERCOT — 8 weather zones ──────────────────────────────────────────────
    ("ERCOT", "COAS"): ("Coast (Houston)",              29.76,  -95.37, "America/Chicago"),
    ("ERCOT", "NCEN"): ("North Central (DFW)",          32.77,  -96.80, "America/Chicago"),
    ("ERCOT", "SCEN"): ("South Central (San Antonio)",  29.42,  -98.49, "America/Chicago"),
    # FWES correlates only r=0.15 with load, against 0.81-0.92 for every other
    # ERCOT zone. That is CORRECT, not a bad centroid: Far West is the Permian
    # Basin, and its load is oilfield electrification — pumping, gas
    # compression, drilling — which runs flat around the clock and barely
    # responds to air temperature. Do not "improve" this coordinate; moving it
    # would be fitting noise. It also means FWES load growth tracks drilling
    # activity rather than weather, which any FWES forecast must account for.
    ("ERCOT", "FWES"): ("Far West (Midland-Odessa)",    31.99, -102.08, "America/Chicago"),
    ("ERCOT", "SOUT"): ("Southern (Corpus Christi)",    27.80,  -97.40, "America/Chicago"),
    ("ERCOT", "EAST"): ("East (Tyler-Lufkin)",          31.34,  -94.73, "America/Chicago"),
    ("ERCOT", "NRTH"): ("North (Wichita Falls)",        33.91,  -98.49, "America/Chicago"),
    # WEST is Abilene/San Angelo country. The previous seeder used Lubbock,
    # which sits in the Panhandle and runs several degrees colder in winter.
    ("ERCOT", "WEST"): ("West (Abilene)",               32.45,  -99.73, "America/Chicago"),

    # ── CAISO — 4 DLAPs ──────────────────────────────────────────────────────
    # NOT NP15/SP15/ZP26. Those are PRICE hubs; CAISO publishes load at DLAPs
    # and does not publish load on the hubs. The old seeder used the hubs, so
    # its output had no load table to join to.
    ("CAISO", "SCE"):  ("SCE (Inland Empire)",          33.95, -117.40, "America/Los_Angeles"),
    # PG&E spans the mild Bay Area and the hot Central Valley. Stockton sits
    # between the two and picks up both load drivers.
    #
    # This was originally Sacramento, which was simply WRONG: Sacramento is
    # served by SMUD, a municipal utility in the BANC balancing authority, and
    # is not part of PG&E's DLAP at all. The centroid sat in territory the zone
    # does not serve. Corrected 2026-08-03.
    #
    # Chosen on territorial correctness, not on r — the measured difference is
    # small (May-Sep 2025 daily peak-vs-Tmax: Sacramento 0.825, Stockton 0.857).
    #
    # A 3-point blend (San Jose + Fresno + Stockton) scored HIGHEST in both test
    # windows — 0.870 on July alone and 0.885 on May-Sep — but the gain over the
    # incumbent (+0.068 and +0.060) never cleared the Fisher-z noise floor
    # (0.192 at n=30, 0.082 at n=152). Consistent across two windows and
    # therefore suggestive, but formally under-powered, so method stays
    # 'single_centroid'. To settle it, extend test-temp-centroids.py to pool
    # 2024+2025 (n~300, floor ~0.058) and re-run; if the blend still leads by
    # ~0.06 it clears, and PG&E becomes the first zone to justify
    # method='load_weighted' on evidence.
    ("CAISO", "PGAE"): ("PG&E (Stockton)",              37.96, -121.29, "America/Los_Angeles"),
    ("CAISO", "SDGE"): ("SDG&E (San Diego)",            32.72, -117.16, "America/Los_Angeles"),
    ("CAISO", "VEA"):  ("Valley Electric (Pahrump NV)", 36.21, -115.98, "America/Los_Angeles"),

    # ── PJM — 20 zones, EIA codes ────────────────────────────────────────────
    ("PJM", "AEP"):  ("AEP Ohio (Columbus)",            39.96,  -82.99, "America/New_York"),
    ("PJM", "DOM"):  ("Dominion (Richmond)",            37.54,  -77.44, "America/New_York"),
    ("PJM", "CE"):   ("ComEd (Chicago)",                41.88,  -87.63, "America/New_York"),
    ("PJM", "ATSI"): ("ATSI FirstEnergy (Akron)",       41.08,  -81.52, "America/New_York"),
    ("PJM", "AP"):   ("Allegheny APS (Morgantown)",     39.63,  -79.96, "America/New_York"),
    ("PJM", "PS"):   ("PSEG (Newark)",                  40.74,  -74.17, "America/New_York"),
    ("PJM", "PL"):   ("PPL (Allentown)",                40.60,  -75.47, "America/New_York"),
    ("PJM", "PE"):   ("PECO (Philadelphia)",            39.95,  -75.17, "America/New_York"),
    ("PJM", "BC"):   ("BGE (Baltimore)",                39.29,  -76.61, "America/New_York"),
    ("PJM", "PEP"):  ("Pepco (Washington DC)",          38.91,  -77.04, "America/New_York"),
    ("PJM", "DEOK"): ("Duke Ohio-Kentucky (Cincinnati)",39.10,  -84.51, "America/New_York"),
    ("PJM", "JC"):   ("JCP&L (Freehold NJ)",            40.22,  -74.28, "America/New_York"),
    ("PJM", "DPL"):  ("Delmarva (Wilmington)",          39.74,  -75.55, "America/New_York"),
    ("PJM", "DAY"):  ("Dayton P&L (Dayton)",            39.76,  -84.19, "America/New_York"),
    ("PJM", "PN"):   ("Penelec (State College PA)",     40.79,  -77.86, "America/New_York"),
    ("PJM", "ME"):   ("Met-Ed (Reading PA)",            40.34,  -75.93, "America/New_York"),
    ("PJM", "EKPC"): ("East Kentucky Coop (Winchester)",37.99,  -84.18, "America/New_York"),
    ("PJM", "DUQ"):  ("Duquesne Light (Pittsburgh)",    40.44,  -79.99, "America/New_York"),
    ("PJM", "AE"):   ("Atlantic City Electric",         39.36,  -74.42, "America/New_York"),
    ("PJM", "RECO"): ("Rockland Electric (Mahwah NJ)",  41.09,  -74.14, "America/New_York"),

    # ── AESO — 6 planning regions ────────────────────────────────────────────
    # AESO publishes SYSTEM load (ail_mw), not zonal, so these join to system
    # load rather than a zonal table. Still worth having: the planning regions
    # are the geography the rest of the AESO app is built on.
    ("AESO", "Northwest"): ("Grande Prairie",           55.17, -118.80, "America/Edmonton"),
    ("AESO", "Northeast"): ("Fort McMurray",            56.73, -111.38, "America/Edmonton"),
    ("AESO", "Edmonton"):  ("Edmonton",                 53.55, -113.49, "America/Edmonton"),
    ("AESO", "Central"):   ("Red Deer",                 52.27, -113.81, "America/Edmonton"),
    ("AESO", "Calgary"):   ("Calgary",                  51.05, -114.07, "America/Edmonton"),
    ("AESO", "South"):     ("Lethbridge",               49.69, -112.83, "America/Edmonton"),
}

DEFAULT_START = dt.date(2024, 1, 1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--inspect", action="store_true",
                   help="probe one zone, print a sample, write nothing")
    p.add_argument("--iso", default=None, help="restrict to one ISO")
    p.add_argument("--only", choices=["hourly", "dd", "both"], default="both")
    p.add_argument("--start", default=None, help="YYYY-MM start month")
    p.add_argument("--truncate", action="store_true",
                   help="delete matching rows before inserting (transactional)")
    p.add_argument("--workers", type=int, default=4)
    return p.parse_args()


def fetch_zone(lat: float, lon: float, start: dt.date, end: dt.date) -> list[tuple]:
    """
    Return [(year, month, day, hour, temp_c), ...] in UTC.

    timezone=UTC and timeformat=iso8601 are both explicit. The previous seeder
    relied on the host clock and was therefore not reproducible.
    """
    out: list[tuple] = []
    today = dt.date.today()
    archive_end = min(end, today - dt.timedelta(days=ARCHIVE_LAG_DAYS))

    def _collect(payload: dict) -> None:
        hourly = payload.get("hourly") or {}
        for stamp, temp in zip(hourly.get("time", []), hourly.get("temperature_2m", [])):
            if temp is None:
                continue
            # "2024-01-15T14:00" — fixed width, no locale, no epoch arithmetic.
            d, t = stamp.split("T")
            y, mo, dd = (int(x) for x in d.split("-"))
            hh = int(t.split(":")[0])
            out.append((y, mo, dd, hh, round(float(temp), 2)))

    if archive_end >= start:
        r = requests.get(ARCHIVE_URL, timeout=120, params={
            "latitude": lat, "longitude": lon,
            "start_date": start.isoformat(), "end_date": archive_end.isoformat(),
            "hourly": "temperature_2m",
            "temperature_unit": "celsius",
            "timezone": "UTC",
            "timeformat": "iso8601",
        })
        r.raise_for_status()
        _collect(r.json())

    # Recent days the archive has not caught up on yet.
    if end > archive_end:
        gap = (today - archive_end).days + 1
        r = requests.get(FORECAST_URL, timeout=120, params={
            "latitude": lat, "longitude": lon,
            "hourly": "temperature_2m",
            "temperature_unit": "celsius",
            "timezone": "UTC",
            "timeformat": "iso8601",
            "past_days": min(gap, 92),
            "forecast_days": 1,
        })
        r.raise_for_status()
        before = len(out)
        _collect(r.json())
        # Drop anything already covered by the archive or beyond the window.
        out = out[:before] + [
            row for row in out[before:]
            if archive_end < dt.date(row[0], row[1], row[2]) <= end
        ]

    return out


def seed_hourly(args: argparse.Namespace) -> int:
    start = DEFAULT_START
    if args.start:
        y, m = args.start.split("-")
        start = dt.date(int(y), int(m), 1)
    end = dt.date.today()

    targets = {k: v for k, v in ZONES.items()
               if args.iso is None or k[0].upper() == args.iso.upper()}
    if not targets:
        sys.exit(f"No zones match --iso {args.iso}. Known ISOs: "
                 f"{sorted({k[0] for k in ZONES})}")

    print(f"Seeding {len(targets)} zones, {start} → {end}, UTC hour-beginning\n")

    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    total = 0

    def work(item):
        (iso, zone), (label, lat, lon, _tz) = item
        for attempt in range(4):
            try:
                return iso, zone, label, lat, lon, fetch_zone(lat, lon, start, end)
            except Exception as exc:                      # noqa: BLE001
                if attempt == 3:
                    raise
                wait = 5 * (attempt + 1)
                print(f"  [{iso}/{zone}] {type(exc).__name__} — retry in {wait}s", flush=True)
                time.sleep(wait)
        return iso, zone, label, lat, lon, []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(work, item) for item in targets.items()]
        for fut in as_completed(futures):
            iso, zone, label, lat, lon, rows = fut.result()
            if not rows:
                print(f"  ⚠  {iso}/{zone} ({label}) — NO DATA returned", flush=True)
                continue

            if args.truncate:
                cur.execute(
                    "DELETE FROM iso_hourly_temps WHERE iso = %s AND zone = %s",
                    (iso, zone),
                )

            payload = [
                (iso, zone, y, mo, d, h, c, round(c * 9 / 5 + 32, 2),
                 lat, lon, "open_meteo_archive", "single_centroid")
                for (y, mo, d, h, c) in rows
            ]
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO iso_hourly_temps
                  (iso, zone, year, month, day, hour, temp_c, temp_f,
                   latitude, longitude, source, method)
                VALUES %s
                ON CONFLICT (iso, zone, year, month, day, hour) DO UPDATE SET
                  temp_c = EXCLUDED.temp_c, temp_f = EXCLUDED.temp_f,
                  latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                  source = EXCLUDED.source, method = EXCLUDED.method
                """,
                payload, template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                page_size=5000,
            )
            conn.commit()
            total += len(payload)
            print(f"  ✓ {iso:<5} {zone:<10} {label:<34} {len(payload):>7,} hours", flush=True)

    cur.close()
    conn.close()
    return total


def build_degree_days(args: argparse.Namespace) -> int:
    """
    Roll hourly UTC temperatures into LOCAL-calendar degree days.

    Done in SQL, one statement per market timezone, because the conversion is
    a timezone shift Postgres already knows how to do correctly across DST —
    reimplementing that in Python would be slower and worse.
    """
    by_tz: dict[str, list[str]] = {}
    for (iso, _zone), (_label, _lat, _lon, tz) in ZONES.items():
        by_tz.setdefault(tz, [])
        if iso not in by_tz[tz]:
            by_tz[tz].append(iso)

    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    total = 0

    for tz, isos in by_tz.items():
        cur.execute(
            """
            INSERT INTO iso_daily_degree_days
              (iso, zone, local_date, time_zone, temp_c_avg, temp_c_min,
               temp_c_max, hdd_c, cdd_c, hdd_f, cdd_f, hours_used)
            SELECT iso, zone, local_date, %(tz)s,
                   ROUND(avg_c::numeric, 2), ROUND(min_c::numeric, 2),
                   ROUND(max_c::numeric, 2),
                   ROUND(GREATEST(0, %(hb_c)s - avg_c)::numeric, 3),
                   ROUND(GREATEST(0, avg_c - %(hb_c)s)::numeric, 3),
                   ROUND(GREATEST(0, %(hb_f)s - avg_f)::numeric, 3),
                   ROUND(GREATEST(0, avg_f - %(hb_f)s)::numeric, 3),
                   n_hours
            FROM (
              SELECT iso, zone,
                     ((make_timestamp(year, month, day, hour, 0, 0)
                        AT TIME ZONE 'UTC') AT TIME ZONE %(tz)s)::date AS local_date,
                     AVG(temp_c) AS avg_c, MIN(temp_c) AS min_c,
                     MAX(temp_c) AS max_c, AVG(temp_f) AS avg_f,
                     COUNT(*)    AS n_hours
              FROM iso_hourly_temps
              WHERE iso = ANY(%(isos)s)
              GROUP BY iso, zone, 3
            ) d
            WHERE n_hours >= 20   -- drop partial edge days at the window bounds
            ON CONFLICT (iso, zone, local_date) DO UPDATE SET
              temp_c_avg = EXCLUDED.temp_c_avg, temp_c_min = EXCLUDED.temp_c_min,
              temp_c_max = EXCLUDED.temp_c_max, hdd_c = EXCLUDED.hdd_c,
              cdd_c = EXCLUDED.cdd_c, hdd_f = EXCLUDED.hdd_f,
              cdd_f = EXCLUDED.cdd_f, hours_used = EXCLUDED.hours_used,
              time_zone = EXCLUDED.time_zone
            """,
            {"tz": tz, "isos": isos, "hb_c": HDD_BASE_C, "hb_f": HDD_BASE_F},
        )
        conn.commit()
        total += cur.rowcount
        print(f"  ✓ {tz:<22} {', '.join(isos):<22} {cur.rowcount:>7,} zone-days")

    cur.close()
    conn.close()
    return total


def inspect() -> None:
    (iso, zone), (label, lat, lon, tz) = next(iter(ZONES.items()))
    end = dt.date.today() - dt.timedelta(days=ARCHIVE_LAG_DAYS)
    start = end - dt.timedelta(days=2)
    print(f"Probing {iso}/{zone} — {label} ({lat}, {lon}), market tz {tz}")
    print(f"Window {start} → {end}, requesting timezone=UTC\n")
    rows = fetch_zone(lat, lon, start, end)
    print(f"{len(rows)} hours returned. First 6 and last 6:\n")
    for y, mo, d, h, c in rows[:6] + rows[-6:]:
        print(f"  {y}-{mo:02d}-{d:02d} {h:02d}:00 UTC   {c:6.2f} C   {c*9/5+32:6.2f} F")
    hours = sorted({r[3] for r in rows})
    print(f"\nDistinct hours present: {len(hours)} (expect 24) → {hours}")

    # The decisive check: if the response really is UTC, the daily maximum sits
    # in the local afternoon, which is a shifted UTC hour — NOT hour 14.
    offset = {"America/Chicago": 5, "America/Los_Angeles": 7,
              "America/New_York": 4, "America/Edmonton": 6}[tz]
    warmest = max(rows, key=lambda r: r[4])
    print(f"\nWarmest hour returned: {warmest[3]:02d}:00 UTC at {warmest[4]:.2f} C "
          f"= {(warmest[3] - offset) % 24:02d}:00 local")
    print(f"Expect roughly 14:00 local. If it reads 14:00 UTC instead, the API "
          f"ignored timezone=UTC and this seeder must not be trusted.")


def main() -> None:
    args = parse_args()

    if args.inspect:
        inspect()
        return

    print("=== ISO hourly temperatures (Open-Meteo, UTC) ===\n")

    if args.only in ("hourly", "both"):
        n = seed_hourly(args)
        print(f"\niso_hourly_temps: {n:,} rows\n")

    if args.only in ("dd", "both"):
        print("Building local-calendar degree days...")
        n = build_degree_days(args)
        print(f"\niso_daily_degree_days: {n:,} rows")

    print("\nDone. Verify with infra/verify-iso-temps.sql")


if __name__ == "__main__":
    main()
