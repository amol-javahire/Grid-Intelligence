#!/usr/bin/env python3
"""
seed-sced-gap.py — SCED gap-fill seeder. Hits ERCOT API directly (no gridstatus).
Streams ZIP → parses CSV with Polars → inserts hourly aggregates.
No pandas. No OOM.

Usage:
    python3 infra/seed-sced-gap.py [START_DATE] [END_DATE]

Defaults to 2025-12-06 → today-60d (SCED published 60 days after data date).
Skips dates already in ercot_dispatch_seed_log. Safe to re-run (idempotent).
"""
import datetime, io, os, sys, time, logging, zipfile
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

DEFAULT_START = datetime.date(2025, 12, 6)
DEFAULT_END   = datetime.date.today() - datetime.timedelta(days=60)  # SCED 60-day lag

START = datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_START
END   = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_END

RESOURCE_TYPE_MAP = {
    "WIND": "wind", "SOLAR": "solar", "GAS": "gas",
    "COAL": "coal", "NUCLEAR": "nuclear", "HYDRO": "hydro",
    "STORAGE": "storage", "OTHER": "other",
}

# ── ERCOT Auth ────────────────────────────────────────────────────────────────
_token_cache = {"token": None, "expires": 0}

def get_token() -> str:
    if _token_cache["token"] and time.time() < _token_cache["expires"] - 60:
        return _token_cache["token"]
    # ERCOT uses their own B2C tenant with ROPC flow
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
    _token_cache["expires"] = time.time() + j.get("expires_in", 3600)
    return _token_cache["token"]

def ercot_headers() -> dict:
    h = {"Authorization": f"Bearer {get_token()}"}
    if ERCOT_SUB_KEY:
        h["Ocp-Apim-Subscription-Key"] = ERCOT_SUB_KEY
    return h

# ── ERCOT API ─────────────────────────────────────────────────────────────────
BASE = "https://api.ercot.com/api/public-reports/archive/np3-965-er"

def list_archives(post_date: datetime.date) -> list[str]:
    """Return docIds published on post_date (data_date + ~60 days)."""
    next_day = post_date + datetime.timedelta(days=1)
    resp = requests.get(BASE, headers=ercot_headers(), params={
        "postDatetimeFrom": post_date.isoformat() + "T00:00:00",
        "postDatetimeTo":   next_day.isoformat()  + "T00:00:00",
        "size": 1000, "page": 1,
    }, timeout=30)
    resp.raise_for_status()
    docs = resp.json().get("data", {}).get("docIds", [])
    return docs if isinstance(docs, list) else []

def download_zip(doc_ids: list[str]) -> bytes:
    """Download a batch of docIds as a single ZIP (streamed into memory)."""
    resp = requests.get(
        BASE + "/download",
        headers=ercot_headers(),
        params={"docIds": ",".join(doc_ids)},
        timeout=120,
        stream=True,
    )
    resp.raise_for_status()
    buf = io.BytesIO()
    for chunk in resp.iter_content(chunk_size=1 << 20):  # 1 MB chunks
        buf.write(chunk)
    buf.seek(0)
    return buf

