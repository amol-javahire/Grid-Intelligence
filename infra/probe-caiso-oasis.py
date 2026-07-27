#!/usr/bin/env python3
"""
probe-caiso-oasis.py — one-shot reconnaissance of the CAISO OASIS API.

Answers the questions we must know before writing the real seeder:
  1. Does ALL_APNODES work for day-ahead LMP, and how many nodes come back?
  2. What are the exact CSV column names?
  3. Which real-time report works at scale — PRC_INTVL_LMP (5-min) or
     PRC_HASP_LMP (15-min)? What volume does each return per day?
  4. How big is one day's payload (drives the runtime + storage estimate)?

No auth required. Run once, paste the output, then the seeder gets written
against reality instead of assumptions.

Usage:  python3 infra/probe-caiso-oasis.py
"""
import io, time, zipfile, sys
import requests

BASE = "http://oasis.caiso.com/oasisapi/SingleZip"

# CAISO wants GMT. Pacific midnight = 08:00Z (PST) / 07:00Z (PDT).
# A single winter day, safely inside our target window.
START = "20250115T08:00-0000"
END   = "20250116T08:00-0000"

HEADERS = {"User-Agent": "Mozilla/5.0 (grid-intelligence probe)"}


def fetch(label: str, params: dict, timeout: int = 180):
    print(f"\n{'='*70}\n{label}\n{'='*70}")
    print("params:", {k: v for k, v in params.items() if k != "resultformat"})
    t0 = time.time()
    try:
        r = requests.get(BASE, params=params, headers=HEADERS, timeout=timeout)
    except Exception as e:
        print(f"  REQUEST FAILED: {e}")
        return None
    dt = time.time() - t0
    print(f"  HTTP {r.status_code}  ·  {len(r.content):,} bytes  ·  {dt:.1f}s")
    print(f"  content-type: {r.headers.get('content-type')}")

    if r.status_code != 200 or not r.content:
        print("  body head:", r.text[:400])
        return None

    # OASIS returns a ZIP; on error it returns XML describing why.
    if not r.content[:2] == b"PK":
        print("  NOT A ZIP — likely an OASIS error payload:")
        print("  ", r.text[:600])
        return None

    try:
        zf = zipfile.ZipFile(io.BytesIO(r.content))
    except Exception as e:
        print(f"  ZIP OPEN FAILED: {e}")
        return None

    for name in zf.namelist():
        raw = zf.read(name)
        print(f"  file: {name}  ({len(raw):,} bytes uncompressed)")
        if name.lower().endswith(".xml"):
            print("  XML (error?) head:", raw[:500].decode("utf-8", "replace"))
            continue
        text = raw.decode("utf-8", "replace")
        lines = text.splitlines()
        print(f"  rows: {len(lines) - 1:,}")
        if lines:
            print(f"  header: {lines[0]}")
        for ln in lines[1:4]:
            print(f"  sample: {ln}")
        # distinct node count — find the node column
        hdr = [h.strip() for h in lines[0].split(",")]
        node_col = next((i for i, h in enumerate(hdr)
                         if h.upper() in ("NODE", "NODE_ID", "NODE_ID_XML", "PNODE_ID")), None)
        if node_col is not None and len(lines) > 1:
            nodes = {ln.split(",")[node_col] for ln in lines[1:] if "," in ln}
            print(f"  DISTINCT NODES: {len(nodes):,}")
            print(f"  node samples: {sorted(list(nodes))[:6]}")
        # distinct LMP component types (CAISO splits LMP into MCE/MCC/MCL)
        comp_col = next((i for i, h in enumerate(hdr)
                         if "TYPE" in h.upper() and "XML" not in h.upper()), None)
        if comp_col is not None and len(lines) > 1:
            comps = {ln.split(",")[comp_col] for ln in lines[1:] if "," in ln}
            print(f"  component types: {sorted(comps)[:8]}")
        return text
    return None


def main():
    print("CAISO OASIS probe — one winter day (2025-01-15 Pacific)")

    # 1. Day-ahead, all aggregate pricing nodes
    fetch("1. DAY-AHEAD  PRC_LMP / DAM / ALL_APNODES", {
        "queryname": "PRC_LMP", "startdatetime": START, "enddatetime": END,
        "version": "1", "market_run_id": "DAM",
        "grp_type": "ALL_APNODES", "resultformat": "6",
    })
    time.sleep(6)   # OASIS throttles aggressively

    # 2. Day-ahead, a single known node — confirms column shape cheaply
    fetch("2. DAY-AHEAD  PRC_LMP / DAM / single node TH_SP15_GEN-APND", {
        "queryname": "PRC_LMP", "startdatetime": START, "enddatetime": END,
        "version": "1", "market_run_id": "DAM",
        "node": "TH_SP15_GEN-APND", "resultformat": "6",
    })
    time.sleep(6)

    # 3. Real-time 15-min HASP, all apnodes — the pragmatic RT option
    fetch("3. REAL-TIME  PRC_HASP_LMP / HASP / ALL_APNODES", {
        "queryname": "PRC_HASP_LMP", "startdatetime": START, "enddatetime": END,
        "version": "1", "market_run_id": "HASP",
        "grp_type": "ALL_APNODES", "resultformat": "6",
    })
    time.sleep(6)

    # 4. Real-time 5-min RTM, all apnodes — the high-fidelity option.
    #    Expect this to be large or rejected; that answer decides the design.
    fetch("4. REAL-TIME  PRC_INTVL_LMP / RTM / ALL_APNODES", {
        "queryname": "PRC_INTVL_LMP", "startdatetime": START, "enddatetime": END,
        "version": "3", "market_run_id": "RTM",
        "grp_type": "ALL_APNODES", "resultformat": "6",
    })

    print("\n" + "="*70)
    print("Probe complete. Paste this whole output back.")
    print("="*70)


if __name__ == "__main__":
    main()
