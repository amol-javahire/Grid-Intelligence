#!/usr/bin/env python3
"""
collect-aeso-csd-snapshot.py — hourly capture of the AESO CSD report.

WHY THIS EXISTS: MC, DCR and actual intertie flow are published as a CURRENT
SNAPSHOT only. There is no historical hourly series to backfill — the historical
BC/MATL dataset carries scheduled flows and ATC/TTC, not actual physical flow.
Every hour this does not run is an hour of that history permanently lost.

It cannot recover the past. It starts the series now.

WHAT IT WRITES
  aeso_csd_asset_snapshot   per asset per snapshot: MC, TNG, DCR
  aeso_csd_system_snapshot  AIL, total net generation, interchange by path,
                            contingency reserve, FFR
  aeso_asset_capability     EFFECTIVE-DATED MC — never overwritten. A capacity
                            change closes the open record and opens a new one,
                            so capacity-hours can eventually use a time-varying
                            denominator instead of today's MC projected backward.

DEDUPLICATION: keyed on the report's own "Last Update" stamp, not wall clock.
The servlet can serve a cached body; inserting on wall clock would fabricate
distinct observations from one underlying reading.

PARSING: inherits both hazards found on 2026-07-27 —
  · blank lines are the ONLY boundary for unlabelled fuel sections
  · the preamble contains "Alberta Internal Load (AIL)" and "Dispatched
    Contingency Reserve (DCR)", which match the asset-name pattern and parse
    as ~12.5 GW of phantom generators if collection starts too early

Usage:
    python3 infra/collect-aeso-csd-snapshot.py [--dry-run]
Cron (hourly, a few minutes past to avoid the top-of-hour refresh):
    7 * * * * cd ~/grid-intelligence && set -a && . ./.env && set +a && \
      artifacts/pypsa-engine/.venv/bin/python infra/collect-aeso-csd-snapshot.py \
      >> /tmp/csd-snapshot.log 2>&1
"""
import csv, datetime, io, os, re, sys, logging
import requests
import psycopg2, psycopg2.extras

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DRY = "--dry-run" in sys.argv
URL = "http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet?contentType=csv"

SUMMARY_FUELS = {
    "COGENERATION", "WIND", "COMBINED CYCLE", "GAS FIRED STEAM", "SOLAR",
    "SIMPLE CYCLE", "HYDRO", "OTHER", "ENERGY STORAGE",
}
INTERCHANGE_PATHS = {"BRITISH COLUMBIA", "MONTANA", "SASKATCHEWAN"}
SYSTEM_FIELDS = {
    "ALBERTA TOTAL NET GENERATION":      "total_net_generation_mw",
    "NET ACTUAL INTERCHANGE":            "net_actual_interchange_mw",
    "ALBERTA INTERNAL LOAD (AIL)":       "ail_mw",
    "NET-TO-GRID GENERATION":            "net_to_grid_mw",
    "CONTINGENCY RESERVE REQUIRED":      "contingency_reserve_required_mw",
    "DISPATCHED CONTINGENCY RESERVE (DCR)": "dcr_total_mw",
    "DISPATCHED CONTINGENCY RESERVE -GEN":  "dcr_gen_mw",
    "DISPATCHED CONTINGENCY RESERVE -OTHER":"dcr_other_mw",
    "FFR ARMED DISPATCH":                "ffr_armed_mw",
    "FFR OFFERED VOLUME":                "ffr_offered_mw",
    "LONG LEAD TIME VOLUME":             "long_lead_time_mw",
}

ASSET_RE  = re.compile(r"^(.*?)\s*\(([A-Z0-9_]+)\)\s*[\*\^]*\s*$")
HEADER_RE = re.compile(r"<center>\s*<b>\s*(.*?)\s*</b>\s*</center>", re.I)
STAMP_RE  = re.compile(r"Last Update\s*:\s*(.+)", re.I)
TOL_MW = 12


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except (ValueError, AttributeError):
        return None


