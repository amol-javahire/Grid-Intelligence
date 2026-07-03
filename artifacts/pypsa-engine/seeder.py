"""
seeder.py — Production DB seed for ERCOT resource node pricing data.

Two modes:
  quick  CDR 12301 (public, no auth, ~7-day rolling window, ~950 resource nodes)
  full   ERCOT API OAuth (B2C ROPC, Jan 2024 – current month, all nodes)

Activated via POST /pypsa/admin/seed?mode=quick|full&key=<ERCOT_PASSWORD>
Poll progress via GET /pypsa/admin/seed-status
"""

import os
import io
import re
import csv
import time
import zipfile
import logging
import datetime
import calendar
from typing import Any
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import psycopg2
import psycopg2.extras

logger = logging.getLogger("seeder")

# ── Shared progress state (read by main.py status endpoint) ──────────────────
seed_status: dict[str, Any] = {
    "running": False,
    "mode": None,
    "phase": "idle",
    "progress": "",
    "error": None,
    "completed": False,
    "rows_inserted": 0,
    "started_at": None,
    "finished_at": None,
}


def _set(**kw: Any) -> None:
    seed_status.update(kw)


def _reset(mode: str) -> None:
    _set(
        running=True,
        mode=mode,
        phase="starting",
        progress="",
        error=None,
        completed=False,
        rows_inserted=0,
        started_at=datetime.datetime.utcnow().isoformat() + "Z",
        finished_at=None,
    )


def _finish(rows: int) -> None:
    _set(
        running=False,
        completed=True,
        rows_inserted=rows,
        finished_at=datetime.datetime.utcnow().isoformat() + "Z",
        phase="done",
        progress=f"Complete — {rows:,} rows upserted",
    )


def _fail(err: str) -> None:
    _set(
        running=False,
        error=err,
        phase="failed",
        finished_at=datetime.datetime.utcnow().isoformat() + "Z",
    )


# ── DB helpers ────────────────────────────────────────────────────────────────

def _get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _upsert(rows: list[dict]) -> int:
    """Batch-upsert rows into ercot_node_stats. Returns total rows processed."""
    if not rows:
        return 0

    PAGE = 500
    total = 0
    conn = _get_conn()
    try:
        for i in range(0, len(rows), PAGE):
            chunk = rows[i : i + PAGE]
            with conn:
                with conn.cursor() as cur:
                    psycopg2.extras.execute_values(
                        cur,
                        """
                        INSERT INTO ercot_node_stats
                          (node, node_type, year, month,
                           avg_da_price, avg_rt_price, volatility, neg_price_percent,
                           on_peak_avg, off_peak_avg, min_price, max_price)
                        VALUES %s
                        ON CONFLICT (node, year, month) DO UPDATE SET
                          node_type         = EXCLUDED.node_type,
                          avg_da_price      = EXCLUDED.avg_da_price,
                          avg_rt_price      = EXCLUDED.avg_rt_price,
                          volatility        = EXCLUDED.volatility,
                          neg_price_percent = EXCLUDED.neg_price_percent,
                          on_peak_avg       = EXCLUDED.on_peak_avg,
                          off_peak_avg      = EXCLUDED.off_peak_avg,
                          min_price         = EXCLUDED.min_price,
                          max_price         = EXCLUDED.max_price
                        """,
                        [
                            (
                                r["node"], r["node_type"], r["year"], r["month"],
                                r["avg_da"], r["avg_rt"], r["volatility"], r["neg_pct"],
                                r["on_peak"], r["off_peak"], r["min_p"], r["max_p"],
                            )
                            for r in chunk
                        ],
                        page_size=PAGE,
                    )
            total += len(chunk)
            pct = int(total / len(rows) * 100)
            _set(progress=f"Inserting {total:,} / {len(rows):,} rows ({pct}%)")
    finally:
        conn.close()
    return total


# ── Stat helpers ──────────────────────────────────────────────────────────────

def _mean(lst: list[float]) -> float:
    return sum(lst) / len(lst) if lst else 0.0


