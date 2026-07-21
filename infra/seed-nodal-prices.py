#!/usr/bin/env python3
"""
seed-nodal-prices.py — ERCOT DA and RT hourly settlement point prices for all resource nodes.

DA:  np4-190-cd — DAM Settlement Point Prices (hourly, ~950 nodes/day)
RT:  np6-905-cd — Settlement Point Prices at Resource Nodes (15-min → aggregated to hourly)

Stores in: ercot_node_prices (node_name, hour, da_price, rt_price)
Logs in:   ercot_price_seed_log (seed_date, price_type, rows_inserted)

Usage:
    python3 infra/seed-nodal-prices.py [da|rt|both] [START_DATE] [END_DATE]

Defaults: both, 2025-01-01 → yesterday
Safe to re-run (idempotent — skips already-seeded dates).
"""
import datetime, io, os, sys, time, logging, zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import polars as pl
import psycopg2, psycopg2.extras

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# ── Env ──────────────────────────────────────────────────────────────────────
DATABASE_URL    = os.environ["DATABASE_URL"]
ERCOT_USERNAME  = os.environ["ERCOT_USERNAME"]
ERCOT_PASSWORD  = os.environ["ERCOT_PASSWORD"]
ERCOT_SUB_KEY   = os.environ.get("ERCOT_SUBSCRIPTION_KEY", "")
ERCOT_CLIENT_ID = os.environ.get("ERCOT_CLIENT_ID", "fec253ea-0d06-4272-a5e6-b478baeecd70")

MODE  = sys.argv[1] if len(sys.argv) > 1 else "both"   # da | rt | both
START = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else datetime.date(2025, 1, 1)
END   = datetime.date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else datetime.date.today() - datetime.timedelta(days=1)

DA_ENDPOINT = "np4-190-cd"
RT_ENDPOINT = "np6-905-cd"

# ── Auth ─────────────────────────────────────────────────────────────────────
_token_cache = {"token": None, "expires": 0}

def get_token() -> str:
    if _token_cache["token"] and time.time() < _token_cache["expires"] - 60:
        return _token_cache["token"]
    resp = requests.post(
        "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/oauth2/v2.0/token"
        "?p=B2C_1_PUBAPI-ROPC-FLOW",
        data={
            "grant_type":    "password",
            "client_id":     ERCOT_CLIENT_ID,
            "username":      ERCOT_USERNAME,
            "password":      ERCOT_PASSWORD,
            "response_type": "id_token",
            "scope":         f"openid {ERCOT_CLIENT_ID} offline_access",
        },
        timeout=30,
    )
    resp.raise_for_status()
    j = resp.json()
    _token_cache["token"]   = j.get("access_token") or j.get("id_token")
    _token_cache["expires"] = time.time() + int(j.get("expires_in", 3600))
    return _token_cache["token"]

def headers() -> dict:
    h = {"Authorization": f"Bearer {get_token()}"}
    if ERCOT_SUB_KEY:
        h["Ocp-Apim-Subscription-Key"] = ERCOT_SUB_KEY
    return h

BASE = "https://api.ercot.com/api/public-reports/archive"

# ── API helpers ───────────────────────────────────────────────────────────────
def list_archives(endpoint: str, from_dt: datetime.date, to_dt: datetime.date) -> list[int]:
    doc_ids = []
    page = 1
    while True:
        resp = requests.get(f"{BASE}/{endpoint}", headers=headers(), params={
            "postDatetimeFrom": from_dt.isoformat() + "T00:00:00",
            "postDatetimeTo":   to_dt.isoformat()   + "T00:00:00",
            "size": 1000, "page": page,
        }, timeout=30)
        resp.raise_for_status()
        j = resp.json()
        archives = j.get("archives", [])
        doc_ids.extend(item["docId"] for item in archives if "docId" in item)
        meta = j.get("_meta", {})
        if page >= meta.get("totalPages", 1):
            break
        page += 1
    return doc_ids

def download_zip(endpoint: str, doc_id: int) -> io.BytesIO:
    resp = requests.get(f"{BASE}/{endpoint}", headers=headers(),
                        params={"download": doc_id}, timeout=120, stream=True)
    resp.raise_for_status()
    buf = io.BytesIO()
    for chunk in resp.iter_content(chunk_size=1 << 20):
        buf.write(chunk)
    buf.seek(0)
    return buf