def parse(text):
    rows = list(csv.reader(io.StringIO(text)))
    system, interchange, summary, blocks = {}, {}, {}, []
    stamp = None
    cur = None
    in_assets = False

    def close():
        nonlocal cur
        if cur and cur["assets"]:
            blocks.append(cur)
        cur = None

    for row in rows:
        cells = [c.strip() for c in row]
        if not any(cells):
            close()
            continue

        if stamp is None:
            m = STAMP_RE.search(cells[0])
            if m:
                stamp = m.group(1).strip()
                continue

        h = HEADER_RE.search(cells[0])
        if h:
            close()
            in_assets = True
            cur = {"fuel": h.group(1).strip().upper(), "assets": []}
            continue

        if len(cells) >= 4 and cells[0].upper() == "ASSET" and cells[1].upper() == "MC":
            in_assets = True
            if cur is None:
                cur = {"fuel": None, "assets": []}
            continue

        if len(cells) < 2:
            continue
        label, up = cells[0], cells[0].upper()

        if not in_assets:
            if up in SYSTEM_FIELDS:
                system[SYSTEM_FIELDS[up]] = num(cells[1]); continue
            if up in INTERCHANGE_PATHS:
                interchange[up.title()] = num(cells[1]); continue
            if up in SUMMARY_FUELS and len(cells) >= 3:
                summary[up] = num(cells[1]); continue
            continue

        m = ASSET_RE.match(label)
        if m:
            mc = num(cells[1])
            if mc is None:
                continue
            if cur is None:
                cur = {"fuel": None, "assets": []}
            cur["assets"].append({
                "asset_id": m.group(2).strip(),
                "asset_name": m.group(1).strip(),
                "mc": mc,
                "tng": num(cells[2]) if len(cells) > 2 else None,
                "dcr": num(cells[3]) if len(cells) > 3 else None,
            })

    close()
    return stamp, system, interchange, summary, blocks


def resolve(summary, blocks):
    """Label the header-less blocks by reconciling MC sums. Refuse ambiguity."""
    used, problems = set(), []
    for b in blocks:
        if b["fuel"]:
            got = sum(a["mc"] for a in b["assets"])
            want = summary.get(b["fuel"])
            if want is not None and abs(got - want) > TOL_MW:
                problems.append(f"{b['fuel']}: {got:.0f} vs summary {want:.0f}")
            used.add(b["fuel"])
    remaining = {f: mc for f, mc in summary.items() if f not in used}
    for b in blocks:
        if b["fuel"]:
            continue
        got = sum(a["mc"] for a in b["assets"])
        hit = [f for f, mc in remaining.items() if abs(got - mc) <= TOL_MW]
        if len(hit) == 1:
            b["fuel"] = hit[0]
            remaining.pop(hit[0])
        else:
            problems.append(f"unlabelled block {got:.0f} MW → {hit or 'no match'}")
    return problems


DDL = """
CREATE TABLE IF NOT EXISTS aeso_csd_system_snapshot (
  report_stamp   TEXT PRIMARY KEY,
  collected_at   TIMESTAMPTZ DEFAULT now(),
  total_net_generation_mw      REAL,
  net_actual_interchange_mw    REAL,
  ail_mw                       REAL,
  net_to_grid_mw               REAL,
  contingency_reserve_required_mw REAL,
  dcr_total_mw                 REAL,
  dcr_gen_mw                   REAL,
  dcr_other_mw                 REAL,
  ffr_armed_mw                 REAL,
  ffr_offered_mw               REAL,
  long_lead_time_mw            REAL,
  flow_bc_mw                   REAL,
  flow_mt_mw                   REAL,
  flow_sk_mw                   REAL
);
CREATE TABLE IF NOT EXISTS aeso_csd_asset_snapshot (
  report_stamp TEXT NOT NULL,
  asset_id     TEXT NOT NULL,
  fuel_type    TEXT,
  mc_mw        REAL,
  tng_mw       REAL,
  dcr_mw       REAL,
  PRIMARY KEY (report_stamp, asset_id)
);
CREATE INDEX IF NOT EXISTS aeso_csd_asset_snapshot_asset
  ON aeso_csd_asset_snapshot (asset_id);
-- Effective-dated capability. An MC change closes the open row and opens a new
-- one; nothing is ever overwritten, so capacity history accumulates.
CREATE TABLE IF NOT EXISTS aeso_asset_capability (
  id             BIGSERIAL PRIMARY KEY,
  asset_id       TEXT NOT NULL,
  fuel_type      TEXT,
  mc_mw          REAL NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to   TIMESTAMPTZ,
  source         TEXT DEFAULT 'ETS CSD snapshot'
);
CREATE UNIQUE INDEX IF NOT EXISTS aeso_asset_capability_open
  ON aeso_asset_capability (asset_id) WHERE effective_to IS NULL;
"""


