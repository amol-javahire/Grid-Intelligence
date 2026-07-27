#!/usr/bin/env python3
"""
seed-aeso-generation.py — hourly generator-level metered volumes for Alberta.

Powers the Generation Stack tab: capacity factors, capture prices, capture
rates. Settlement-grade data straight from AESO's metered-volume API.

VERIFIED RESPONSE SHAPE (2026-07-27) — three levels of nesting:

  {"return": [
    {"pool_participant_ID": "ABUS",
     "asset_list": [
       {"asset_ID": "AV1A",              <-- CAPITAL "ID"
        "asset_class": "RETAILER",       <-- generator vs load vs retail
        "metered_volume_list": [
          {"begin_date_utc": "2025-07-01 06:00",
           "begin_date_mpt": "2025-07-01 00:00",   <-- Alberta local, interval START
           "metered_volume": "1.0909443"}          <-- STRING, MWh for the hour
        ]}]}]}

Confirmed: the endpoint serves BOTH historical (Jul 2025) and recent dates, so
the whole window comes from one settlement-grade source. No splice with the CSD
"Historical Generation Data" feed is needed, and therefore no mid-series
provenance boundary to disclose.

Every asset_class is stored (not just generators) so nothing is lost to a wrong
guess up front; filtering happens at query time. Distinct classes are logged on
each run so the real vocabulary is visible rather than assumed.

Usage:
    python3 infra/seed-aeso-generation.py [START] [END]
Defaults: 2025-07-01 → 2026-06-30. Idempotent, resumable per month.
"""
import datetime, os, sys, time, logging
from collections import Counter
import requests
import psycopg2, psycopg2.extras

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]
API_KEY = os.environ.get("AESO_API_KEY", "")
if not API_KEY:
    log.error("AESO_API_KEY not set (check it is not commented out in .env)")
    sys.exit(1)

BASE = "https://apimgw.aeso.ca/public"
HEADERS = {"API-KEY": API_KEY, "Accept": "application/json"}

START = datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else datetime.date(2025, 7, 1)
END   = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else datetime.date(2026, 6, 30)

CHUNK_DAYS   = 7        # keep payloads manageable — a month of all assets is large
MIN_INTERVAL = 1.5
MAX_RETRIES  = 5
_last = {"t": 0.0}


def throttle():
    dt = time.time() - _last["t"]
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last["t"] = time.time()


def api_get(path: str, params: dict):
    for attempt in range(MAX_RETRIES):
        throttle()
        try:
            r = requests.get(f"{BASE}/{path}", headers=HEADERS, params=params, timeout=180)
        except Exception as e:
            log.warning(f"  request error: {e} (attempt {attempt+1})")
            time.sleep(2 ** attempt * 3); continue
        if r.status_code in (429, 500, 502, 503, 504):
            wait = 2 ** attempt * 5
            log.info(f"  HTTP {r.status_code} — backoff {wait}s")
            time.sleep(wait); continue
        if r.status_code != 200:
            log.warning(f"  HTTP {r.status_code}: {r.text[:200]}")
            return None
        try:
            return r.json()
        except Exception as e:
            log.warning(f"  bad JSON: {e}")
            return None
    return None


def f(v):
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def mpt_to_date_he(stamp: str):
    """'2025-07-01 00:00' (Alberta local, interval start) → (date, HE 1-24)."""
    try:
        dt = datetime.datetime.strptime(stamp.strip()[:16], "%Y-%m-%d %H:%M")
    except Exception:
        return None, None
    return dt.date(), dt.hour + 1


def setup(conn):
    with conn.cursor() as c:
        # asset_class is not in the original table definition but is the only
        # way to separate generators from load/retail assets.
        c.execute("ALTER TABLE aeso_metered_volume ADD COLUMN IF NOT EXISTS asset_class TEXT")
        c.execute("""CREATE TABLE IF NOT EXISTS aeso_generation_seed_log (
                       chunk_start DATE PRIMARY KEY,
                       chunk_end   DATE,
                       rows_inserted INTEGER,
                       seeded_at   TIMESTAMP DEFAULT now())""")
        c.execute("CREATE INDEX IF NOT EXISTS aeso_metered_volume_class_idx ON aeso_metered_volume (asset_class)")
    conn.commit()


