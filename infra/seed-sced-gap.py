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

# Positional date args, ignoring any --flags (and their values) so that
# `--inspect 2026-03-15` isn't parsed here as a START date.
_pos_args = [a for a in sys.argv[1:] if not a.startswith("--")]
if "--inspect" in sys.argv:
    # --inspect consumes the date that follows it; it is not a range bound.
    _i = sys.argv.index("--inspect")
    if _i + 1 < len(sys.argv) and sys.argv[_i + 1] in _pos_args:
        _pos_args.remove(sys.argv[_i + 1])

START = datetime.date.fromisoformat(_pos_args[0]) if len(_pos_args) > 0 else DEFAULT_START
END   = datetime.date.fromisoformat(_pos_args[1]) if len(_pos_args) > 1 else DEFAULT_END

# ERCOT resource-type CODES → readable category.
#
# These are ERCOT's actual codes from 60d_SCED_Gen_Resource_Data, NOT generic
# words. An earlier version of this map used {"SOLAR","GAS","COAL","NUCLEAR",
# "STORAGE"} — none of which ERCOT ever emits — so every resource except WIND
# and HYDRO silently fell through to "other". That collapsed all 2026 data into
# 3 fuel types (896 resources / 122,069 GWh dumped in "other") while 2024–2025,
# seeded by scripts/src/seed-ercot-dispatch.py, stayed correct at 8 types.
#
# Kept deliberately IDENTICAL to seed-ercot-dispatch.py's map, including the
# "natural_gas" spelling (not "gas") — the two seeders write to the same table
# and must share one vocabulary. Change both together or not at all.
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

# Codes seen in the data but absent from the map above. Tracked so an ERCOT
# vocabulary change fails LOUDLY next time instead of quietly inflating "other".
_unmapped_types: dict[str, int] = {}


def map_resource_type(raw) -> str:
    code = str(raw).strip().upper()
    mapped = RESOURCE_TYPE_MAP.get(code)
    if mapped is None:
        _unmapped_types[code] = _unmapped_types.get(code, 0) + 1
        return "other"
    return mapped

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
    _token_cache["expires"] = time.time() + int(j.get("expires_in", 3600))
    return _token_cache["token"]

def ercot_headers() -> dict:
    h = {"Authorization": f"Bearer {get_token()}"}
    if ERCOT_SUB_KEY:
        h["Ocp-Apim-Subscription-Key"] = ERCOT_SUB_KEY
    return h

# ── ERCOT API ─────────────────────────────────────────────────────────────────
BASE = "https://api.ercot.com/api/public-reports/archive/np3-965-er"

def list_archives(post_date: datetime.date) -> list[int]:
    """Return docIds published on post_date (data_date + ~60 days)."""
    next_day = post_date + datetime.timedelta(days=1)
    resp = requests.get(BASE, headers=ercot_headers(), params={
        "postDatetimeFrom": post_date.isoformat() + "T00:00:00",
        "postDatetimeTo":   next_day.isoformat()  + "T00:00:00",
        "size": 1000, "page": 1,
    }, timeout=30)
    resp.raise_for_status()
    archives = resp.json().get("archives", [])
    return [item["docId"] for item in archives if "docId" in item]