def main():
    r = requests.get(URL, timeout=90, headers={"User-Agent": "grid-intelligence/1.0"})
    r.raise_for_status()
    stamp, system, interchange, summary, blocks = parse(r.text)

    if not stamp:
        log.error("No 'Last Update' stamp — refusing to write (cannot dedupe)")
        sys.exit(2)

    problems = resolve(summary, blocks)
    if problems:
        log.error(f"Reconciliation failed, writing nothing: {problems}")
        sys.exit(2)

    assets = [{**a, "fuel": b["fuel"]} for b in blocks for a in b["assets"]]
    system["flow_bc_mw"] = interchange.get("British Columbia")
    system["flow_mt_mw"] = interchange.get("Montana")
    system["flow_sk_mw"] = interchange.get("Saskatchewan")

    log.info(f"stamp='{stamp}'  assets={len(assets)}  AIL={system.get('ail_mw')}  "
             f"BC={system['flow_bc_mw']}  MT={system['flow_mt_mw']}  SK={system['flow_sk_mw']}")

    if DRY:
        for a in assets[:8]:
            log.info(f"    {a['asset_id']:6s} {a['fuel']:16s} MC={a['mc']:6.0f} "
                     f"TNG={a['tng']} DCR={a['dcr']}")
        log.info("--dry-run: nothing written")
        return

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn.cursor() as c:
        c.execute(DDL)
        cols = ["report_stamp"] + [k for k in system]
        vals = [stamp] + [system[k] for k in system]
        c.execute(
            f"INSERT INTO aeso_csd_system_snapshot ({','.join(cols)}) "
            f"VALUES ({','.join(['%s'] * len(vals))}) ON CONFLICT (report_stamp) DO NOTHING",
            vals)
        if c.rowcount == 0:
            log.info("Snapshot already recorded (same report stamp) — skipping")
            conn.commit(); conn.close(); return

        psycopg2.extras.execute_values(c, """
            INSERT INTO aeso_csd_asset_snapshot
              (report_stamp, asset_id, fuel_type, mc_mw, tng_mw, dcr_mw)
            VALUES %s ON CONFLICT DO NOTHING
        """, [(stamp, a["asset_id"], a["fuel"], a["mc"], a["tng"], a["dcr"]) for a in assets],
            page_size=500)

        # Effective-dated capability: close and reopen only on a real change.
        changed = 0
        for a in assets:
            c.execute("""SELECT mc_mw FROM aeso_asset_capability
                         WHERE asset_id = %s AND effective_to IS NULL""", (a["asset_id"],))
            row = c.fetchone()
            if row is None:
                c.execute("""INSERT INTO aeso_asset_capability (asset_id, fuel_type, mc_mw)
                             VALUES (%s,%s,%s)""", (a["asset_id"], a["fuel"], a["mc"]))
                changed += 1
            elif abs(float(row[0]) - a["mc"]) > 0.5:
                c.execute("""UPDATE aeso_asset_capability SET effective_to = now()
                             WHERE asset_id = %s AND effective_to IS NULL""", (a["asset_id"],))
                c.execute("""INSERT INTO aeso_asset_capability (asset_id, fuel_type, mc_mw)
                             VALUES (%s,%s,%s)""", (a["asset_id"], a["fuel"], a["mc"]))
                changed += 1
        log.info(f"capability records opened/changed: {changed}")
    conn.commit()

    with conn.cursor() as c:
        c.execute("SELECT COUNT(*) FROM aeso_csd_system_snapshot")
        n = c.fetchone()[0]
    log.info(f"=== {n} system snapshots collected to date")
    conn.close()


if __name__ == "__main__":
    main()