def _stddev(lst: list[float]) -> float:
    if len(lst) < 2:
        return 0.0
    m = _mean(lst)
    return (sum((v - m) ** 2 for v in lst) / len(lst)) ** 0.5


def _node_type(node: str) -> str:
    lo = node.lower()
    if lo.startswith("hb_"):
        return "hub"
    if lo.startswith("lz_"):
        return "load_zone"
    return "resource_node"


def _build_rows(rt_agg: dict, da_agg: dict) -> list[dict]:
    """
    rt_agg: (node, year, month) → {"rt": [...], "on_pk": [...], "off_pk": [...]}
    da_agg: (node, year, month) → {"da": [...]}
    """
    rows = []
    for key in set(rt_agg) | set(da_agg):
        node, year, month = key
        rt_d  = rt_agg.get(key, {})
        da_d  = da_agg.get(key, {})
        rt_v  = rt_d.get("rt",    [])
        da_v  = da_d.get("da",    [])
        on_pk = rt_d.get("on_pk", [])
        off_pk= rt_d.get("off_pk",[])
        vals  = rt_v or da_v
        if not vals:
            continue
        avg_rt    = _mean(rt_v) if rt_v else _mean(da_v)
        avg_da    = _mean(da_v) if da_v else avg_rt
        vol       = _stddev(vals)
        neg_pct   = 100.0 * sum(1 for v in vals if v < 0) / len(vals)
        on_p_avg  = _mean(on_pk)  if on_pk  else avg_rt
        off_p_avg = _mean(off_pk) if off_pk else avg_rt
        rows.append({
            "node":       node,
            "node_type":  _node_type(node),
            "year":       year,
            "month":      month,
            "avg_da":     round(avg_da,    4),
            "avg_rt":     round(avg_rt,    4),
            "volatility": round(vol,       4),
            "neg_pct":    round(neg_pct,   3),
            "on_peak":    round(on_p_avg,  4),
            "off_peak":   round(off_p_avg, 4),
            "min_p":      round(min(vals), 4),
            "max_p":      round(max(vals), 4),
        })
    return rows


# ── CDR 12301 — Quick mode (public, no auth) ──────────────────────────────────

CDR_LIST_URL = "https://www.ercot.com/misapp/GetReports.do?reportTypeId=12301"
CDR_DL_BASE  = "https://www.ercot.com/misdownload/servlets/mirDownload?mimic_duns=000000000&doclookupId="
_UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"}


def _extract_csv(data: bytes) -> str | None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for name in zf.namelist():
                if name.lower().endswith(".csv"):
                    return zf.read(name).decode("utf-8", errors="replace")
    except Exception:
        pass
    return None


def _on_peak_cdr(date_str: str, hour: int) -> bool:
    """date_str = MM/DD/YYYY, hour = 1-24"""
    try:
        mm, dd, yyyy = (int(x) for x in date_str.split("/"))
        return datetime.date(yyyy, mm, dd).weekday() < 5 and 7 <= hour <= 22
    except Exception:
        return False


def _parse_cdr_csv(text: str, rt_agg: dict) -> int:
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header:
        return 0
    h = [c.strip() for c in header]
    try:
        i_date  = h.index("DeliveryDate")
        i_hour  = h.index("DeliveryHour")
        i_name  = h.index("SettlementPointName")
        i_type  = h.index("SettlementPointType")
        i_price = h.index("SettlementPointPrice")
    except ValueError:
        return 0

    count = 0
    for row in reader:
        if len(row) <= max(i_date, i_hour, i_name, i_type, i_price):
            continue
        if row[i_type].strip() != "RN":
            continue
        try:
            price = float(row[i_price])
        except ValueError:
            continue
        date_str = row[i_date].strip()
        parts = date_str.split("/")
        if len(parts) != 3:
            continue
        try:
            mm, dd, yyyy = int(parts[0]), int(parts[1]), int(parts[2])
            hour = int(row[i_hour])
        except ValueError:
            continue
        node = row[i_name].strip()
        if not node:
            continue
        key = (node, yyyy, mm)
        if key not in rt_agg:
            rt_agg[key] = {"rt": [], "on_pk": [], "off_pk": []}
        rt_agg[key]["rt"].append(price)
        if _on_peak_cdr(date_str, hour):
            rt_agg[key]["on_pk"].append(price)
        else:
            rt_agg[key]["off_pk"].append(price)
        count += 1
    return count