def download_zip(doc_id: int) -> io.BytesIO:
    """Download a single archive by docId (streamed). Returns BytesIO."""
    resp = requests.get(
        BASE,
        headers=ercot_headers(),
        params={"download": doc_id},
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
    """Parse raw SCED Gen Resource CSV, aggregate to hourly rows. Pure Polars."""
    df = pl.read_csv(
        io.BytesIO(csv_bytes),
        infer_schema_length=10000,
        ignore_errors=True,
    )

    # Find timestamp column
    ts_col = next(
        (c for c in df.columns if "Timestamp" in c or "timestamp" in c or "Time Stamp" in c),
        None,
    )
    if ts_col is None:
        raise ValueError(f"No timestamp column found. Columns: {df.columns}")

    # Find required columns — ERCOT uses spaced names e.g. "Resource Name"
    def find_col(candidates):
        for c in candidates:
            if c in df.columns:
                return pl.col(c)
        raise ValueError(f"None of {candidates} found in {df.columns}")

    output_col = find_col([
        "Telemetered Net Output", "OutputMW", "OUTPUT_MW", "outputMW",
    ])
    name_col   = find_col(["Resource Name", "ResourceName", "RESOURCE_NAME"])
    type_col   = find_col(["Resource Type", "ResourceType", "RESOURCE_TYPE"])
    hsl_col    = find_col(["HSL", "HSLMw", "HSL_MW"])
    lsl_col    = find_col(["LSL", "LSLMw", "LSL_MW"])
    bp_col     = find_col(["Base Point", "BasePointMW", "BASE_POINT_MW"])

    # Try common ERCOT timestamp formats — format varies by file vintage
    ts_expr = pl.col(ts_col).cast(pl.Utf8)
    parsed = None
    for fmt in ["%m/%d/%Y %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", None]:
        try:
            sample = df.select(ts_expr.str.to_datetime(format=fmt, strict=True)).drop_nulls()
            if len(sample) > 0:
                parsed = ts_expr.str.to_datetime(format=fmt, strict=False)
                break
        except Exception:
            continue
    if parsed is None:
        raise ValueError(f"Could not parse timestamp column '{ts_col}'")

    df = df.with_columns(
        parsed.dt.truncate("1h").alias("hour"),
        output_col.cast(pl.Float64).alias("_output"),
        hsl_col.cast(pl.Float64).alias("_hsl"),
        lsl_col.cast(pl.Float64).alias("_lsl"),
        bp_col.cast(pl.Float64).alias("_bp"),
    )

    agg = df.group_by([
        name_col.alias("resource_name"),
        type_col.alias("resource_type"),
        "hour",
    ]).agg([
        pl.col("_output").mean().alias("avg_mw"),
        pl.col("_output").max().alias("max_mw"),
        pl.col("_hsl").mean().alias("hsl"),
        pl.col("_lsl").mean().alias("lsl"),
        pl.col("_bp").mean().alias("base_point"),
        pl.col("_output").count().alias("online_intervals"),
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

    all_rows = []
    for doc_id in doc_ids:
        try:
            zip_buf = download_zip(doc_id)
        except Exception as e:
            log.warning(f"  {data_date}: download error (docId={doc_id}) — {e}")
            continue

        with zipfile.ZipFile(zip_buf) as zf:
            for name in zf.namelist():
                # Only process the Gen Resource dispatch file
                if "Gen_Resource_Data" not in name or not name.endswith(".csv"):
                    continue
                csv_bytes = zf.read(name)
                try:
                    agg = aggregate_day(csv_bytes, data_date)
                    all_rows.extend([
                        (
                            row["resource_name"],
                            row["hour"],
                            map_resource_type(row["resource_type"]),
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


def inspect_day(data_date: datetime.date) -> None:
    """
    Read-only: download one day's SCED archive and report what is ACTUALLY in
    the raw ERCOT file — every distinct Resource Type code with row counts and
    MW, plus the file list inside the ZIP and the detected column names.

    Written 2026-08-02 because storage (PWRSTR) went missing entirely from the
    2026 seed: the backfill arithmetic showed 896 'other' resources resolving
    into gas/solar/coal/nuclear with ZERO batteries, meaning they were never
    ingested rather than merely mislabelled. Nothing in the seeder filters them
    out, so the question is what the source file contains.

    Usage: python infra/seed-sced-gap.py --inspect 2026-03-15
    """
    post_date = data_date + datetime.timedelta(days=60)
    log.info(f"Inspecting data_date={data_date} (published ~{post_date})")

    doc_ids = list_archives(post_date)
    if not doc_ids:
        log.error(f"No archives published on {post_date}. Try a different date.")
        return
    log.info(f"{len(doc_ids)} archive(s) found; reading the first")

    zip_buf = download_zip(doc_ids[0])
    with zipfile.ZipFile(zip_buf) as zf:
        names = zf.namelist()
        log.info(f"--- {len(names)} file(s) in archive ---")
        for n in names:
            log.info(f"    {n}")

        target = [n for n in names if "Gen_Resource_Data" in n and n.endswith(".csv")]
        if not target:
            log.error("No Gen_Resource_Data CSV in this archive.")
            return

        df = pl.read_csv(io.BytesIO(zf.read(target[0])),
                         infer_schema_length=10000, ignore_errors=True)

    log.info(f"--- columns ({len(df.columns)}) ---")
    for c in df.columns:
        log.info(f"    {c}")

    type_col = next((c for c in ["Resource Type", "ResourceType", "RESOURCE_TYPE"]
                     if c in df.columns), None)
    if type_col is None:
        log.error("No Resource Type column found.")
        return

    out_col = next((c for c in ["Telemetered Net Output", "OutputMW", "OUTPUT_MW", "outputMW"]
                    if c in df.columns), None)

    log.info("--- DISTINCT Resource Type codes in the raw file ---")
    summary = (df.group_by(type_col)
                 .agg([pl.len().alias("rows")])
                 .sort("rows", descending=True))
    for row in summary.iter_rows(named=True):
        code = str(row[type_col])
        mapped = RESOURCE_TYPE_MAP.get(code.strip().upper(), "*** UNMAPPED -> other ***")
        log.info(f"    {code:<12} {row['rows']:>10,} rows   → {mapped}")

    if out_col:
        nulls = df.select(pl.col(out_col).is_null().sum()).item()
        log.info(f"--- '{out_col}': {nulls:,} null of {len(df):,} rows ---")


def main():
    # --inspect <YYYY-MM-DD>: read-only source check, no DB writes.
    if "--inspect" in sys.argv:
        i = sys.argv.index("--inspect")
        if i + 1 >= len(sys.argv):
            log.error("--inspect requires a date, e.g. --inspect 2026-03-15")
            sys.exit(1)
        inspect_day(datetime.date.fromisoformat(sys.argv[i + 1]))
        return

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

    # Fail loudly on unrecognised resource-type codes. Silently bucketing these
    # into "other" is exactly what corrupted the 2026 gen stack.
    if _unmapped_types:
        log.warning("=" * 62)
        log.warning("UNMAPPED resource_type codes — these all became 'other':")
        for code, n in sorted(_unmapped_types.items(), key=lambda kv: -kv[1]):
            log.warning(f"    {code:<12} {n:>10,} rows")
        log.warning("Add them to RESOURCE_TYPE_MAP (and keep it in sync with")
        log.warning("scripts/src/seed-ercot-dispatch.py), then re-seed those dates.")
        log.warning("=" * 62)
    else:
        log.info("All resource_type codes mapped cleanly.")


if __name__ == "__main__":
    main()
