#!/usr/bin/env python3
"""
test-temp-centroids.py — pick zone weather points by MEASUREMENT, not by guess.

Writes nothing. For each candidate coordinate it pulls July 2025 hourly
temperatures from Open-Meteo (UTC), joins them to that zone's real hourly load,
and reports Pearson r. Best r wins.

WHY THIS EXISTS
  The first pass at CAISO centroids produced SDGE r = -0.455 and PGAE r = 0.221
  on POOLED HOURLY data, against 0.65-0.92 for every ERCOT and PJM zone.

  Running this harness showed SDGE was a false alarm: all seven San Diego
  candidates returned -0.45 to -0.50, and moving inland made it WORSE. Seven
  coordinates giving one answer means location is not the variable. On the
  DAILY formulation the same data scores +0.847 (peak vs Tmax) and +0.913
  (avg vs CDD) — the strongest in CAISO. The pooled-hourly negative is
  Simpson's paradox: within any fixed hour-window temp and load correlate
  positively (+0.52 evening, +0.28 midday), but SDGE's load peak lags its
  temperature peak by hours, so pooling across the diurnal cycle lets
  between-hour variance dominate and flip the sign.

  PGAE was a real error and worth fixing: the point was Sacramento, served by
  SMUD — a municipal utility outside PG&E's DLAP entirely — so the centroid sat
  in territory the zone does not serve.

  LESSON, and the reason to keep this script: pooled hourly r is a valid
  diagnostic only where load and temperature peaks are roughly in phase.
  ERCOT and PJM are; CAISO is not. Always confirm a candidate on the daily
  formulation (--daily) before re-seeding. A single number that disagrees with
  six others is usually the test being wrong, not the world.

BLENDS
  A candidate may carry several points. PG&E spans the mild Bay Area and the
  hot Central Valley, which is precisely the case a single centroid handles
  badly; averaging two points is a poor-man's load weighting and often beats
  any single city. If a blend wins clearly, that is the evidence for switching
  method='load_weighted' for that zone.

Run:
  cd ~/grid-intelligence && set -a; source .env; set +a
  artifacts/pypsa-engine/.venv/bin/python3 scripts/src/test-temp-centroids.py
  artifacts/pypsa-engine/.venv/bin/python3 scripts/src/test-temp-centroids.py --zone SDGE
"""

import argparse
import os
import statistics
import sys

import psycopg2
import requests

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    sys.exit("DATABASE_URL not set")

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Test window. July gives the strongest cooling signal; January is offered via
# --month for the winter-peaking check that matters to AESO and northern PJM.
DEFAULT_YEAR, DEFAULT_MONTH = 2025, 7

LOAD_TABLE = {
    "ERCOT": "ercot_hourly_zonal_load",
    "CAISO": "caiso_hourly_zonal_load",
    "PJM":   "pjm_hourly_zonal_load",
}