def _dl_one(doc_id: str) -> bytes | None:
    try:
        r = requests.get(CDR_DL_BASE + doc_id, headers=_UA, timeout=30)
        return r.content if r.ok else None
    except Exception:
        return None


def seed_cdr_quick() -> None:
    """CDR 12301 quick seed — public, no auth, rolling 7-day window, ~950 nodes."""
    _reset("quick")
    logger.info("CDR 12301 quick seed starting")
    try:
        _set(phase="fetching CDR file list")
        resp = requests.get(CDR_LIST_URL, headers=_UA, timeout=30)
        resp.raise_for_status()
        ids = re.findall(r"doclookupId=(\d+)", resp.text)
        csv_ids = ids[::2]  # even indices = CSV files (odd = XML)
        logger.info("CDR 12301: %d CSV file IDs found", len(csv_ids))
        _set(progress=f"Found {len(csv_ids)} CDR files to download")

        rt_agg: dict = {}
        total_data_points = 0
        done = 0
        CHUNK = 20

        _set(phase="downloading + parsing CDR files")
        for i in range(0, len(csv_ids), CHUNK):
            batch = csv_ids[i : i + CHUNK]
            with ThreadPoolExecutor(max_workers=CHUNK) as ex:
                futs = {ex.submit(_dl_one, did): did for did in batch}
                for fut in as_completed(futs):
                    data = fut.result()
                    if data:
                        text = _extract_csv(data)
                        if text:
                            total_data_points += _parse_cdr_csv(text, rt_agg)
            done += len(batch)
            pct = min(100, int(done / len(csv_ids) * 100))
            _set(progress=(
                f"{pct}% downloaded — {len(rt_agg):,} node-months, "
                f"{total_data_points:,} data points"
            ))

        if not rt_agg:
            _fail("No RN data found in CDR 12301 — empty or malformed response")
            return

        logger.info("CDR: aggregated %d node-month buckets", len(rt_agg))
        _set(phase="building rows")
        rows = _build_rows(rt_agg, {})

        _set(phase="upserting to DB")
        inserted = _upsert(rows)
        _finish(inserted)
        logger.info("CDR quick seed done — %d rows", inserted)

    except Exception as exc:
        logger.exception("CDR quick seed failed")
        _fail(str(exc))


# ── ERCOT API — Full historical mode (OAuth B2C ROPC) ─────────────────────────

_TOKEN_URL = (
    "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com"
    "/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token"
)
_RT_URL = "https://api.ercot.com/api/public-reports/np6-905-cd/spp_node_zone_hub"
_DA_URL = "https://api.ercot.com/api/public-reports/np4-190-cd/dam_stlmnt_pnt_prices"


def _get_token(client_id: str, username: str, password: str) -> str:
    data = {
        "username": username,
        "password": password,
        "grant_type": "password",
        "scope": f"openid {client_id} offline_access",
        "client_id": client_id,
        "response_type": "id_token",
    }
    resp = requests.post(_TOKEN_URL, data=data, timeout=30)
    parsed = resp.json()
    if "error" in parsed:
        raise ValueError(
            f"B2C auth failed: {parsed['error']} — {parsed.get('error_description', '')}"
        )
    token = parsed.get("id_token") or parsed.get("access_token")
    if not token:
        raise ValueError(f"No token in B2C response: {str(parsed)[:200]}")
    return token


