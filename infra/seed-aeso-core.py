#!/usr/bin/env python3
"""
seed-aeso-core.py — AESO pool price + asset registry, written against the
ACTUAL API response shapes (verified 2026-07-27), not assumed ones.

Why this exists: scripts/src/seed-aeso-real.ts silently produced all-NULL rows
because it read key names the payload does not contain. Two confirmed faults:

  1. Pool price is wrapped in return["Pool Price Report"] — a NAMED key, not a
     plain array — and every value is a STRING ("19.59"), not a number.
  2. The asset list uses "asset_ID" with a CAPITAL ID. Reading "asset_id"
     yields None for every row, which is exactly what we saw.

Verified shapes
---------------
poolprice-api/v1.1/price/poolPrice?startDate=&endDate=
  {"return": {"Pool Price Report": [
     {"begin_datetime_utc": "...", "begin_datetime_mpt": "2026-07-01 00:00",
      "pool_price": "19.59", "forecast_pool_price": "21.01",
      "rolling_30day_avg": "17.39"}]}}

assetlist-api/v1/assetlist
  {"return": [
     {"asset_name": "...", "asset_ID": "101A", "asset_type": "SINK",
      "operating_status": "Retired", "pool_participant_name": "...",
      "pool_participant_ID": "TPI", "net_to_grid_asset_flag": "",
      "asset_incl_storage_flag": ""}]}

NOTE: the asset list carries NO fuel_type and NO max_capability_mw. Those must
come from another source (CSD generation groups / AESO asset registry file).
Rows are inserted with those columns NULL rather than guessed.

Usage:
    python3 infra/seed-aeso-core.py [START] [END]
Defaults: 2024-01-01 → today. Idempotent.
"""
import datetime, os, sys, time, logging
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

START = datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else datetime.date(2024, 1, 1)
END   = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else datetime.date.today()

CHUNK_DAYS = 30          # AESO caps the pool-price window; 30d is safe
MIN_INTERVAL = 1.0
_last = {"t": 0.0}


def throttle():
    dt = time.time() - _last["t"]
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last["t"] = time.time()


