"""
ERCOT Hourly Dispatch Seeder — NP3-965-ER SCED 60-Day Disclosure
Source: ERCOT Public API (authenticated — uses ERCOT_USERNAME + ERCOT_PASSWORD + ERCOT_SUBSCRIPTION_KEY)
Coverage: Jan 2024 → present (operational dates; ~60-day lag applied automatically by gridstatus)

Tables:
  ercot_hourly_dispatch     — hourly actuals + offer prices per resource
  ercot_dispatch_seed_log   — tracks which days have been seeded (for gap-fill reruns)

Run: pnpm --filter @workspace/scripts run seed-ercot-dispatch
     (or: cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-ercot-dispatch.py)
"""
import os, sys, ast, math, time, logging, datetime
import psycopg2
import psycopg2.extras
import pandas as pd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL")
USERNAME     = os.environ.get("ERCOT_USERNAME")
PASSWORD     = os.environ.get("ERCOT_PASSWORD")
SUB_KEY      = os.environ.get("ERCOT_SUBSCRIPTION_KEY")

# Operational date range to seed (60-day lag applied internally by gridstatus)
START_DATE   = datetime.date(2024, 1, 1)
# Most recent available: today - 62 days (safe buffer)
END_DATE     = datetime.date.today() - datetime.timedelta(days=62)

BATCH_INSERT_SIZE = 2000   # rows per INSERT batch

if not all([DATABASE_URL, USERNAME, PASSWORD, SUB_KEY]):
    log.error("Missing required env vars: DATABASE_URL, ERCOT_USERNAME, ERCOT_PASSWORD, ERCOT_SUBSCRIPTION_KEY")
    sys.exit(1)

# ── ERCOT resource type → readable category ────────────────────────────────────
RESOURCE_TYPE_MAP = {
    "WIND":   "wind",
    "PVGR":   "solar",
    "PWRSTR": "storage",
    "CCGT90": "natural_gas",
    "CCLE90": "natural_gas",
    "SCGT90": "natural_gas",
    "SCLE90": "natural_gas",
    "GSREH":  "natural_gas",
    "GSNONR": "natural_gas",
    "GSSUP":  "natural_gas",
    "CLLIG":  "coal",
    "NUC":    "nuclear",
    "HYDRO":  "hydro",
    "DSL":    "other",
    "RENEW":  "other",
}

def parse_offer_curve(curve_val):
    """Extract min price, max price, and total offered MW from the SCED offer curve.
    Curve format: [[mw_break, price], [mw_break, price], ...]
    First pair = minimum point, last pair = marginal (highest-price) segment.
    """
    if curve_val is None:
        return None, None, None
    try:
        if isinstance(curve_val, str):
            segments = ast.literal_eval(curve_val)
        else:
            segments = curve_val
        if not segments or not isinstance(segments, list):
            return None, None, None
        prices = [seg[1] for seg in segments if len(seg) >= 2]
        mws    = [seg[0] for seg in segments if len(seg) >= 2]
        # Filter out sentinel values (-250 and 5000 are ERCOT boundary markers)
        real_prices = [p for p in prices if p > -250 and p < 4999]
        offer_min = min(real_prices) if real_prices else None
        offer_max = max(real_prices) if real_prices else None
        offer_mw  = max(mws) if mws else None
        return (
            round(offer_min, 2) if offer_min is not None else None,
            round(offer_max, 2) if offer_max is not None else None,
            round(offer_mw,  2) if offer_mw  is not None else None,
        )
    except Exception:
        return None, None, None

def safe_float(val):
    try:
        v = float(val)
        return None if math.isnan(v) or math.isinf(v) else round(v, 2)
    except (TypeError, ValueError):
        return None

def aggregate_day(gen_df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 5-min sced_gen_resource to hourly per resource."""
    if gen_df.empty:
        return pd.DataFrame()

    # Floor to UTC hour (timestamps are CDT/CST-aware; normalize to UTC)
    gen_df = gen_df.copy()
    gen_df["hour_utc"] = gen_df["SCED Timestamp"].dt.tz_convert("UTC").dt.floor("h")

    # Determine online status: unit is "ON" if Telemetered Net Output > 0
    gen_df["is_online"] = (gen_df["Telemetered Net Output"] > 0).astype(int)

    # Parse offer curve for each row (do it before groupby to avoid complexity)
    oc_parsed = gen_df["SCED1 Offer Curve"].apply(parse_offer_curve)
    gen_df["oc_min"] = oc_parsed.apply(lambda x: x[0])
    gen_df["oc_max"] = oc_parsed.apply(lambda x: x[1])
    gen_df["oc_mw"]  = oc_parsed.apply(lambda x: x[2])

    agg = (
        gen_df.groupby(["Resource Name", "Resource Type", "hour_utc"], observed=True)
        .agg(
            avg_mw          = ("Telemetered Net Output", "mean"),
            max_mw          = ("Telemetered Net Output", "max"),
            hsl             = ("HSL", "mean"),
            lsl             = ("LSL", "mean"),
            base_point      = ("Base Point", "mean"),
            online_intervals= ("is_online", "sum"),
            offer_price_min = ("oc_min", "mean"),
            offer_price_max = ("oc_max", "mean"),
            offer_mw_total  = ("oc_mw",  "mean"),
            startup_cold    = ("Start Up Cold Offer", "mean"),
            startup_hot     = ("Start Up Hot Offer",  "mean"),
        )
        .reset_index()
    )
    agg.columns = [
        "resource_name", "resource_type", "hour",
        "avg_mw", "max_mw", "hsl", "lsl", "base_point", "online_intervals",
        "offer_price_min", "offer_price_max", "offer_mw_total",
        "startup_cold", "startup_hot",
    ]
    return agg

def insert_batch(cur, rows: list[tuple]) -> int:
    if not rows:
        return 0
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO ercot_hourly_dispatch
          (resource_name, hour, resource_type,
           avg_mw, max_mw, hsl, lsl, base_point, online_intervals,
           offer_price_min, offer_price_max, offer_mw_total,
           startup_cold, startup_hot)
        VALUES %s
        ON CONFLICT (resource_name, hour) DO UPDATE SET
          avg_mw          = EXCLUDED.avg_mw,
          max_mw          = EXCLUDED.max_mw,
          hsl             = EXCLUDED.hsl,
          lsl             = EXCLUDED.lsl,
          base_point      = EXCLUDED.base_point,
          online_intervals= EXCLUDED.online_intervals,
          offer_price_min = EXCLUDED.offer_price_min,
          offer_price_max = EXCLUDED.offer_price_max,
          offer_mw_total  = EXCLUDED.offer_mw_total,
          startup_cold    = EXCLUDED.startup_cold,
          startup_hot     = EXCLUDED.startup_hot
        """,
        rows,
        page_size=BATCH_INSERT_SIZE,
    )
    return len(rows)