def seeded_chunks(conn) -> set:
    with conn.cursor() as c:
        c.execute("SELECT chunk_start FROM aeso_generation_seed_log WHERE rows_inserted > 0")
        return {r[0] for r in c.fetchall()}


def parse(payload) -> tuple[list, Counter]:
    """Walk participant → asset_list → metered_volume_list."""
    rows, classes = [], Counter()
    for participant in payload.get("return", []) or []:
        pid = (participant.get("pool_participant_ID") or "").strip() or None
        for asset in participant.get("asset_list", []) or []:
            aid = (asset.get("asset_ID") or asset.get("asset_id") or "").strip()
            if not aid:
                continue
            aclass = (asset.get("asset_class") or "").strip() or None
            classes[aclass or "?"] += 1
            for mv in asset.get("metered_volume_list", []) or []:
                d, he = mpt_to_date_he(mv.get("begin_date_mpt", ""))
                if d is None:
                    continue
                vol = f(mv.get("metered_volume"))
                if vol is None:
                    continue
                rows.append((d, he, aid, pid, aclass, vol))
    return rows, classes


def upsert(conn, rows) -> int:
    if not rows:
        return 0
    with conn.cursor() as c:
        psycopg2.extras.execute_values(c, """
            INSERT INTO aeso_metered_volume
              (date, hour_ending, asset_id, pool_participant_id, asset_class, metered_mw)
            VALUES %s
            ON CONFLICT (date, hour_ending, asset_id) DO UPDATE SET
              metered_mw = EXCLUDED.metered_mw,
              asset_class = EXCLUDED.asset_class,
              pool_participant_id = EXCLUDED.pool_participant_id
        """, rows, page_size=2000)
    conn.commit()
    return len(rows)


def main():
    conn = psycopg2.connect(DATABASE_URL)
    setup(conn)
    done = seeded_chunks(conn)

    chunks = []
    cur = START
    while cur <= END:
        chunks.append((cur, min(cur + datetime.timedelta(days=CHUNK_DAYS - 1), END)))
        cur += datetime.timedelta(days=CHUNK_DAYS)
    todo = [c for c in chunks if c[0] not in done]

    log.info(f"Generation: {len(todo)} chunks to seed ({START} → {END}, {CHUNK_DAYS}d each)")
    total, all_classes = 0, Counter()

    for i, (a, b) in enumerate(todo):
        t0 = time.time()
        payload = api_get("meteredvolume-api/v1/meteredvolume/details",
                          {"startDate": a.isoformat(), "endDate": b.isoformat()})
        if not payload:
            log.warning(f"[{i+1}/{len(todo)}] {a}→{b}: FAILED")
            with conn.cursor() as c:
                c.execute("""INSERT INTO aeso_generation_seed_log (chunk_start, chunk_end, rows_inserted)
                             VALUES (%s,%s,-1) ON CONFLICT (chunk_start) DO UPDATE SET rows_inserted=-1""", (a, b))
            conn.commit()
            continue

        rows, classes = parse(payload)
        all_classes.update(classes)
        n = upsert(conn, rows)
        with conn.cursor() as c:
            c.execute("""INSERT INTO aeso_generation_seed_log (chunk_start, chunk_end, rows_inserted)
                         VALUES (%s,%s,%s)
                         ON CONFLICT (chunk_start) DO UPDATE SET
                           chunk_end=EXCLUDED.chunk_end, rows_inserted=EXCLUDED.rows_inserted,
                           seeded_at=now()""", (a, b, n))
        conn.commit()
        total += n
        log.info(f"[{i+1}/{len(todo)}] {a}→{b}: {n:,} rows in {time.time()-t0:.1f}s")

    if all_classes:
        log.info("Asset classes seen: " + ", ".join(f"{k}={v}" for k, v in all_classes.most_common(12)))

    with conn.cursor() as c:
        c.execute("""SELECT COUNT(*), COUNT(DISTINCT asset_id),
                            MIN(date)::text, MAX(date)::text
                     FROM aeso_metered_volume""")
        n, assets, lo, hi = c.fetchone()
    log.info(f"=== aeso_metered_volume: {n:,} rows · {assets:,} assets · {lo} → {hi} ===")
    log.info(f"=== this run inserted {total:,} rows ===")
    conn.close()


if __name__ == "__main__":
    main()
