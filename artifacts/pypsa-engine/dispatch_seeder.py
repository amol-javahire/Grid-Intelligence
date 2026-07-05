"""
ERCOT Hourly Dispatch Seeder — NP3-965-ER SCED 60-Day Disclosure
Runs inside the PyPSA FastAPI process as a background task.

Tables written:
  ercot_hourly_dispatch     — hourly actuals + offer prices per resource
  ercot_dispatch_seed_log   — gap-fill tracker (one row per seeded operational date)

Usage (from main.py):
  POST /pypsa/admin/seed-dispatch?key=<ERCOT_PASSWORD>
  GET  /pypsa/admin/seed-dispatch-status
  POST /pypsa/admin/seed-dispatch-reset?key=<ERCOT_PASSWORD>
"""
import ast
import math
import os
import time
import logging
import datetime

import psycopg2
import psycopg2.extras
import pandas as pd

logger = logging.getLogger("dispatch_seeder")

# ── Shared status dict (polled by the status endpoint) ─────────────────────────
dispatch_seed_status: dict = {
    "running": False,
    "phase": "idle",
    "completed": False,
    "days_done": 0,
    "days_total": 0,
    "rows_inserted": 0,
    "errors": 0,
    "current_date": None,
    "started_at": None,
    "finished_at": None,
}

# ── Resource type normalization ────────────────────────────────────────────────
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

START_DATE = datetime.date(2024, 1, 1)


def _end_date() -> datetime.date:
    return datetime.date.today() - datetime.timedelta(days=62)


def _safe_float(val) -> float | None:
    try:
        v = float(val)
        return None if (math.isnan(v) or math.isinf(v)) else round(v, 2)
    except (TypeError, ValueError):
        return None


def _parse_offer_curve(cv) -> tuple[float | None, float | None, float | None]:
    """Return (offer_price_min, offer_price_max, offer_mw_total) from SCED1 offer curve."""
    if cv is None:
        return None, None, None
    try:
        segs = ast.literal_eval(cv) if isinstance(cv, str) else cv
        if not segs or not isinstance(segs, list):
            return None, None, None
        prices = [s[1] for s in segs if len(s) >= 2 and -250 < s[1] < 4999]
        mws    = [s[0] for s in segs if len(s) >= 2]
        return (
            round(min(prices), 2) if prices else None,
            round(max(prices), 2) if prices else None,
            round(max(mws),    2) if mws    else None,
        )
    except Exception:
        return None, None, None


def _aggregate_day(gen_df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 5-min sced_gen_resource rows → hourly per resource."""
    if gen_df.empty:
        return pd.DataFrame()

    gen_df = gen_df.copy()
    gen_df["hour_utc"] = gen_df["SCED Timestamp"].dt.tz_convert("UTC").dt.floor("h")
    gen_df["is_online"] = (gen_df["Telemetered Net Output"] > 0).astype(int)

    oc = gen_df["SCED1 Offer Curve"].apply(_parse_offer_curve)
    gen_df["oc_min"] = oc.apply(lambda x: x[0])
    gen_df["oc_max"] = oc.apply(lambda x: x[1])
    gen_df["oc_mw"]  = oc.apply(lambda x: x[2])

    agg = (
        gen_df.groupby(["Resource Name", "Resource Type", "hour_utc"], observed=True)
        .agg(
            avg_mw          = ("Telemetered Net Output", "mean"),
            max_mw          = ("Telemetered Net Output", "max"),
            hsl             = ("HSL",              "mean"),
            lsl             = ("LSL",              "mean"),
            base_point      = ("Base Point",       "mean"),
            online_intervals= ("is_online",        "sum"),
            offer_price_min = ("oc_min",           "mean"),
            offer_price_max = ("oc_max",           "mean"),
            offer_mw_total  = ("oc_mw",            "mean"),
            startup_cold    = ("Start Up Cold Offer", "mean"),
            startup_hot     = ("Start Up Hot Offer",  "mean"),
        )
        .reset_index()
    )
    return agg


def _insert_batch(cur, rows: list[tuple]) -> int:
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
          avg_mw           = EXCLUDED.avg_mw,
          max_mw           = EXCLUDED.max_mw,
          hsl              = EXCLUDED.hsl,
          lsl              = EXCLUDED.lsl,
          base_point       = EXCLUDED.base_point,
          online_intervals = EXCLUDED.online_intervals,
          offer_price_min  = EXCLUDED.offer_price_min,
          offer_price_max  = EXCLUDED.offer_price_max,
          offer_mw_total   = EXCLUDED.offer_mw_total,
          startup_cold     = EXCLUDED.startup_cold,
          startup_hot      = EXCLUDED.startup_hot
        """,
        rows,
        page_size=2000,
    )
    return len(rows)