# ── Processing ────────────────────────────────────────────────────────────────
def aggregate_day(csv_bytes: bytes, data_date: datetime.date) -> pl.DataFrame:
    """Parse raw SCED CSV, aggregate to hourly rows. Pure Polars."""
    df = pl.read_csv(io.BytesIO(csv_bytes), infer_schema_length=1000)

    # Find timestamp column (varies by file vintage)
    ts_col = next((c for c in df.columns if "Timestamp" in c or "timestamp" in c), None)
    if ts_col is None:
        raise ValueError(f"No timestamp column found. Columns: {df.columns}")

    df = df.with_columns(
        pl.col(ts_col).cast(pl.Utf8).str.to_datetime(format=None, strict=False)
          .dt.truncate("1h").alias("hour")
    )

    # Find key columns (handle minor naming variations)
    def col(candidates):
        for c in candidates:
            if c in df.columns:
                return pl.col(c)
        raise ValueError(f"None of {candidates} found in {df.columns}")

    agg = df.group_by([
        col(["ResourceName", "RESOURCE_NAME", "resourceName"]).alias("resource_name"),
        col(["ResourceType", "RESOURCE_TYPE", "resourceType"]).alias("resource_type"),
        "hour",
    ]).agg([
        col(["OutputMW",    "OUTPUT_MW",    "outputMW"]).mean().alias("avg_mw"),
        col(["OutputMW",    "OUTPUT_MW",    "outputMW"]).max().alias("max_mw"),
        col(["HSLMw",       "HSL_MW",       "hslMw"]).mean().alias("hsl"),
        col(["LSLMw",       "LSL_MW",       "lslMw"]).mean().alias("lsl"),
        col(["BasePointMW", "BASE_POINT_MW","basePointMW"]).mean().alias("base_point"),
        col(["OutputMW",    "OUTPUT_MW",    "outputMW"]).count().alias("online_intervals"),
    ])

    return agg


def _log_date(conn, date, n, cur=None):
    sql = ("INSERT INTO ercot_dispatch_seed_log (seed_date, rows_inserted) "
           "VALUES (%s, %s) ON CONFLICT (seed_date) DO UPDATE SET rows_inserted=%s, seeded_at=now()")
    if cur:
        cur.execute(sql, (date, n, n))
    else:
        with conn.cursor() as c:
            c.execute(sql, (date, n, n))
        conn.commit()


def seed_day(conn, data_date: datetime.date) -> int:
    post_date = data_date + datetime.timedelta(days=60)
    t0 = time.time()

    try:
        doc_ids = list_archives(post_date)
    except Exception as e:
        log.warning(f"  {data_date}: archive list error — {e}")
        _log_date(conn, data_date, -1)
        return -1

    if not doc_ids:
        log.warning(f"  {data_date}: no archives found (post_date={post_date}) — skipping")
        _log_date(conn, data_date, 0)
        return 0

    log.info(f"  {data_date}: {len(doc_ids)} archive(s), post_date={post_date}")

    try:
        zip_buf = download_zip(doc_ids)
    except Exception as e:
        log.warning(f"  {data_date}: download error — {e}")
        _log_date(conn, data_date, -1)
        return -1

    all_rows = []
    with zipfile.ZipFile(zip_buf) as zf:
        for name in zf.namelist():
            if not name.endswith(".csv"):
                continue
            csv_bytes = zf.read(name)
            try:
                agg = aggregate_day(csv_bytes, data_date)
                all_rows.extend([
                    (
                        row["resource_name"],
                        row["hour"],
                        RESOURCE_TYPE_MAP.get(str(row["resource_type"]).upper(), "other"),
                        row["avg_mw"],
                        row["max_mw"],
                        row["hsl"],
                        row["lsl"],
                        row["base_point"],
                        int(row["online_intervals"]) if row["online_intervals"] else 0,
                    )
                    for row in agg.to_dicts()
                ])
            except Exception as e:
                log.warning(f"  {data_date}: parse error in {name} — {e}")

    if not all_rows:
        _log_date(conn, data_date, 0)
        return 0

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
            all_rows,
            page_size=500,
        )
        _log_date(conn, data_date, len(all_rows), cur)
    conn.commit()

    log.info(f"  {data_date}: {len(all_rows):,} rows in {time.time()-t0:.1f}s")
    return len(all_rows)


# ── Main ──────────────────────────────────────────────────────────────────────
def get_seeded(conn) -> set:
    with conn.cursor() as cur:
        cur.execute("SELECT seed_date FROM ercot_dispatch_seed_log")
        return {r[0] for r in cur.fetchall()}


def main():
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
        n = seed_day(conn, date)
        if n > 0:
            total += n
        elif n < 0:
            errors += 1
        time.sleep(0.3)

    conn.close()
    log.info(f"\n=== DONE === {total:,} rows inserted | {errors} errors")


if __name__ == "__main__":
    main()