# (iso, zone) -> [(label, [(lat, lon), ...]), ...]
# The first entry in each list is the coordinate CURRENTLY seeded, so the table
# always shows what the change would actually buy.
CANDIDATES: dict[tuple[str, str], list[tuple[str, list[tuple[float, float]]]]] = {
    ("CAISO", "SDGE"): [
        ("CURRENT downtown San Diego", [(32.72, -117.16)]),
        ("Miramar / Kearny Mesa",      [(32.87, -117.14)]),
        ("El Cajon",                   [(32.79, -116.96)]),
        ("Escondido",                  [(33.12, -117.09)]),
        ("Ramona (inland valley)",     [(33.04, -116.87)]),
        ("Chula Vista",                [(32.64, -117.08)]),
        ("blend: El Cajon + coast",    [(32.79, -116.96), (32.72, -117.16)]),
    ],
    ("CAISO", "PGAE"): [
        ("CURRENT Sacramento (SMUD!)", [(38.58, -121.49)]),
        ("San Jose",                   [(37.34, -121.89)]),
        ("Fresno",                     [(36.74, -119.79)]),
        ("Stockton",                   [(37.96, -121.29)]),
        ("Concord / East Bay",         [(37.98, -122.03)]),
        ("Bakersfield",                [(35.37, -119.02)]),
        ("blend: San Jose + Fresno",   [(37.34, -121.89), (36.74, -119.79)]),
        ("blend: Bay + Valley + North",[(37.34, -121.89), (36.74, -119.79), (37.96, -121.29)]),
    ],
    ("CAISO", "SCE"): [
        ("CURRENT Riverside",          [(33.95, -117.40)]),
        ("Ontario / Inland Empire",    [(34.06, -117.65)]),
        ("Long Beach",                 [(33.77, -118.19)]),
        ("Santa Ana",                  [(33.75, -117.87)]),
        ("blend: Riverside + coast",   [(33.95, -117.40), (33.77, -118.19)]),
    ],
    ("CAISO", "VEA"): [
        ("CURRENT Pahrump NV",         [(36.21, -115.98)]),
        ("Beatty NV",                  [(36.91, -116.76)]),
    ],
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--zone", default=None, help="test one zone only, e.g. SDGE")
    p.add_argument("--year", type=int, default=DEFAULT_YEAR)
    p.add_argument("--month", type=int, default=DEFAULT_MONTH)
    p.add_argument("--daily", action="store_true",
                   help="correlate DAILY peak load vs DAILY max temp instead of "
                        "pooled hourly. Authoritative for CAISO, where pooled "
                        "hourly r is distorted by the load/temperature phase lag.")
    return p.parse_args()


MARKET_TZ = {"ERCOT": "America/Chicago", "CAISO": "America/Los_Angeles",
             "PJM": "America/New_York"}


def to_daily(hourly: dict[tuple, float], tz: str, agg: str) -> dict:
    """
    Collapse UTC-keyed hourly values onto LOCAL calendar days.

    Uses zoneinfo rather than a fixed offset so DST transitions land on the
    right local date — the same reason the degree-day rollup is done in SQL
    with AT TIME ZONE rather than by subtracting a constant.
    """
    import datetime as _dt
    from zoneinfo import ZoneInfo
    zone = ZoneInfo(tz)
    buckets: dict[_dt.date, list[float]] = {}
    for (y, m, d, h), v in hourly.items():
        local = _dt.datetime(y, m, d, h, tzinfo=_dt.timezone.utc).astimezone(zone)
        buckets.setdefault(local.date(), []).append(v)
    fn = max if agg == "max" else statistics.fmean
    return {k: fn(v) for k, v in buckets.items() if len(v) >= 20}


def month_bounds(year: int, month: int) -> tuple[str, str]:
    import calendar
    last = calendar.monthrange(year, month)[1]
    return f"{year}-{month:02d}-01", f"{year}-{month:02d}-{last:02d}"


def fetch_temps(points: list[tuple[float, float]], year: int, month: int) -> dict[tuple, float]:
    """
    Mean temperature across `points` keyed by (y, m, d, h) in UTC.
    Averaging coordinates is a crude stand-in for load weighting — good enough
    to tell whether weighting would help at all before building the real thing.
    """
    start, end = month_bounds(year, month)
    series: list[dict[tuple, float]] = []
    for lat, lon in points:
        r = requests.get(ARCHIVE_URL, timeout=120, params={
            "latitude": lat, "longitude": lon,
            "start_date": start, "end_date": end,
            "hourly": "temperature_2m",
            "temperature_unit": "celsius",
            "timezone": "UTC",          # explicit — never rely on the host clock
            "timeformat": "iso8601",
        })
        r.raise_for_status()
        h = r.json()["hourly"]
        out: dict[tuple, float] = {}
        for stamp, temp in zip(h["time"], h["temperature_2m"]):
            if temp is None:
                continue
            d, t = stamp.split("T")
            y, mo, dd = (int(x) for x in d.split("-"))
            out[(y, mo, dd, int(t.split(":")[0]))] = float(temp)
        series.append(out)

    keys = set(series[0])
    for s in series[1:]:
        keys &= set(s)
    return {k: statistics.fmean(s[k] for s in series) for k in keys}


def fetch_load(iso: str, zone: str, year: int, month: int) -> dict[tuple, float]:
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    cur.execute(
        f"SELECT year, month, day, hour, load_mw FROM {LOAD_TABLE[iso]} "
        "WHERE zone = %s AND year = %s AND month = %s",
        (zone, year, month),
    )
    rows = {(y, m, d, h): float(v) for y, m, d, h, v in cur.fetchall() if v is not None}
    cur.close()
    conn.close()
    return rows


def pearson(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return float("nan")
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return float("nan") if dx * dy == 0 else num / (dx * dy)


def main() -> None:
    args = parse_args()
    targets = {k: v for k, v in CANDIDATES.items()
               if args.zone is None or k[1].upper() == args.zone.upper()}
    if not targets:
        sys.exit(f"No candidates for --zone {args.zone}. "
                 f"Known: {sorted(z for _, z in CANDIDATES)}")

    mode = "DAILY peak load vs max temp" if args.daily else "POOLED HOURLY"
    print(f"Candidate weather points — {mode} — {args.year}-{args.month:02d}")
    if not args.daily:
        print("NOTE: pooled hourly is only valid where load and temperature "
              "peaks are in phase.\n      CAISO's are not — confirm any switch "
              "with --daily before re-seeding.")
    print()

    for (iso, zone), options in targets.items():
        load = fetch_load(iso, zone, args.year, args.month)
        if not load:
            print(f"{iso}/{zone}: no load rows for that month — skipping\n")
            continue

        tz = MARKET_TZ[iso]
        load_series = to_daily(load, tz, "max") if args.daily else load
        unit = "days" if args.daily else "hours"

        print(f"── {iso} / {zone} ({len(load_series)} load {unit}) "
              f"{'─' * max(0, 40 - len(zone))}")
        results = []
        for label, points in options:
            temps = fetch_temps(points, args.year, args.month)
            temp_series = to_daily(temps, tz, "max") if args.daily else temps
            keys = sorted(set(temp_series) & set(load_series))
            r = pearson([temp_series[k] for k in keys], [load_series[k] for k in keys])
            results.append((r, label, points, len(keys)))

        baseline = results[0][0]
        for r, label, points, n in sorted(results, key=lambda x: -x[0]):
            coords = " + ".join(f"{la:.2f},{lo:.2f}" for la, lo in points)
            delta = r - baseline
            mark = "  <-- CURRENT" if label.startswith("CURRENT") else ""
            arrow = "" if label.startswith("CURRENT") else f"  ({delta:+.3f})"
            print(f"   r={r:+.3f}{arrow:>10}  {label:<30} [{coords}] n={n}{mark}")

        best = max(results, key=lambda x: x[0])
        if best[1].startswith("CURRENT"):
            print(f"   → keep current point\n")
        else:
            gain = best[0] - baseline
            kind = "blend" if len(best[2]) > 1 else "single point"
            print(f"   → switch to {best[1]} ({kind}), r {baseline:+.3f} → "
                  f"{best[0]:+.3f} ({gain:+.3f})\n")


if __name__ == "__main__":
    main()
