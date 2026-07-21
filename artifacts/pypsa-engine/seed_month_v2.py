#!/usr/bin/env python3
"""
ERCOT SCED Dispatch Seeder v2 — CDR Direct + Polars
====================================================
Downloads NP3-965-ER directly from ERCOT CDR misdownload (no auth for download).
Uses ERCOT OAuth only for the lightweight archive listing (get docIds).
Processes with Polars instead of pandas — ~5-10x faster, no hang risk.

Usage:
  python3 seed_month_v2.py <year> <month>

Examples:
  python3 seed_month_v2.py 2026 3    # March 2026
  python3 seed_month_v2.py 2026 2    # February 2026
  python3 seed_month_v2.py 2025 12   # December 2025
"""
import sys
import os
import io
import datetime
import time
import logging
import calendar
import zipfile

import requests
import polars as pl
import psycopg2
import psycopg2.extras

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("seed_v2")

CDR_DOWNLOAD_URL = (
    "https://www.ercot.com/misdownload/servlets/mirDownload"
    "?mimic_duns=000000000&doclookupId={doc_id}"
)
ERCOT_ARCHIVE_URL = "https://api.ercot.com/api/public-reports/archive/np3-965-er"
ERCOT_TOKEN_URL = (
    "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com"
    "/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token"
)

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

PRICE_COLS = [f"SCED1 Curve-Price{i}" for i in range(1, 36)]
MW_COLS    = [f"SCED1 Curve-MW{i}"    for i in range(1, 36)]


