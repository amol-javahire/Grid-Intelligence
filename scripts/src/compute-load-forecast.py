#!/usr/bin/env python3
"""
Temperature → Load regression forecast for ERCOT zones.

Steps:
  1. Join hourly_temperatures + ercot_load_by_zone → daily aggregates
  2. Fit OLS per zone: avg_load ~ a + b*temp + c*temp^2 + d*sin(2π*m/12) + e*cos(2π*m/12) + f*is_weekend
  3. Apply coefficients to temperature_forecasts (Jul 2026 – Jun 2029) → base_mw
  4. Add EV increment (growth above Jun-2026 baseline, by zone)
  5. Add DC increment (pipeline datacenters by COD date, by zone)
  6. Upsert into load_forecasts table

Usage:
  cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/compute-load-forecast.py
"""

import os
import math
import psycopg2
import psycopg2.extras
import numpy as np
from datetime import date

DATABASE_URL = os.environ["DATABASE_URL"]

ERCOT_ZONES = ["COAS", "EAST", "FWES", "NCEN", "NRTH", "SCEN", "SOUT", "WEST"]

# EV load increment above Jun-2026 baseline (embedded in regression), ERCOT-wide daily avg MW
# Source: ERCOT Long-Term System Assessment 2024, PUCT EV load forecast
EV_SYSTEM_GROWTH = {
    2026: 100,   # H2 2026 incremental vs Jun-2026 baseline
    2027: 500,
    2028: 900,
    2029: 1400,
}

# Monthly seasonal EV charging factor (normalized; peak in winter months due to heating penalty)
EV_MONTHLY_FACTOR = {
    1: 1.15, 2: 1.10, 3: 0.95, 4: 0.90, 5: 0.90, 6: 0.95,
    7: 1.00, 8: 1.00, 9: 0.95, 10: 0.95, 11: 1.05, 12: 1.10,
}

# Zone share of ERCOT EV fleet (EIA vehicle registration data 2024, ERCOT LTSA zone mapping)
EV_ZONE_FRAC = {
    "NCEN": 0.28, "COAS": 0.20, "SCEN": 0.22, "NRTH": 0.12,
    "SOUT": 0.08, "EAST": 0.06, "FWES": 0.03, "WEST": 0.01,
}

# Pipeline datacenters by ERCOT zone: (cod_year, cod_month, capacity_mw)
# Sources: company press releases, ERCOT large load interconnection filings (2024-2025)
DC_PIPELINE_ERCOT = {
    "NCEN": [
        (2026, 7,  150),  # NTT DATA, Garland TX
        (2026, 12, 250),  # Meta, Sherman TX
        (2027, 1,  200),  # CloudHQ, Grand Prairie TX
        (2027, 9,  200),  # Tract (Carlyle), Forney TX
    ],
    "SCEN": [
        (2026, 9,  400),  # Amazon AWS, Pflugerville TX
        (2027, 3,  300),  # Google, Georgetown TX
        (2027, 6,  300),  # xAI (Grok), San Antonio TX
    ],
    "WEST": [
        (2026, 10, 500),  # Microsoft, Abilene TX
    ],
    "COAS": [], "NRTH": [], "SOUT": [], "EAST": [], "FWES": [],
}


def month_to_sincos(month: int):
    angle = 2 * math.pi * month / 12
    return math.sin(angle), math.cos(angle)


def fit_ols(X: np.ndarray, y: np.ndarray):
    """Ordinary least squares: coefficients = (X'X)^-1 X'y"""
    return np.linalg.lstsq(X, y, rcond=None)[0]


def build_feature_row(temp_f: float, month: int, is_weekend: bool):
    s, c = month_to_sincos(month)
    return [1.0, temp_f, temp_f ** 2, s, c, float(is_weekend)]


