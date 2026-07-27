#!/usr/bin/env python3
"""
seed-caiso-nodal.py — CAISO hourly nodal DA + RT prices for ALL apnodes.

Mirrors infra/seed-nodal-prices.py (the ERCOT seeder): direct API, streaming
ZIP, pure Polars parsing, batched upsert, idempotent per-date seed log.

Source: CAISO OASIS SingleZip (public, no auth).
  DA  → queryname=PRC_LMP        market_run_id=DAM   (hourly already)
  RT  → queryname=PRC_HASP_LMP   market_run_id=HASP  (15-min → averaged hourly)

Output is ALWAYS hourly — 5-minute data is never stored. The RT source report
is configurable (--rt-query) because payload size at ALL_APNODES scope differs
enormously between the 15-min HASP and 5-min RTM feeds; run
infra/probe-caiso-oasis.py first to confirm which one CAISO will serve.

Usage:
    python3 infra/seed-caiso-nodal.py [da|rt|both] [START] [END]
    python3 infra/seed-caiso-nodal.py rt 2025-01-01 2025-03-31 --rt-query PRC_INTVL_LMP

Defaults: both, 2025-01-01 → yesterday.
"""
import datetime, io, os, sys, time, logging, zipfile
import requests
import polars as pl
import psycopg2, psycopg2.extras

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]

BASE = "http://oasis.caiso.com/oasisapi/SingleZip"
HEADERS = {"User-Agent": "Mozilla/5.0 (grid-intelligence seeder)"}

# OASIS throttles hard and will 429 / silently truncate if pushed.
MIN_INTERVAL = 6.0          # seconds between requests
MAX_RETRIES  = 5

# ── args ─────────────────────────────────────────────────────────────────────
argv = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a.split("=")[0]: (a.split("=")[1] if "=" in a else True)
         for a in sys.argv[1:] if a.startswith("--")}

MODE  = argv[0] if len(argv) > 0 else "both"
START = datetime.date.fromisoformat(argv[1]) if len(argv) > 1 else datetime.date(2025, 1, 1)
END   = datetime.date.fromisoformat(argv[2]) if len(argv) > 2 else datetime.date.today() - datetime.timedelta(days=1)

RT_QUERY  = flags.get("--rt-query", "PRC_HASP_LMP")
RT_MARKET = flags.get("--rt-market", "HASP")
RT_VERSION = flags.get("--rt-version", "1")

_last = {"t": 0.0}

def throttle():
    dt = time.time() - _last["t"]
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last["t"] = time.time()


def gmt_window(d: datetime.date) -> tuple[str, str]:
    """CAISO wants GMT. Pacific midnight is 08:00Z in PST, 07:00Z in PDT.
    US DST 2025+: second Sunday of March → first Sunday of November."""
    def _dst(dd: datetime.date) -> bool:
        mar = datetime.date(dd.year, 3, 8)
        start = mar + datetime.timedelta(days=(6 - mar.weekday()) % 7)      # 2nd Sun Mar
        nov = datetime.date(dd.year, 11, 1)
        end = nov + datetime.timedelta(days=(6 - nov.weekday()) % 7)        # 1st Sun Nov
        return start <= dd < end
    off_s = 7 if _dst(d) else 8
    nxt = d + datetime.timedelta(days=1)
    off_e = 7 if _dst(nxt) else 8
    return (f"{d:%Y%m%d}T{off_s:02d}:00-0000", f"{nxt:%Y%m%d}T{off_e:02d}:00-0000")