def _get_token() -> str:
    """Fetch a fresh ERCOT Bearer token via ROPC flow."""
    client_id = os.environ["ERCOT_CLIENT_ID"]
    resp = requests.post(
        ERCOT_TOKEN_URL,
        data={
            "grant_type":    "password",
            "username":      os.environ["ERCOT_USERNAME"],
            "password":      os.environ["ERCOT_PASSWORD"],
            "client_id":     client_id,
            "scope":         f"openid {client_id} offline_access",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _get_doc_id(token: str, sub_key: str, date: datetime.date) -> str | None:
    """Return the docId for a given operational date, or None if not found."""
    post_date = date + datetime.timedelta(days=60)
    resp = requests.get(
        ERCOT_ARCHIVE_URL,
        params={
            "postDatetimeFrom": post_date.strftime("%Y-%m-%dT00:00:00"),
            "postDatetimeTo":   (post_date + datetime.timedelta(days=1)).strftime("%Y-%m-%dT00:00:00"),
            "size": 10,
            "page": 1,
        },
        headers={
            "Authorization":            f"Bearer {token}",
            "Ocp-Apim-Subscription-Key": sub_key,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        logger.warning("  Archive listing failed (%s) for %s", resp.status_code, date)
        return None
    archives = resp.json().get("data", [])
    if not archives:
        return None
    return str(archives[0]["docId"])


def _download_zip(doc_id: str) -> bytes:
    """Download the NP3-965-ER ZIP from CDR misdownload — no auth required."""
    url = CDR_DOWNLOAD_URL.format(doc_id=doc_id)
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    return resp.content


def _process_zip(raw_zip: bytes) -> pl.DataFrame | None:
    """Extract the gen-resource CSV and return an hourly-aggregated Polars DataFrame."""
    zf = zipfile.ZipFile(io.BytesIO(raw_zip))
    gen_file = next((f for f in zf.namelist() if "Gen_Resource_Data" in f), None)
    if not gen_file:
        logger.warning("  No Gen_Resource_Data file in ZIP")
        return None

    csv_bytes = zf.read(gen_file)

    needed_cols = (
        ["SCED Time Stamp", "Resource Name", "Resource Type",
         "Telemetered Net Output", "HSL", "LSL", "Base Point",
         "Start Up Cold Offer", "Start Up Hot Offer"]
        + PRICE_COLS + MW_COLS
    )

    df = pl.read_csv(
        io.BytesIO(csv_bytes),
        quote_char='"',
        infer_schema_length=0,      # treat all columns as String; we cast what we need
        null_values=["", '""'],
        truncate_ragged_lines=True,
    )

    present = [c for c in needed_cols if c in df.columns]
    df = df.select(present)

    df = df.with_columns(
        pl.col("SCED Time Stamp")
          .str.strptime(pl.Datetime("us"), "%m/%d/%Y %H:%M:%S")
          .dt.replace_time_zone("US/Central", ambiguous="earliest")
          .dt.convert_time_zone("UTC")
          .dt.truncate("1h")
          .alias("hour_utc")
    )

    present_price = [c for c in PRICE_COLS if c in df.columns]
    present_mw    = [c for c in MW_COLS    if c in df.columns]

    price_exprs = [
        pl.when(
            (pl.col(c).cast(pl.Float64, strict=False) > -250)
            & (pl.col(c).cast(pl.Float64, strict=False) < 4999)
        )
        .then(pl.col(c).cast(pl.Float64, strict=False))
        .otherwise(None)
        for c in present_price
    ]
    mw_exprs = [pl.col(c).cast(pl.Float64, strict=False) for c in present_mw]

    df = df.with_columns(
        pl.col("Telemetered Net Output").cast(pl.Float64, strict=False),
        pl.col("HSL").cast(pl.Float64, strict=False),
        pl.col("LSL").cast(pl.Float64, strict=False),
        pl.col("Base Point").cast(pl.Float64, strict=False),
        pl.col("Start Up Cold Offer").cast(pl.Float64, strict=False),
        pl.col("Start Up Hot Offer").cast(pl.Float64, strict=False),
        pl.min_horizontal(*price_exprs).alias("offer_price_min") if price_exprs else pl.lit(None).cast(pl.Float64).alias("offer_price_min"),
        pl.max_horizontal(*price_exprs).alias("offer_price_max") if price_exprs else pl.lit(None).cast(pl.Float64).alias("offer_price_max"),
        pl.max_horizontal(*mw_exprs).alias("offer_mw_total")    if mw_exprs    else pl.lit(None).cast(pl.Float64).alias("offer_mw_total"),
    )

    agg = df.group_by(["Resource Name", "Resource Type", "hour_utc"]).agg([
        pl.col("Telemetered Net Output").mean().round(2).alias("avg_mw"),
        pl.col("Telemetered Net Output").max().round(2).alias("max_mw"),
        pl.col("HSL").mean().round(2).alias("hsl"),
        pl.col("LSL").mean().round(2).alias("lsl"),
        pl.col("Base Point").mean().round(2).alias("base_point"),
        (pl.col("Telemetered Net Output") > 0).sum().cast(pl.Int32).alias("online_intervals"),
        pl.col("offer_price_min").mean().round(2).alias("offer_price_min"),
        pl.col("offer_price_max").mean().round(2).alias("offer_price_max"),
        pl.col("offer_mw_total").mean().round(2).alias("offer_mw_total"),
        pl.col("Start Up Cold Offer").mean().round(2).alias("startup_cold"),
        pl.col("Start Up Hot Offer").mean().round(2).alias("startup_hot"),
    ])

    return agg


def _insert(conn, agg: pl.DataFrame, resource_type_map: dict) -> int:
    rows = []
    for r in agg.iter_rows(named=True):
        rows.append((
            r["Resource Name"],
            r["hour_utc"],
            resource_type_map.get(str(r["Resource Type"]), "other"),
            r["avg_mw"],
            r["max_mw"],
            r["hsl"],
            r["lsl"],
            r["base_point"],
            r["online_intervals"] or 0,
            r["offer_price_min"],
            r["offer_price_max"],
            r["offer_mw_total"],
            r["startup_cold"],
            r["startup_hot"],
        ))

    with conn.cursor() as cur:
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
        cur.execute(
            "INSERT INTO ercot_dispatch_seed_log (seed_date, rows_inserted)"
            " VALUES (%s, %s)"
            " ON CONFLICT (seed_date) DO UPDATE SET rows_inserted = EXCLUDED.rows_inserted",
            (rows[0][1].date() if rows else None, len(rows)),
        )
    conn.commit()
    return len(rows)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    year  = int(sys.argv[1])
    month = int(sys.argv[2])

    start_date = datetime.date(year, month, 1)
    last_day   = calendar.monthrange(year, month)[1]
    end_date   = min(
        datetime.date(year, month, last_day),
        datetime.date.today() - datetime.timedelta(days=1),
    )

    if start_date > end_date:
        logger.error("Start %s is after end %s — nothing to seed.", start_date, end_date)
        sys.exit(0)

    logger.info("Seeding SCED v2 (CDR+Polars): %s → %s", start_date, end_date)

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("DATABASE_URL not set.")
        sys.exit(1)
    conn = psycopg2.connect(db_url)

    with conn.cursor() as cur:
        cur.execute(
            "SELECT seed_date FROM ercot_dispatch_seed_log"
            " WHERE rows_inserted > 0 AND seed_date >= %s AND seed_date <= %s",
            (start_date, end_date),
        )
        already = {r[0] for r in cur.fetchall()}

    dates_needed = []
    d = start_date
    while d <= end_date:
        if d not in already:
            dates_needed.append(d)
        d += datetime.timedelta(days=1)

    if not dates_needed:
        logger.info("All days in %d-%02d already seeded.", year, month)
        conn.close()
        sys.exit(0)

    logger.info("%d days to seed, %d already done.", len(dates_needed), len(already))

    sub_key = os.environ.get("ERCOT_SUBSCRIPTION_KEY", "")

    logger.info("Fetching ERCOT Bearer token…")
    token = _get_token()
    token_fetched_at = time.time()
    logger.info("Token acquired.")

    total_rows = 0
    errors     = 0

    for i, date in enumerate(dates_needed, 1):
        if time.time() - token_fetched_at > 50 * 60:
            logger.info("Refreshing ERCOT token…")
            token = _get_token()
            token_fetched_at = time.time()

        t0 = time.time()
        try:
            doc_id = _get_doc_id(token, sub_key, date)
            if not doc_id:
                logger.warning("[%d/%d] %s — no archive found (embargoed or missing)", i, len(dates_needed), date)
                errors += 1
                continue

            raw_zip = _download_zip(doc_id)
            agg = _process_zip(raw_zip)
            if agg is None or agg.is_empty():
                logger.warning("[%d/%d] %s — empty after processing", i, len(dates_needed), date)
                errors += 1
                continue

            n = _insert(conn, agg, RESOURCE_TYPE_MAP)
            total_rows += n
            elapsed = time.time() - t0
            logger.info("[%d/%d] %s — %d rows in %.1fs  (docId=%s)", i, len(dates_needed), date, n, elapsed, doc_id)

        except requests.Timeout:
            logger.warning("[%d/%d] %s — HTTP timeout — skipping", i, len(dates_needed), date)
            errors += 1
        except Exception as e:
            logger.warning("[%d/%d] %s — error: %s — skipping", i, len(dates_needed), date, e)
            errors += 1

        time.sleep(0.3)

    conn.close()
    logger.info(
        "Done: %d/%d days seeded, %d rows inserted, %d errors.",
        len(dates_needed) - errors, len(dates_needed), total_rows, errors,
    )


if __name__ == "__main__":
    main()