def main():
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Create table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS load_forecasts (
            id       SERIAL PRIMARY KEY,
            zone     VARCHAR(20) NOT NULL,
            year     SMALLINT NOT NULL,
            month    SMALLINT NOT NULL,
            day      SMALLINT NOT NULL,
            base_mw  REAL,
            ev_mw    REAL,
            dc_mw    REAL,
            total_mw REAL,
            UNIQUE(zone, year, month, day)
        )
    """)
    conn.commit()

    rows_written = 0

    for zone in ERCOT_ZONES:
        print(f"  Fitting regression for zone {zone}...")

        # ── 1. Load daily aggregates ─────────────────────────────────────────
        cur.execute("""
            SELECT
                t.year, t.month, t.day,
                AVG(t.temp_f)  AS avg_temp,
                AVG(l.load_mw) AS avg_load,
                -- weekend detection: day-of-week from date
                EXTRACT(DOW FROM MAKE_DATE(t.year::int, t.month::int, t.day::int)) IN (0,6) AS is_weekend
            FROM hourly_temperatures t
            JOIN ercot_load_by_zone l
              ON t.zone = l.zone
             AND t.year = l.year AND t.month = l.month AND t.day = l.day AND t.hour = l.hour
            WHERE t.iso = 'ERCOT' AND t.zone = %s
            GROUP BY t.year, t.month, t.day
            HAVING COUNT(*) >= 18
            ORDER BY t.year, t.month, t.day
        """, (zone,))
        historical = cur.fetchall()

        if len(historical) < 30:
            print(f"    WARNING: only {len(historical)} days of data for {zone}, skipping regression")
            continue

        X_list, y_list = [], []
        for row in historical:
            yr, mo, dy, avg_temp, avg_load, is_we = row
            if avg_temp is None or avg_load is None:
                continue
            X_list.append(build_feature_row(float(avg_temp), int(mo), bool(is_we)))
            y_list.append(float(avg_load))

        X = np.array(X_list)
        y = np.array(y_list)
        coef = fit_ols(X, y)

        r2 = 1 - np.var(y - X @ coef) / np.var(y)
        print(f"    R²={r2:.3f}, intercept={coef[0]:.0f}, β_temp={coef[1]:.1f}, β_temp²={coef[2]:.3f}")

        # ── 2. Load temperature forecasts ────────────────────────────────────
        cur.execute("""
            SELECT year, month, day, temp_mean_f
            FROM temperature_forecasts
            WHERE zone = %s
            ORDER BY year, month, day
        """, (zone,))
        forecasts = cur.fetchall()

        # Precompute DC pipeline step function for this zone
        pipeline = DC_PIPELINE_ERCOT.get(zone, [])

        upsert_rows = []
        for frow in forecasts:
            yr, mo, dy, temp_mean = frow
            if temp_mean is None:
                continue
            yr, mo, dy = int(yr), int(mo), int(dy)
            d = date(yr, mo, dy)
            is_we = d.weekday() >= 5

            # Base regression estimate
            feat = build_feature_row(float(temp_mean), mo, is_we)
            base_mw = float(np.dot(coef, feat))
            base_mw = max(base_mw, 0)

            # EV increment
            ev_system = EV_SYSTEM_GROWTH.get(yr, 1400)
            ev_zone = ev_system * EV_ZONE_FRAC.get(zone, 0.05)
            ev_mw = ev_zone * EV_MONTHLY_FACTOR.get(mo, 1.0)

            # DC increment: sum of pipeline DCs that came online on or before this date
            dc_mw = 0.0
            for (cod_yr, cod_mo, cap_mw) in pipeline:
                if (yr > cod_yr) or (yr == cod_yr and mo >= cod_mo):
                    dc_mw += cap_mw

            total_mw = base_mw + ev_mw + dc_mw

            upsert_rows.append((zone, yr, mo, dy, round(base_mw, 1), round(ev_mw, 1), round(dc_mw, 1), round(total_mw, 1)))

        # Upsert
        psycopg2.extras.execute_values(cur, """
            INSERT INTO load_forecasts (zone, year, month, day, base_mw, ev_mw, dc_mw, total_mw)
            VALUES %s
            ON CONFLICT (zone, year, month, day) DO UPDATE SET
                base_mw  = EXCLUDED.base_mw,
                ev_mw    = EXCLUDED.ev_mw,
                dc_mw    = EXCLUDED.dc_mw,
                total_mw = EXCLUDED.total_mw
        """, upsert_rows, template="(%s,%s,%s,%s,%s,%s,%s,%s)")

        conn.commit()
        rows_written += len(upsert_rows)
        print(f"    Written {len(upsert_rows)} forecast rows for {zone}")

    conn.close()
    print(f"\nDone — {rows_written} total rows written to load_forecasts")


if __name__ == "__main__":
    main()