def fetch_csv(params: dict, label: str) -> str | None:
    """GET with throttle + backoff. Returns CSV text, or None."""
    for attempt in range(MAX_RETRIES):
        throttle()
        try:
            r = requests.get(BASE, params=params, headers=HEADERS, timeout=300)
        except Exception as e:
            log.warning(f"  {label}: request error {e} (attempt {attempt+1})")
            time.sleep(min(60, 2 ** attempt * 5)); continue

        if r.status_code in (429, 500, 502, 503, 504):
            wait = min(120, 2 ** attempt * 10)
            log.info(f"  {label}: HTTP {r.status_code} — backoff {wait}s")
            time.sleep(wait); continue
        if r.status_code != 200 or not r.content:
            log.warning(f"  {label}: HTTP {r.status_code}, {len(r.content)} bytes")
            return None
        if r.content[:2] != b"PK":
            # OASIS returns XML on error (throttle notice, no data, bad params)
            snippet = r.text[:300].replace("\n", " ")
            log.warning(f"  {label}: non-ZIP response — {snippet}")
            if "throttl" in snippet.lower() or "MAX_REQUEST" in snippet:
                time.sleep(60); continue
            return None

        try:
            with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                for name in zf.namelist():
                    if name.lower().endswith(".csv"):
                        return zf.read(name).decode("utf-8", "replace")
                    if name.lower().endswith(".xml"):
                        log.warning(f"  {label}: XML payload (no data?) {zf.read(name)[:200]}")
            return None
        except Exception as e:
            log.warning(f"  {label}: zip error {e}")
            return None
    return None


def parse_lmp(csv_text: str, price_col_name: str) -> pl.DataFrame | None:
    """CAISO LMP CSV → (node_name, hour, price) hourly means. Pure Polars.

    OASIS splits LMP into components via LMP_TYPE (LMP / MCE / MCC / MCL);
    we keep only the total LMP. The price lives in the MW column (CAISO's
    naming, not a mistake). Times come as ISO-8601 with offset in
    INTERVALSTARTTIME_GMT — converted to America/Los_Angeles then truncated
    to the hour so 15-min and 5-min feeds both roll up correctly.
    """
    df = pl.read_csv(io.StringIO(csv_text), infer_schema_length=5000, ignore_errors=True)
    cols = {c.upper(): c for c in df.columns}

    node_c = next((cols[c] for c in ("NODE", "NODE_ID", "PNODE_RESMRID", "NODE_ID_XML") if c in cols), None)
    time_c = next((cols[c] for c in ("INTERVALSTARTTIME_GMT", "INTERVAL_START_GMT", "OPR_INTERVAL_START") if c in cols), None)
    val_c  = next((cols[c] for c in ("MW", "VALUE", "PRICE", "LMP") if c in cols), None)
    type_c = next((cols[c] for c in ("LMP_TYPE", "XML_DATA_ITEM", "DATA_ITEM") if c in cols), None)
    if not (node_c and time_c and val_c):
        log.warning(f"  column detection failed — have {df.columns[:12]}")
        return None

    # Keep only the total LMP component.
    if type_c:
        vals = set(df[type_c].unique().to_list())
        keep = None
        for cand in ("LMP", "LMP_PRC"):
            if cand in vals:
                keep = cand; break
        if keep is None:
            keep = next((v for v in vals if isinstance(v, str) and v.upper().endswith("LMP_PRC")), None)
        if keep is not None:
            df = df.filter(pl.col(type_c) == keep)

    out = (
        df.with_columns([
            pl.col(node_c).cast(pl.Utf8).str.strip_chars().alias("node_name"),
            pl.col(time_c).cast(pl.Utf8).str.strip_chars()
              .str.to_datetime(strict=False, time_zone="UTC")
              .dt.convert_time_zone("America/Los_Angeles")
              .dt.replace_time_zone(None)
              .dt.truncate("1h").alias("hour"),
            pl.col(val_c).cast(pl.Utf8).str.strip_chars().cast(pl.Float64, strict=False).alias("_p"),
        ])
        .drop_nulls(["node_name", "hour", "_p"])
        .group_by(["node_name", "hour"])
        .agg(pl.col("_p").mean().alias(price_col_name))
    )
    return out


# ── DB ───────────────────────────────────────────────────────────────────────
def setup(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS caiso_node_prices (
                node_name TEXT      NOT NULL,
                hour      TIMESTAMP NOT NULL,
                da_price  DOUBLE PRECISION,
                rt_price  DOUBLE PRECISION,
                PRIMARY KEY (node_name, hour)
            )""")
        cur.execute("CREATE INDEX IF NOT EXISTS caiso_node_prices_hour_idx ON caiso_node_prices (hour)")
        cur.execute("CREATE INDEX IF NOT EXISTS caiso_node_prices_node_idx ON caiso_node_prices (node_name)")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS caiso_price_seed_log (
                seed_date     DATE NOT NULL,
                price_type    TEXT NOT NULL,
                rows_inserted INTEGER,
                seeded_at     TIMESTAMP DEFAULT now(),
                PRIMARY KEY (seed_date, price_type)
            )""")
    conn.commit()


