"""
seed-temperatures-fast.py
Seeds iso_hourly_temps for all 11 zones (8 ERCOT + 3 CAISO) using
synthetic climatological data and psycopg2.extras.execute_values for
fast bulk inserts. Runs in ~2-3 minutes, no external API calls.

Run from project root:
  cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-temperatures-fast.py
"""
import os, random
import psycopg2
from psycopg2.extras import execute_values
from datetime import date
from calendar import monthrange

DATABASE_URL = os.environ["DATABASE_URL"]

START = date(2024, 1, 1)
END   = date(2026, 5, 31)

# Climate baselines: (iso, zone) → (mean_f, annual_amplitude_f, diurnal_range_f)
# mean_f: annual average temperature
# annual_amplitude_f: seasonal swing (summer above mean, winter below)
# diurnal_range_f: daytime high - nighttime low swing
CLIMATES = {
    ("ERCOT", "COAS"):  (70.0, 12.0, 14.0),   # Houston coast — hot/humid, mild winters
    ("ERCOT", "NCEN"):  (65.0, 16.0, 18.0),   # DFW — hot summers, cold winters
    ("ERCOT", "NRTH"):  (62.0, 18.0, 20.0),   # Wichita Falls — drier, more extreme
    ("ERCOT", "EAST"):  (67.0, 14.0, 14.0),   # Lufkin — humid east Texas
    ("ERCOT", "SCEN"):  (68.0, 13.0, 16.0),   # San Antonio — south-central
    ("ERCOT", "SOUT"):  (72.0, 11.0, 12.0),   # Corpus Christi — maritime gulf
    ("ERCOT", "FWES"):  (65.0, 18.0, 22.0),   # Midland — semi-arid, high diurnal range
    ("ERCOT", "WEST"):  (62.0, 18.0, 22.0),   # Lubbock — West Texas high plains
    ("CAISO", "NP15"):  (58.0,  8.0, 14.0),   # Bay Area — mild marine influence
    ("CAISO", "SP15"):  (66.0, 10.0, 18.0),   # LA — warm, Mediterranean
    ("CAISO", "ZP26"):  (64.0, 16.0, 24.0),   # Central Valley — continental, hot summers
}

def iter_months(start, end):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m > 12:
            m = 1; y += 1

def hourly_temp(mean_f, amplitude_f, diurnal_f, month, day, hour, rng):
    # Seasonal: peak July (month=7), trough January (month=1)
    seasonal = amplitude_f * (-0.5 + 0.5 * (1 - abs(month - 7) / 6.0))
    # Diurnal: coolest at 5am, hottest at 2pm
    hr_from_min = (hour - 5) % 24
    diurnal = diurnal_f * (0.5 * (1 - abs(hr_from_min - 9) / 12.0) - 0.25)
    noise = rng.gauss(0, 2.0)
    tf = mean_f + seasonal + diurnal + noise
    tc = (tf - 32.0) * 5.0 / 9.0
    return round(tf, 2), round(tc, 2)

def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Truncate and reseed cleanly
    cur.execute("TRUNCATE iso_hourly_temps")
    conn.commit()
    print("Truncated iso_hourly_temps. Seeding all 11 zones...")

    rng = random.Random(42)
    grand_total = 0

    for (iso, zone), (mean_f, amp_f, diur_f) in CLIMATES.items():
        zone_total = 0
        print(f"  {iso}/{zone}...", flush=True)

        for year, month in iter_months(START, END):
            days_in_month = monthrange(year, month)[1]
            rows = []
            for day in range(1, days_in_month + 1):
                for hour in range(24):
                    tf, tc = hourly_temp(mean_f, amp_f, diur_f, month, day, hour, rng)
                    rows.append((iso, zone, year, month, day, hour, tf, tc))

            execute_values(
                cur,
                """
                INSERT INTO iso_hourly_temps
                  (iso, zone, year, month, day, hour, temp_f, temp_c)
                VALUES %s
                ON CONFLICT (iso, zone, year, month, day, hour) DO UPDATE
                  SET temp_f = EXCLUDED.temp_f,
                      temp_c = EXCLUDED.temp_c
                """,
                rows,
                page_size=2000,
            )
            conn.commit()
            zone_total += len(rows)

        print(f"    ✓ {zone_total:,} rows", flush=True)
        grand_total += zone_total

    cur.close()
    conn.close()
    print(f"\n=== Done: {grand_total:,} rows across {len(CLIMATES)} zones ===")

if __name__ == "__main__":
    main()
