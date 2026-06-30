"""
seed-temperatures-completion.py
Seeds WEST zone completion (rows 20,001–21,168) + all 3 CAISO zones (NP15, SP15, ZP26).
Uses INSERT ... ON CONFLICT DO NOTHING for idempotence.
Runs in small monthly batches to stay under timeout.
"""
import os, psycopg2, random
from datetime import date, timedelta
from calendar import monthrange

DATABASE_URL = os.environ["DATABASE_URL"]
conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

# Climate baselines by ISO+zone  (mean_f, amplitude_f, diurnal_range_f)
CLIMATES = {
    ("ERCOT", "WEST"):  (62.0, 18.0, 22.0),   # West Texas — hot summers, cold winters
    ("CAISO", "NP15"):  (58.0,  8.0, 14.0),   # Bay Area — mild, foggy
    ("CAISO", "SP15"):  (66.0, 10.0, 18.0),   # LA — warm, sunnier
    ("CAISO", "ZP26"):  (64.0, 16.0, 24.0),   # Central Valley — desert-like
}

# Date range: Jan 2024 – May 2026
START = date(2024, 1, 1)
END   = date(2026, 5, 31)

def iter_months(start, end):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m > 12:
            m = 1; y += 1

def hourly_temp(base_f, amplitude_f, diurnal_range_f, month, day, hour, noise_scale=2.0):
    seasonal = amplitude_f * (-0.5 + 0.5 * (1 - abs(month - 7) / 6.0))
    diurnal  = -diurnal_range_f / 2 + diurnal_range_f * max(0, (hour - 6) / 12.0) if 6 <= hour <= 18 else -diurnal_range_f / 2
    noise    = random.gauss(0, noise_scale)
    temp_f   = base_f + seasonal + diurnal + noise
    temp_c   = (temp_f - 32) * 5 / 9
    return round(temp_f, 2), round(temp_c, 2)

zones_to_seed = [
    ("CAISO", "NP15"),
    ("CAISO", "SP15"),
    ("CAISO", "ZP26"),
    ("ERCOT", "WEST"),
]

random.seed(42)

for iso, zone in zones_to_seed:
    base_f, amplitude_f, diurnal_f = CLIMATES[(iso, zone)]
    print(f"\nSeeding {iso} {zone}...", flush=True)
    total = 0
    for year, month in iter_months(START, END):
        days = monthrange(year, month)[1]
        rows = []
        for day in range(1, days + 1):
            for hour in range(24):
                tf, tc = hourly_temp(base_f, amplitude_f, diurnal_f, month, day, hour)
                rows.append((iso, zone, year, month, day, hour, tf, tc))

        cur.executemany(
            """
            INSERT INTO hourly_temperatures (iso, zone, year, month, day, hour, temp_f, temp_c)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (iso, zone, year, month, day, hour) DO NOTHING
            """,
            rows,
        )
        conn.commit()
        total += cur.rowcount
        print(f"  {year}-{month:02d}: inserted {cur.rowcount}/{len(rows)} rows (total {total})", flush=True)

    print(f"  Done {iso} {zone}: {total} rows inserted")

cur.close()
conn.close()
print("\nAll done.")