def api_get(path: str, params: dict | None = None, retries: int = 4):
    for attempt in range(retries):
        throttle()
        try:
            r = requests.get(f"{BASE}/{path}", headers=HEADERS, params=params or {}, timeout=90)
        except Exception as e:
            log.warning(f"  request error {e} (attempt {attempt+1})")
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
    """AESO returns numerics as strings; empty string means missing."""
    if v is None:
        return None
    s = str(v).strip()
    if s == "" or s.upper() in ("N/A", "NULL", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def mpt_to_date_he(stamp: str):
    """'2026-07-01 00:00' (Alberta local, interval START) → (date, hour_ending 1-24).

    AESO reports interval start in MPT; hour ending is start hour + 1, with
    hour 0 → HE 1 and hour 23 → HE 24 on the same calendar day.
    """
    try:
        dt = datetime.datetime.strptime(stamp.strip()[:16], "%Y-%m-%d %H:%M")
    except Exception:
        return None, None
    return dt.date(), dt.hour + 1


# ── Pool price ───────────────────────────────────────────────────────────────
def seed_pool_price(conn) -> int:
    log.info(f"Pool price: {START} → {END}")
    total = 0
    cur_start = START
    while cur_start <= END:
        cur_end = min(cur_start + datetime.timedelta(days=CHUNK_DAYS - 1), END)
        data = api_get("poolprice-api/v1.1/price/poolPrice", {
            "startDate": cur_start.isoformat(), "endDate": cur_end.isoformat(),
        })
        if not data:
            log.warning(f"  {cur_start}→{cur_end}: no response")
            cur_start = cur_end + datetime.timedelta(days=1); continue

        # The payload key is a human-readable NAME, not "data"/"items".
        ret = data.get("return") or {}
        rows_in = ret.get("Pool Price Report") if isinstance(ret, dict) else None
        if rows_in is None and isinstance(ret, list):
            rows_in = ret
        if not rows_in:
            log.warning(f"  {cur_start}→{cur_end}: empty report (keys: {list(ret)[:4] if isinstance(ret, dict) else type(ret)})")
            cur_start = cur_end + datetime.timedelta(days=1); continue

        batch = []
        for r in rows_in:
            d, he = mpt_to_date_he(r.get("begin_datetime_mpt", ""))
            if d is None:
                continue
            batch.append((d, he, f(r.get("pool_price")), f(r.get("forecast_pool_price"))))

        if batch:
            with conn.cursor() as c:
                psycopg2.extras.execute_values(c, """
                    INSERT INTO aeso_pool_price (date, hour_ending, pool_price, forecast_pool_price)
                    VALUES %s
                    ON CONFLICT (date, hour_ending) DO UPDATE SET
                      pool_price = EXCLUDED.pool_price,
                      forecast_pool_price = EXCLUDED.forecast_pool_price
                """, batch, page_size=1000)
            conn.commit()
            total += len(batch)
            log.info(f"  {cur_start}→{cur_end}: {len(batch)} hours")
        cur_start = cur_end + datetime.timedelta(days=1)

    log.info(f"Pool price done: {total:,} rows")
    return total


# ── Asset registry ───────────────────────────────────────────────────────────
def seed_assets(conn) -> int:
    log.info("Asset registry")
    data = api_get("assetlist-api/v1/assetlist")
    if not data:
        log.warning("  no response")
        return 0
    rows_in = data.get("return")
    if not isinstance(rows_in, list):
        log.warning(f"  unexpected shape: {type(rows_in)}")
        return 0

    batch = []
    for r in rows_in:
        # CAPITAL ID — this is the field name that broke the original seeder.
        aid = (r.get("asset_ID") or r.get("asset_id") or "").strip()
        if not aid:
            continue
        batch.append((
            aid,
            (r.get("asset_name") or "").strip() or None,
            (r.get("pool_participant_ID") or "").strip() or None,
            (r.get("pool_participant_name") or "").strip() or None,
            None,                                   # fuel_type — not in this payload
            (r.get("asset_type") or "").strip() or None,   # SINK / SOURCE
            None,                                   # max_capability_mw — not in this payload
            None,                                   # location — not in this payload
            (r.get("operating_status") or "").strip() or None,
        ))

    # AESO returns duplicate asset_ID entries; Postgres rejects ON CONFLICT DO
    # UPDATE touching the same key twice in one statement, so dedupe (last wins).
    before = len(batch)
    seen = {}
    for row in batch:
        seen[row[0]] = row          # row[0] is asset_id
    batch = list(seen.values())
    if before != len(batch):
        log.info(f"  deduped {before - len(batch)} duplicate asset IDs")

    if not batch:
        return 0
    with conn.cursor() as c:
        psycopg2.extras.execute_values(c, """
            INSERT INTO aeso_asset_registry
              (asset_id, asset_name, pool_participant_id, pool_participant_name,
               fuel_type, sub_fuel_type, max_capability_mw, location, status)
            VALUES %s
            ON CONFLICT (asset_id) DO UPDATE SET
              asset_name = EXCLUDED.asset_name,
              pool_participant_id = EXCLUDED.pool_participant_id,
              pool_participant_name = EXCLUDED.pool_participant_name,
              sub_fuel_type = EXCLUDED.sub_fuel_type,
              status = EXCLUDED.status
        """, batch, page_size=1000)
    conn.commit()
    log.info(f"Asset registry done: {len(batch):,} assets")
    log.info("  NOTE: fuel_type / max_capability_mw are NULL — the assetlist "
             "endpoint does not carry them. Needs a second source.")
    return len(batch)


def main():
    conn = psycopg2.connect(DATABASE_URL)
    seed_assets(conn)
    seed_pool_price(conn)

    with conn.cursor() as c:
        c.execute("""
            SELECT 'aeso_pool_price', COUNT(*), MIN(date)::text, MAX(date)::text FROM aeso_pool_price
            UNION ALL
            SELECT 'aeso_asset_registry', COUNT(*), NULL, NULL FROM aeso_asset_registry
        """)
        for name, n, lo, hi in c.fetchall():
            rng = f"  {lo} → {hi}" if lo else ""
            log.info(f"=== {name}: {n:,} rows{rng}")
    conn.close()


if __name__ == "__main__":
    main()