def _fetch_pages(token: str, sub_key: str, url: str, params: dict) -> list:
    headers = {
        "Authorization": f"Bearer {token}",
        "Ocp-Apim-Subscription-Key": sub_key,
        "Accept": "application/json",
    }
    page = 1
    total_pages = 1
    all_data: list = []
    while page <= total_pages:
        qs = {**params, "size": "10000", "page": str(page)}
        resp = requests.get(url, params=qs, headers=headers, timeout=60)
        body = resp.json()
        if isinstance(body, dict) and body.get("statusCode") == 429:
            msg = body.get("message", "")
            m = re.search(r"try again in (\d+)", msg, re.IGNORECASE)
            wait = int(m.group(1)) + 2 if m else 30
            logger.info("Rate limited — waiting %ds", wait)
            time.sleep(wait)
            continue  # retry same page
        if isinstance(body, dict):
            sc = body.get("statusCode")
            if isinstance(sc, int) and sc >= 400:
                raise ValueError(f"ERCOT API {sc}: {body.get('message')}")
            total_pages = (body.get("_meta") or {}).get("totalPages", 1) or 1
            all_data.extend(body.get("data") or [])
        page += 1
        if page <= total_pages:
            time.sleep(1.4)  # ~0.7 req/s — stay under rate cap
    return all_data


def _on_peak_iso(date_str: str, hour: int) -> bool:
    """date_str = YYYY-MM-DD"""
    try:
        d = datetime.date.fromisoformat(date_str)
        return d.weekday() < 5 and 7 <= hour <= 22
    except Exception:
        return False


def seed_ercot_api_full() -> None:
    """Full historical seed via ERCOT API OAuth. Covers Jan 2024 → current month."""
    _reset("full")
    logger.info("ERCOT API full historical seed starting")
    try:
        client_id = os.environ.get("ERCOT_CLIENT_ID", "")
        username  = os.environ.get("ERCOT_USERNAME",  "")
        password  = os.environ.get("ERCOT_PASSWORD",  "")
        sub_key   = os.environ.get("ERCOT_SUBSCRIPTION_KEY", "")

        missing = [
            k for k, v in {
                "ERCOT_CLIENT_ID":          client_id,
                "ERCOT_USERNAME":           username,
                "ERCOT_PASSWORD":           password,
                "ERCOT_SUBSCRIPTION_KEY":   sub_key,
            }.items()
            if not v
        ]
        if missing:
            _fail(f"Missing env vars: {', '.join(missing)}")
            return

        _set(phase="authenticating with ERCOT B2C")
        token = _get_token(client_id, username, password)
        logger.info("ERCOT API token obtained")

        # Build month range: Jan 2024 → today's month
        now = datetime.date.today()
        months: list[tuple[int, int]] = []
        y, m = 2024, 1
        while (y, m) <= (now.year, now.month):
            months.append((y, m))
            m += 1
            if m > 12:
                m, y = 1, y + 1
        logger.info("Will fetch %d months (%d-%02d → %d-%02d)",
                    len(months), months[0][0], months[0][1],
                    months[-1][0], months[-1][1])

        rt_agg: dict = {}
        da_agg: dict = {}

        for idx, (year, month) in enumerate(months):
            last_day  = calendar.monthrange(year, month)[1]
            date_from = f"{year}-{month:02d}-01"
            date_to   = f"{year}-{month:02d}-{last_day:02d}"
            label     = f"{year}-{month:02d}"

            # ── RT ────────────────────────────────────────────────────────────
            _set(
                phase=f"RT {label}",
                progress=f"Month {idx + 1}/{len(months)} — {label} RT prices",
            )
            try:
                rows = _fetch_pages(token, sub_key, _RT_URL,
                    {"deliveryDateFrom": date_from, "deliveryDateTo": date_to})
                for row in rows:
                    if not isinstance(row, list) or len(row) < 6:
                        continue
                    # cols: [deliveryDate, deliveryHour, deliveryInterval,
                    #        settlementPoint, settlementPointType, price, DSTFlag]
                    date_s = str(row[0])
                    hour   = int(row[1])
                    node   = str(row[3])
                    price  = float(row[5])
                    key = (node, year, month)
                    if key not in rt_agg:
                        rt_agg[key] = {"rt": [], "on_pk": [], "off_pk": []}
                    rt_agg[key]["rt"].append(price)
                    if _on_peak_iso(date_s, hour):
                        rt_agg[key]["on_pk"].append(price)
                    else:
                        rt_agg[key]["off_pk"].append(price)
                logger.info("%s RT: %d intervals", label, len(rows))
            except Exception as exc:
                logger.warning("%s RT fetch failed: %s", label, exc)
            time.sleep(0.5)

            # ── DA ────────────────────────────────────────────────────────────
            _set(
                phase=f"DA {label}",
                progress=f"Month {idx + 1}/{len(months)} — {label} DA prices",
            )
            try:
                rows = _fetch_pages(token, sub_key, _DA_URL,
                    {"deliveryDateFrom": date_from, "deliveryDateTo": date_to})
                for row in rows:
                    if not isinstance(row, list) or len(row) < 4:
                        continue
                    # cols: [deliveryDate, hourEnding, settlementPoint, price, DSTFlag]
                    node  = str(row[2])
                    price = float(row[3])
                    key   = (node, year, month)
                    if key not in da_agg:
                        da_agg[key] = {"da": []}
                    da_agg[key]["da"].append(price)
                logger.info("%s DA: %d intervals", label, len(rows))
            except Exception as exc:
                logger.warning("%s DA fetch failed: %s", label, exc)
            time.sleep(0.5)

        _set(phase="building aggregated rows")
        rows_to_insert = _build_rows(rt_agg, da_agg)
        logger.info("Full seed: %d node×month rows ready to upsert", len(rows_to_insert))

        _set(phase="upserting to DB")
        inserted = _upsert(rows_to_insert)
        _finish(inserted)
        logger.info("ERCOT API full seed complete — %d rows", inserted)

    except Exception as exc:
        logger.exception("ERCOT API full seed failed")
        _fail(str(exc))