def seeded_dates(conn, ptype: str) -> set:
    with conn.cursor() as cur:
        cur.execute("SELECT seed_date FROM caiso_price_seed_log WHERE price_type=%s AND rows_inserted >= 0", (ptype,))
        return {r[0] for r in cur.fetchall()}


def log_date(conn, d, ptype, n):
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO caiso_price_seed_log (seed_date, price_type, rows_inserted)
                       VALUES (%s,%s,%s)
                       ON CONFLICT (seed_date, price_type)
                       DO UPDATE SET rows_inserted=%s, seeded_at=now()""", (d, ptype, n, n))
    conn.commit()


def upsert(conn, df: pl.DataFrame, col: str) -> int:
    rows = [(r["node_name"], r["hour"], r[col]) for r in df.to_dicts()]
    if not rows:
        return 0
    other = "rt_price" if col == "da_price" else "da_price"
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            f"""INSERT INTO caiso_node_prices (node_name, hour, {col})
                VALUES %s
                ON CONFLICT (node_name, hour) DO UPDATE SET {col} = EXCLUDED.{col}""",
            rows, page_size=2000)
    conn.commit()
    return len(rows)


# ── per-day seeding ──────────────────────────────────────────────────────────
def seed_day(conn, d: datetime.date, ptype: str) -> int:
    s, e = gmt_window(d)
    if ptype == "DA":
        params = {"queryname": "PRC_LMP", "market_run_id": "DAM", "version": "1",
                  "startdatetime": s, "enddatetime": e,
                  "grp_type": "ALL_APNODES", "resultformat": "6"}
        col = "da_price"
    else:
        params = {"queryname": RT_QUERY, "market_run_id": RT_MARKET, "version": RT_VERSION,
                  "startdatetime": s, "enddatetime": e,
                  "grp_type": "ALL_APNODES", "resultformat": "6"}
        col = "rt_price"

    csv_text = fetch_csv(params, f"{ptype} {d}")
    if not csv_text:
        log_date(conn, d, ptype, -1)
        return -1

    df = parse_lmp(csv_text, col)
    if df is None or df.height == 0:
        log.warning(f"  {ptype} {d}: parsed 0 rows")
        log_date(conn, d, ptype, 0)
        return 0

    n = upsert(conn, df, col)
    log_date(conn, d, ptype, n)
    return n


def run(conn, ptype: str):
    done = seeded_dates(conn, ptype)
    days = [START + datetime.timedelta(days=i)
            for i in range((END - START).days + 1)
            if (START + datetime.timedelta(days=i)) not in done]
    log.info(f"{ptype}: {len(days)} days to seed ({START} → {END})")
    if ptype == "RT":
        log.info(f"{ptype}: source = {RT_QUERY} / {RT_MARKET} (aggregated to hourly)")

    total = errs = 0
    for i, d in enumerate(days):
        t0 = time.time()
        n = seed_day(conn, d, ptype)
        if n > 0:
            total += n
            log.info(f"[{ptype} {i+1}/{len(days)}] {d}: {n:,} node-hours in {time.time()-t0:.1f}s")
        elif n < 0:
            errs += 1
            log.warning(f"[{ptype} {i+1}/{len(days)}] {d}: FAILED")
        else:
            log.info(f"[{ptype} {i+1}/{len(days)}] {d}: no data")
    log.info(f"{ptype} done: {total:,} rows | {errs} errors")


def main():
    conn = psycopg2.connect(DATABASE_URL)
    setup(conn)
    if MODE in ("da", "both"):
        run(conn, "DA")
    if MODE in ("rt", "both"):
        run(conn, "RT")
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*), COUNT(DISTINCT node_name), MIN(hour)::date, MAX(hour)::date FROM caiso_node_prices")
        rows, nodes, lo, hi = cur.fetchone()
    log.info(f"=== caiso_node_prices: {rows:,} rows · {nodes:,} nodes · {lo} → {hi} ===")
    conn.close()


if __name__ == "__main__":
    main()