def _seed_one_day(api, conn, date: datetime.date) -> int:
    """Pull, aggregate, and insert one operational day. Returns rows inserted, or -1 on error."""
    next_day = date + datetime.timedelta(days=1)
    try:
        data = api.get_60_day_sced_disclosure(
            date=str(date), end=str(next_day)
        )
    except Exception as e:
        logger.warning("  %s: API error — %s", date, e)
        return -1

    gen_df = data.get("sced_gen_resource", pd.DataFrame())
    if gen_df.empty:
        logger.warning("  %s: empty sced_gen_resource", date)
        return 0

    agg = _aggregate_day(gen_df)
    if agg.empty:
        return 0

    rows = []
    for _, r in agg.iterrows():
        rows.append((
            r["Resource Name"],
            r["hour_utc"].to_pydatetime(),
            RESOURCE_TYPE_MAP.get(str(r["Resource Type"]), "other"),
            _safe_float(r["avg_mw"]),
            _safe_float(r["max_mw"]),
            _safe_float(r["hsl"]),
            _safe_float(r["lsl"]),
            _safe_float(r["base_point"]),
            int(r["online_intervals"]) if not pd.isna(r["online_intervals"]) else 0,
            _safe_float(r["offer_price_min"]),
            _safe_float(r["offer_price_max"]),
            _safe_float(r["offer_mw_total"]),
            _safe_float(r["startup_cold"]),
            _safe_float(r["startup_hot"]),
        ))

    with conn.cursor() as cur:
        n = _insert_batch(cur, rows)
        cur.execute(
            """INSERT INTO ercot_dispatch_seed_log (seed_date, rows_inserted)
               VALUES (%s, %s) ON CONFLICT (seed_date) DO UPDATE
               SET rows_inserted = %s, seeded_at = now()""",
            (date, n, n),
        )
    conn.commit()
    return n


def _get_seeded_dates(conn) -> set[datetime.date]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT seed_date FROM ercot_dispatch_seed_log WHERE rows_inserted >= 0"
        )
        return {r[0] for r in cur.fetchall()}


def seed_dispatch_full() -> None:
    """
    Pull all ERCOT SCED data from START_DATE to _end_date() and store
    hourly aggregates in ercot_hourly_dispatch.  Gap-fill safe: skips
    dates already recorded in ercot_dispatch_seed_log.
    """
    from gridstatus.ercot_api.ercot_api import ErcotAPI

    status = dispatch_seed_status
    status["running"]     = True
    status["completed"]   = False
    status["phase"]       = "connecting"
    status["started_at"]  = datetime.datetime.utcnow().isoformat()
    status["days_done"]   = 0
    status["rows_inserted"] = 0
    status["errors"]      = 0

    try:
        api = ErcotAPI(
            username            = os.environ.get("ERCOT_USERNAME"),
            password            = os.environ.get("ERCOT_PASSWORD"),
            public_subscription_key = os.environ.get("ERCOT_SUBSCRIPTION_KEY"),
        )

        db_url = os.environ.get("DATABASE_URL")
        conn   = psycopg2.connect(db_url)

        end   = _end_date()
        already = _get_seeded_dates(conn)

        dates_needed = []
        d = START_DATE
        while d <= end:
            if d not in already:
                dates_needed.append(d)
            d += datetime.timedelta(days=1)

        status["days_total"] = len(dates_needed)
        status["phase"]      = "seeding"
        logger.info("Dispatch seeder: %d days to pull (%s → %s)", len(dates_needed), START_DATE, end)

        for i, date in enumerate(dates_needed):
            status["current_date"] = str(date)
            t0 = time.time()
            n  = _seed_one_day(api, conn, date)
            elapsed = time.time() - t0

            if n >= 0:
                status["rows_inserted"] += n
                status["days_done"]     += 1
                logger.info("[%d/%d] %s — %d rows in %.1fs",
                            i + 1, len(dates_needed), date, n, elapsed)
            else:
                status["errors"] += 1
                logger.warning("[%d/%d] %s — error (skipped)", i + 1, len(dates_needed), date)

            time.sleep(0.3)

        conn.close()
        status["completed"] = True
        status["phase"]     = "done"
        logger.info("Dispatch seeder finished: %d rows, %d errors",
                    status["rows_inserted"], status["errors"])

    except Exception as e:
        logger.error("Dispatch seeder crashed: %s", e)
        status["phase"] = f"error: {e}"
    finally:
        status["running"]     = False
        status["current_date"] = None
        status["finished_at"] = datetime.datetime.utcnow().isoformat()