# ── ERCOT API — Gap-fill mode (only missing/partial months) ───────────────────

def seed_ercot_api_gaps() -> None:
    """
    Gap-fill: fetch only months missing or partially seeded in ercot_node_stats.
    Uses 100k page size for speed. Typically covers the last 1-3 months.
    """
    _reset("gaps")
    logger.info("ERCOT API gap-fill seed starting")
    try:
        client_id = os.environ.get("ERCOT_CLIENT_ID", "")
        username  = os.environ.get("ERCOT_USERNAME",  "")
        password  = os.environ.get("ERCOT_PASSWORD",  "")
        sub_key   = os.environ.get("ERCOT_SUBSCRIPTION_KEY", "")

        missing = [k for k, v in {
            "ERCOT_CLIENT_ID": client_id, "ERCOT_USERNAME": username,
            "ERCOT_PASSWORD": password,   "ERCOT_SUBSCRIPTION_KEY": sub_key,
        }.items() if not v]
        if missing:
            _fail(f"Missing env vars: {', '.join(missing)}")
            return

        # Find months that are missing or have < 900 nodes (partial)
        conn = _get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT year, month, COUNT(DISTINCT node) AS n
                    FROM ercot_node_stats
                    WHERE year >= 2026
                    GROUP BY year, month
                    ORDER BY year, month
                """)
                covered = {(r[0], r[1]): r[2] for r in cur.fetchall()}
        finally:
            conn.close()

        # Build gap list: months in 2026 up to today with < 900 nodes
        now = datetime.date.today()
        gaps: list[tuple[int, int]] = []
        y, m = 2026, 1
        while (y, m) <= (now.year, now.month):
            node_count = covered.get((y, m), 0)
            if node_count < 900:
                gaps.append((y, m))
                logger.info("Gap month: %d-%02d (%d nodes)", y, m, node_count)
            y_next, m_next = (y + 1, 1) if m == 12 else (y, m + 1)
            y, m = y_next, m_next

        if not gaps:
            _finish(0)
            logger.info("Gap-fill: no missing months found")
            return

        logger.info("Gap-fill: %d months to seed: %s",
                    len(gaps), ", ".join(f"{y}-{m:02d}" for y, m in gaps))
        _set(progress=f"Found {len(gaps)} gap months: "
             + ", ".join(f"{y}-{m:02d}" for y, m in gaps))

        _set(phase="authenticating with ERCOT B2C")
        token = _get_token(client_id, username, password)
        logger.info("ERCOT API token obtained for gap-fill")

        rt_agg: dict = {}
        da_agg: dict = {}

        for idx, (year, month) in enumerate(gaps):
            last_day  = calendar.monthrange(year, month)[1]
            date_from = f"{year}-{month:02d}-01"
            date_to   = f"{year}-{month:02d}-{last_day:02d}"
            label     = f"{year}-{month:02d}"

            # RT
            _set(phase=f"RT {label}",
                 progress=f"Gap {idx + 1}/{len(gaps)} — {label} RT prices")
            try:
                # Try 100k page size first (reduces round-trips 10x if API supports it)
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Ocp-Apim-Subscription-Key": sub_key,
                    "Accept": "application/json",
                }
                page, total_pages = 1, 1
                params = {"deliveryDateFrom": date_from, "deliveryDateTo": date_to}
                while page <= total_pages:
                    qs = {**params, "size": "100000", "page": str(page)}
                    resp = requests.get(_RT_URL, params=qs, headers=headers, timeout=120)
                    body = resp.json()
                    if isinstance(body, dict) and body.get("statusCode") == 429:
                        msg = body.get("message", "")
                        m_wait = re.search(r"try again in (\d+)", msg, re.IGNORECASE)
                        wait = int(m_wait.group(1)) + 2 if m_wait else 30
                        logger.info("Rate limited RT %s — waiting %ds", label, wait)
                        time.sleep(wait)
                        continue
                    total_pages = (body.get("_meta") or {}).get("totalPages", 1) or 1
                    for row in body.get("data") or []:
                        if not isinstance(row, list) or len(row) < 6:
                            continue
                        date_s = str(row[0])
                        hour   = int(row[1])
                        node   = str(row[3])
                        price  = float(row[5])
                        key    = (node, year, month)
                        if key not in rt_agg:
                            rt_agg[key] = {"rt": [], "on_pk": [], "off_pk": []}
                        rt_agg[key]["rt"].append(price)
                        if _on_peak_iso(date_s, hour):
                            rt_agg[key]["on_pk"].append(price)
                        else:
                            rt_agg[key]["off_pk"].append(price)
                    logger.info("%s RT p%d/%d done", label, page, total_pages)
                    page += 1
                    if page <= total_pages:
                        time.sleep(1.4)
            except Exception as exc:
                logger.warning("%s RT fetch failed: %s", label, exc)
            time.sleep(0.5)

            # DA
            _set(phase=f"DA {label}",
                 progress=f"Gap {idx + 1}/{len(gaps)} — {label} DA prices")
            try:
                page, total_pages = 1, 1
                while page <= total_pages:
                    qs = {**params, "size": "100000", "page": str(page)}
                    resp = requests.get(_DA_URL, params=qs, headers=headers, timeout=120)
                    body = resp.json()
                    if isinstance(body, dict) and body.get("statusCode") == 429:
                        msg = body.get("message", "")
                        m_wait = re.search(r"try again in (\d+)", msg, re.IGNORECASE)
                        wait = int(m_wait.group(1)) + 2 if m_wait else 30
                        logger.info("Rate limited DA %s — waiting %ds", label, wait)
                        time.sleep(wait)
                        continue
                    total_pages = (body.get("_meta") or {}).get("totalPages", 1) or 1
                    for row in body.get("data") or []:
                        if not isinstance(row, list) or len(row) < 4:
                            continue
                        node  = str(row[2])
                        price = float(row[3])
                        key   = (node, year, month)
                        if key not in da_agg:
                            da_agg[key] = {"da": []}
                        da_agg[key]["da"].append(price)
                    logger.info("%s DA p%d/%d done", label, page, total_pages)
                    page += 1
                    if page <= total_pages:
                        time.sleep(1.4)
            except Exception as exc:
                logger.warning("%s DA fetch failed: %s", label, exc)
            time.sleep(0.5)

        _set(phase="building aggregated rows")
        rows_to_insert = _build_rows(rt_agg, da_agg)
        logger.info("Gap-fill: %d node×month rows ready to upsert", len(rows_to_insert))

        _set(phase="upserting to DB")
        inserted = _upsert(rows_to_insert)
        _finish(inserted)
        logger.info("ERCOT API gap-fill complete — %d rows", inserted)

    except Exception as exc:
        logger.exception("ERCOT API gap-fill failed")
        _fail(str(exc))