def read_csv_from_zip(endpoint: str, doc_id: int) -> pl.DataFrame | None:
    try:
        buf = download_zip(endpoint, doc_id)
        with zipfile.ZipFile(buf) as zf:
            for name in zf.namelist():
                if name.endswith(".csv"):
                    return pl.read_csv(io.BytesIO(zf.read(name)),
                                       infer_schema_length=5000, ignore_errors=True)
    except Exception as e:
        log.warning(f"  download/parse error docId={doc_id}: {e}")
    return None

# ── DA processing ─────────────────────────────────────────────────────────────
def parse_da(df: pl.DataFrame) -> pl.DataFrame:
    """Parse DA CSV → (node_name, hour, da_price). HourEnding 1-24 → hour 0-23."""
    return (
        df
        .with_columns([
            pl.col("HourEnding").str.slice(0, 2).cast(pl.Int32).alias("_he"),
            pl.col("DeliveryDate").str.to_date(format="%m/%d/%Y").cast(pl.Datetime).alias("_date"),
            pl.col("SettlementPointPrice").cast(pl.Float64).alias("da_price"),
            pl.col("SettlementPoint").alias("node_name"),
        ])
        .with_columns([
            (pl.col("_date") + pl.duration(hours=(pl.col("_he") - 1))).alias("hour")
        ])
        .select(["node_name", "hour", "da_price"])
        .drop_nulls()
    )

def seed_da_day(conn, data_date: datetime.date) -> int:
    """Seed DA prices for one delivery date."""
    # DA is posted the day before delivery
    post_from = data_date - datetime.timedelta(days=1)
    post_to   = data_date

    try:
        doc_ids = list_archives(DA_ENDPOINT, post_from, post_to)
    except Exception as e:
        log.warning(f"  DA {data_date}: archive list error — {e}")
        return -1

    if not doc_ids:
        log.warning(f"  DA {data_date}: no archives found")
        _log(conn, data_date, "DA", 0)
        return 0

    all_rows = []
    for doc_id in doc_ids:
        df = read_csv_from_zip(DA_ENDPOINT, doc_id)
        if df is None:
            continue
        try:
            parsed = parse_da(df)
            # Filter to this delivery date only
            target = pl.lit(datetime.datetime.combine(data_date, datetime.time(0)))
            parsed = parsed.filter(
                pl.col("hour").dt.date() == pl.lit(data_date)
            )
            all_rows.extend(parsed.to_dicts())
        except Exception as e:
            log.warning(f"  DA {data_date}: parse error — {e}")

    return _upsert_da(conn, data_date, all_rows)

def _upsert_da(conn, date, rows) -> int:
    if not rows:
        _log(conn, date, "DA", 0)
        return 0
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO ercot_node_prices (node_name, hour, da_price)
               VALUES %s
               ON CONFLICT (node_name, hour) DO UPDATE SET da_price = EXCLUDED.da_price""",
            [(r["node_name"], r["hour"], r["da_price"]) for r in rows],
            page_size=1000,
        )
        _log(conn, date, "DA", len(rows), cur)
    conn.commit()
    return len(rows)

# ── RT processing ─────────────────────────────────────────────────────────────
def parse_rt(df: pl.DataFrame) -> pl.DataFrame:
    """Parse RT CSV → (node_name, hour, rt_price). DeliveryHour 1-24 → hour 0-23."""
    return (
        df
        .with_columns([
            pl.col("DeliveryHour").cast(pl.Int32).alias("_dh"),
            pl.col("DeliveryDate").str.to_date(format="%m/%d/%Y").cast(pl.Datetime).alias("_date"),
            pl.col("SettlementPointPrice").cast(pl.Float64).alias("rt_price"),
            pl.col("SettlementPointName").alias("node_name"),
        ])
        .with_columns([
            (pl.col("_date") + pl.duration(hours=(pl.col("_dh") - 1))).alias("hour")
        ])
        .select(["node_name", "hour", "rt_price"])
        .drop_nulls()
    )

def seed_rt_day(conn, data_date: datetime.date) -> int:
    """Seed RT prices for one delivery date. Downloads all 15-min files, aggregates to hourly."""
    post_from = data_date
    post_to   = data_date + datetime.timedelta(days=1)

    try:
        doc_ids = list_archives(RT_ENDPOINT, post_from, post_to)
    except Exception as e:
        log.warning(f"  RT {data_date}: archive list error — {e}")
        return -1

    if not doc_ids:
        log.warning(f"  RT {data_date}: no archives found")
        _log(conn, data_date, "RT", 0)
        return 0

    log.info(f"  RT {data_date}: {len(doc_ids)} interval files")

    # Download files concurrently (max 8 threads)
    frames = []
    def fetch(doc_id):
        return read_csv_from_zip(RT_ENDPOINT, doc_id)

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch, d): d for d in doc_ids}
        for fut in as_completed(futures):
            df = fut.result()
            if df is not None:
                try:
                    frames.append(parse_rt(df))
                except Exception as e:
                    log.warning(f"  RT parse error: {e}")

    if not frames:
        _log(conn, data_date, "RT", 0)
        return 0

    # Aggregate all 15-min intervals → hourly mean
    combined = pl.concat(frames)
    hourly = (
        combined
        .filter(pl.col("hour").dt.date() == pl.lit(data_date))
        .group_by(["node_name", "hour"])
        .agg(pl.col("rt_price").mean())
    )

    rows = hourly.to_dicts()
    return _upsert_rt(conn, data_date, rows)

def _upsert_rt(conn, date, rows) -> int:
    if not rows:
        _log(conn, date, "RT", 0)
        return 0
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO ercot_node_prices (node_name, hour, rt_price)
               VALUES %s
               ON CONFLICT (node_name, hour) DO UPDATE SET rt_price = EXCLUDED.rt_price""",
            [(r["node_name"], r["hour"], r["rt_price"]) for r in rows],
            page_size=1000,
        )
        _log(conn, date, "RT", len(rows), cur)
    conn.commit()
    return len(rows)

