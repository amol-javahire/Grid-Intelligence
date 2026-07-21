#!/usr/bin/env python3
"""
seed-sced-gap.py — One-time backfill for missing SCED days.

Usage:
    python3 infra/seed-sced-gap.py [START_DATE] [END_DATE]

Defaults to 2025-12-06 → today.
Skips dates already in ercot_dispatch_seed_log.
Safe to re-run (idempotent).

Dependencies (install in pypsa venv):
    pip install polars gridstatus psycopg2-binary
"""
import datetime, os, sys, time, logging
import psycopg2, psycopg2.extras
import polars as pl

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL   = os.environ["DATABASE_URL"]
ERCOT_USERNAME = os.environ["ERCOT_USERNAME"]
ERCOT_PASSWORD = os.environ["ERCOT_PASSWORD"]
ERCOT_SUB_KEY  = os.environ.get("ERCOT_SUBSCRIPTION_KEY", "")

DEFAULT_START = datetime.date(2025, 12, 6)
DEFAULT_END   = datetime.date.today() - datetime.timedelta(days=60)  # SCED 60-day rolling window

START = datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_START
END   = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_END

RESOURCE_TYPE_MAP = {
    "WIND": "wind", "SOLAR": "solar", "GAS": "gas",
    "COAL": "coal", "NUCLEAR": "nuclear", "HYDRO": "hydro",
    "STORAGE": "storage", "OTHER": "other",
}


def get_seeded(conn) -> set:
    with conn.cursor() as cur:
        cur.execute("SELECT seed_date FROM ercot_dispatch_seed_log")
        return {r[0] for r in cur.fetchall()}


def aggregate_day(pandas_df) -> pl.DataFrame:
    """Convert gridstatus pandas output → polars, aggregate to hourly rows."""
    df = pl.from_pandas(pandas_df)

    df = df.with_columns(
        pl.col("SCEDTimestamp")
          .cast(pl.Utf8)
          .str.to_datetime(format=None, strict=False)
          .dt.truncate("1h")
          .alias("hour")
    )

    agg = df.group_by(["ResourceName", "ResourceType", "hour"]).agg([
        pl.col("OutputMW").mean().alias("avg_mw"),
        pl.col("OutputMW").max().alias("max_mw"),
        pl.col("HSLMw").mean().alias("hsl"),
        pl.col("LSLMw").mean().alias("lsl"),
        pl.col("BasePointMW").mean().alias("base_point"),
        pl.col("OutputMW").count().alias("online_intervals"),
    ])

    return agg


def _log_date(conn, date, n, cur=None):
    sql = (
        "INSERT INTO ercot_dispatch_seed_log (seed_date, rows_inserted) "
        "VALUES (%s, %s) ON CONFLICT (seed_date) DO UPDATE SET rows_inserted=%s, seeded_at=now()"
    )
    if cur:
        cur.execute(sql, (date, n, n))
    else:
        with conn.cursor() as c:
            c.execute(sql, (date, n, n))
        conn.commit()


def seed_day(api, conn, date: datetime.date) -> int:
    next_day = date + datetime.timedelta(days=1)
    t0 = time.time()

    try:
        data = api.get_60_day_sced_disclosure(date=str(date), end=str(next_day))
    except Exception as e:
        log.warning(f"  {date}: API error — {e}")
        _log_date(conn, date, -1)
        return -1

    gen_df = data.get("sced_gen_resource")
    if gen_df is None or (hasattr(gen_df, "empty") and gen_df.empty):
        log.warning(f"  {date}: no data — skipping")
        _log_date(conn, date, 0)
        return 0

    try:
        agg = aggregate_day(gen_df)
    except Exception as e:
        log.warning(f"  {date}: aggregation error — {e}")
        _log_date(conn, date, 0)
        return 0

    if agg.is_empty():
        _log_date(conn, date, 0)
        return 0

    rows = [
        (
            row["ResourceName"],
            row["hour"],
            RESOURCE_TYPE_MAP.get(str(row["ResourceType"]).upper(), "other"),
            row["avg_mw"],
            row["max_mw"],
            row["hsl"],
            row["lsl"],
            row["base_point"],
            int(row["online_intervals"]) if row["online_intervals"] is not None else 0,
        )
        for row in agg.to_dicts()
    ]

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO ercot_hourly_dispatch
               (resource_name, hour, resource_type, avg_mw, max_mw, hsl, lsl, base_point, online_intervals)
               VALUES %s
               ON CONFLICT (resource_name, hour) DO UPDATE SET
                 avg_mw=EXCLUDED.avg_mw, max_mw=EXCLUDED.max_mw,
                 hsl=EXCLUDED.hsl, lsl=EXCLUDED.lsl,
                 base_point=EXCLUDED.base_point,
                 online_intervals=EXCLUDED.online_intervals""",
            rows,
            page_size=500,
        )
        _log_date(conn, date, len(rows), cur)
    conn.commit()

    elapsed = time.time() - t0
    log.info(f"  {date}: {len(rows):,} rows in {elapsed:.1f}s")
    return len(rows)


def main():
    from gridstatus.ercot_api.ercot_api import ErcotAPI

    api = ErcotAPI(
        username=ERCOT_USERNAME,
        password=ERCOT_PASSWORD,
        public_subscription_key=ERCOT_SUB_KEY,
    )

    conn = psycopg2.connect(DATABASE_URL)
    seeded = get_seeded(conn)
    log.info(f"Already seeded: {len(seeded)} days")

    dates = []
    d = START
    while d <= END:
        if d not in seeded:
            dates.append(d)
        d += datetime.timedelta(days=1)

    log.info(f"Need to seed: {len(dates)} days ({START} → {END})")

    total, errors = 0, 0
    for i, date in enumerate(dates):
        log.info(f"[{i+1}/{len(dates)}] {date}")
        n = seed_day(api, conn, date)
        if n > 0:
            total += n
        elif n < 0:
            errors += 1
        time.sleep(0.3)

    conn.close()
    log.info(f"\n=== DONE === {total:,} rows inserted | {errors} errors")


if __name__ == "__main__":
    main()