def seed_date(api, conn, date: datetime.date) -> int:
    """Pull, aggregate, and insert one day of SCED data. Returns rows inserted."""
    next_day = date + datetime.timedelta(days=1)
    t0 = time.time()

    try:
        data = api.get_60_day_sced_disclosure(
            date=str(date),
            end=str(next_day),
        )
    except Exception as e:
        log.warning(f"  {date}: API error — {e}")
        return -1

    gen_df = data.get("sced_gen_resource", pd.DataFrame())
    if gen_df.empty:
        log.warning(f"  {date}: empty sced_gen_resource returned")
        return 0

    agg = aggregate_day(gen_df)
    if agg.empty:
        return 0

    rows = []
    for _, row in agg.iterrows():
        rows.append((
            row["resource_name"],
            row["hour"].to_pydatetime() if hasattr(row["hour"], "to_pydatetime") else row["hour"],
            RESOURCE_TYPE_MAP.get(str(row["resource_type"]), "other"),
            safe_float(row["avg_mw"]),
            safe_float(row["max_mw"]),
            safe_float(row["hsl"]),
            safe_float(row["lsl"]),
            safe_float(row["base_point"]),
            int(row["online_intervals"]) if not pd.isna(row["online_intervals"]) else 0,
            safe_float(row["offer_price_min"]),
            safe_float(row["offer_price_max"]),
            safe_float(row["offer_mw_total"]),
            safe_float(row["startup_cold"]),
            safe_float(row["startup_hot"]),
        ))

    with conn.cursor() as cur:
        n = insert_batch(cur, rows)
        cur.execute(
            """INSERT INTO ercot_dispatch_seed_log (seed_date, rows_inserted)
               VALUES (%s, %s) ON CONFLICT (seed_date) DO UPDATE
               SET rows_inserted=%s, seeded_at=now()""",
            (date, n, n),
        )
    conn.commit()

    elapsed = time.time() - t0
    log.info(f"  {date}: {n:,} rows in {elapsed:.1f}s")
    return n

def get_seeded_dates(conn) -> set:
    with conn.cursor() as cur:
        cur.execute("SELECT seed_date FROM ercot_dispatch_seed_log WHERE rows_inserted >= 0")
        return {r[0] for r in cur.fetchall()}

def main():
    from gridstatus.ercot_api.ercot_api import ErcotAPI
    api = ErcotAPI(
        username=USERNAME,
        password=PASSWORD,
        public_subscription_key=SUB_KEY,
    )

    conn = psycopg2.connect(DATABASE_URL)

    already_seeded = get_seeded_dates(conn)
    log.info(f"Already seeded: {len(already_seeded)} days")

    all_dates = []
    d = START_DATE
    while d <= END_DATE:
        if d not in already_seeded:
            all_dates.append(d)
        d += datetime.timedelta(days=1)

    total_days = len(all_dates)
    log.info(f"Need to seed: {total_days} days ({START_DATE} → {END_DATE})")

    total_rows = 0
    errors = 0
    for i, date in enumerate(all_dates):
        log.info(f"[{i+1}/{total_days}] {date}")
        n = seed_date(api, conn, date)
        if n > 0:
            total_rows += n
        elif n < 0:
            errors += 1
        # Brief pause to avoid rate limiting
        time.sleep(0.5)

    conn.close()

    # Final summary
    conn2 = psycopg2.connect(DATABASE_URL)
    with conn2.cursor() as cur:
        cur.execute("SELECT COUNT(*), COUNT(DISTINCT resource_name), MIN(hour), MAX(hour) FROM ercot_hourly_dispatch")
        r = cur.fetchone()
        log.info(f"\n=== DONE ===")
        log.info(f"Total rows: {r[0]:,} | Resources: {r[1]:,} | Range: {r[2]} → {r[3]}")
        log.info(f"Days seeded this run: {total_days - errors} | Errors: {errors}")
    conn2.close()

if __name__ == "__main__":
    main()