# ── DB helpers ────────────────────────────────────────────────────────────────
def setup_tables(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ercot_node_prices (
                node_name TEXT        NOT NULL,
                hour      TIMESTAMP   NOT NULL,
                da_price  DOUBLE PRECISION,
                rt_price  DOUBLE PRECISION,
                PRIMARY KEY (node_name, hour)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ercot_price_seed_log (
                seed_date  DATE    NOT NULL,
                price_type TEXT    NOT NULL,
                rows_inserted INTEGER,
                seeded_at  TIMESTAMP DEFAULT now(),
                PRIMARY KEY (seed_date, price_type)
            )
        """)
    conn.commit()

def get_seeded(conn, price_type: str) -> set:
    with conn.cursor() as cur:
        cur.execute("SELECT seed_date FROM ercot_price_seed_log WHERE price_type=%s", (price_type,))
        return {r[0] for r in cur.fetchall()}

def _log(conn, date, price_type, n, cur=None):
    sql = ("INSERT INTO ercot_price_seed_log (seed_date, price_type, rows_inserted) "
           "VALUES (%s, %s, %s) ON CONFLICT (seed_date, price_type) "
           "DO UPDATE SET rows_inserted=%s, seeded_at=now()")
    if cur:
        cur.execute(sql, (date, price_type, n, n))
    else:
        with conn.cursor() as c:
            c.execute(sql, (date, price_type, n, n))
        conn.commit()

# ── Main ──────────────────────────────────────────────────────────────────────
def run_mode(conn, price_type: str, seed_fn):
    seeded = get_seeded(conn, price_type)
    dates = [START + datetime.timedelta(days=i)
             for i in range((END - START).days + 1)
             if (START + datetime.timedelta(days=i)) not in seeded]

    log.info(f"{price_type}: {len(dates)} days to seed ({START} → {END})")
    total, errors = 0, 0
    for i, date in enumerate(dates):
        t0 = time.time()
        log.info(f"[{price_type} {i+1}/{len(dates)}] {date}")
        n = seed_fn(conn, date)
        if n > 0:
            log.info(f"  {price_type} {date}: {n:,} rows in {time.time()-t0:.1f}s")
            total += n
        elif n < 0:
            errors += 1
        time.sleep(0.1)

    log.info(f"{price_type} done: {total:,} rows | {errors} errors")
    return total

def main():
    conn = psycopg2.connect(DATABASE_URL)
    setup_tables(conn)

    if MODE in ("da", "both"):
        run_mode(conn, "DA", seed_da_day)
    if MODE in ("rt", "both"):
        run_mode(conn, "RT", seed_rt_day)

    conn.close()
    log.info("=== ALL DONE ===")

if __name__ == "__main__":
    main()
