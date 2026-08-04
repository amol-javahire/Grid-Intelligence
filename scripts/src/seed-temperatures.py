#!/usr/bin/env python3
"""
###########################  DEPRECATED — DO NOT RUN  ########################
# SUPERSEDED 2026-08-03 by scripts/src/seed-iso-temps.py.
#
# Three faults, all of which this file will reintroduce if run:
#   1. HOST-DEPENDENT TIMEZONE. It requests local time from Open-Meteo with
#      timeformat=unixtime, then calls datetime.fromtimestamp(ts) with no tz
#      argument — which resolves against the machine's own timezone. The same
#      inputs produce UTC on the Azure VM and Central time on a Texas laptop.
#      The replacement passes timezone=UTC explicitly and parses ISO strings.
#   2. WRONG CAISO ZONES. Seeds NP15/SP15/ZP26, which are PRICE hubs. CAISO
#      publishes load at DLAPs (PGAE/SCE/SDGE/VEA), so these rows have no load
#      series to join to — defeating the table's only purpose.
#   3. NO PROVENANCE. No source column, while two synthetic seeders write to
#      the same table, making real and modelled rows indistinguishable.
#
# Also deprecated for the same reasons: seed-temperatures-fast.py and
# seed-temperatures-completion.py.
##############################################################################

Seed iso_hourly_temps table from Open-Meteo archive API.
Covers Jan 2024 – May 2026 for 8 ERCOT zones and 3 CAISO zones.

Run from project root:
  cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-temperatures.py
"""

import os, time, psycopg2, requests
from datetime import date, timedelta

DATABASE_URL = os.environ["DATABASE_URL"]

# Zone definitions: EIA zone code → (iso, label, lat, lon, timezone)
ZONES = {
    # ERCOT — 8 EIA sub-BA zones
    "COAS":  ("ERCOT", "Coast (Houston)",     29.76, -95.37, "America/Chicago"),
    "NCEN":  ("ERCOT", "North Central (DFW)", 32.77, -96.80, "America/Chicago"),
    "NRTH":  ("ERCOT", "North (Wichita Falls)", 33.91, -98.49, "America/Chicago"),
    "EAST":  ("ERCOT", "East (Lufkin)",       31.34, -94.73, "America/Chicago"),
    "SCEN":  ("ERCOT", "South Central (SAT)", 29.42, -98.49, "America/Chicago"),
    "SOUT":  ("ERCOT", "South (Corpus Christi)", 27.80, -97.40, "America/Chicago"),
    "FWES":  ("ERCOT", "Far West (Midland)",  31.99, -102.08, "America/Chicago"),
    "WEST":  ("ERCOT", "West (Lubbock)",      33.58, -101.86, "America/Chicago"),
    # CAISO — 3 pricing zones
    "NP15":  ("CAISO", "NP15 (Sacramento)",   38.58, -121.49, "America/Los_Angeles"),
    "SP15":  ("CAISO", "SP15 (Los Angeles)",  34.05, -118.24, "America/Los_Angeles"),
    "ZP26":  ("CAISO", "ZP26 (Fresno)",       36.74, -119.79, "America/Los_Angeles"),
}

START_DATE = date(2024, 1, 1)
END_DATE   = date(2026, 5, 31)

def fetch_zone(zone_code: str, lat: float, lon: float, tz: str) -> list[tuple]:
    """Fetch hourly temps from Open-Meteo archive and return list of row tuples."""
    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude":          lat,
        "longitude":         lon,
        "start_date":        START_DATE.isoformat(),
        "end_date":          END_DATE.isoformat(),
        "hourly":            "temperature_2m",
        "temperature_unit":  "fahrenheit",
        "timezone":          tz,
        "timeformat":        "unixtime",
    }
    resp = requests.get(url, params=params, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    times    = data["hourly"]["time"]
    temps_f  = data["hourly"]["temperature_2m"]
    rows = []
    for ts, tf in zip(times, temps_f):
        if tf is None:
            continue
        dt = date.fromtimestamp(ts)
        # hour = (ts % 86400) // 3600  — local time from API
        from datetime import datetime, timezone
        local_dt = datetime.fromtimestamp(ts)
        rows.append((
            local_dt.year,
            local_dt.month,
            local_dt.day,
            local_dt.hour,
            round(float(tf), 2),
            round((float(tf) - 32) * 5 / 9, 2),
        ))
    return rows

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor()

    for zone_code, (iso, label, lat, lon, tz) in ZONES.items():
        print(f"  Fetching {iso}/{zone_code} ({label})...")
        rows = fetch_zone(zone_code, lat, lon, tz)
        print(f"    → {len(rows)} hours fetched — upserting...")

        if not rows:
            print(f"    ✗ No data returned for {zone_code}")
            continue

        chunk = []
        for (yr, mo, dy, hr, tf, tc) in rows:
            chunk.append((iso, zone_code, yr, mo, dy, hr, tf, tc))
            if len(chunk) >= 500:
                cur.executemany("""
                    INSERT INTO iso_hourly_temps
                      (iso, zone, year, month, day, hour, temp_f, temp_c)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT ON CONSTRAINT hourly_temperatures_uniq DO UPDATE
                      SET temp_f = EXCLUDED.temp_f,
                          temp_c = EXCLUDED.temp_c
                """, chunk)
                conn.commit()
                chunk = []

        if chunk:
            cur.executemany("""
                INSERT INTO iso_hourly_temps
                  (iso, zone, year, month, day, hour, temp_f, temp_c)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT ON CONSTRAINT hourly_temperatures_uniq DO UPDATE
                  SET temp_f = EXCLUDED.temp_f,
                      temp_c = EXCLUDED.temp_c
            """, chunk)
            conn.commit()

        print(f"    ✓ {zone_code} done")
        time.sleep(0.5)  # be polite to Open-Meteo

    cur.execute("SELECT iso, zone, COUNT(*) FROM iso_hourly_temps GROUP BY iso, zone ORDER BY iso, zone")
    rows = cur.fetchall()
    total = sum(r[2] for r in rows)
    print(f"\n=== Seeding complete: {total:,} rows ===")
    for iso, zone, cnt in rows:
        print(f"  {iso}/{zone}: {cnt:,}")

    conn.close()

if __name__ == "__main__":
    main()
