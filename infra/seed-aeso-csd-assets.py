#!/usr/bin/env python3
"""
seed-aeso-csd-assets.py — fuel_type + max_capability_mw from AESO's CSD report.

WHY: neither assetlist-api nor meteredvolume-api carries fuel type or nameplate
capability, so aeso_asset_registry has both NULL for all 3,728 rows. That empties
/api/aeso/rankings (which filters max_capability_mw > 0) and makes capacity factor
uncomputable. The ETS Current Supply Demand report has both.

SOURCE (verified 2026-07-27):
    http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet?contentType=csv

SHAPE:
  A summary block of MC/TNG/DCR totals per fuel, then per-fuel asset blocks:

      "<center><b>Simple Cycle</b></center>"
      "ASSET","MC","TNG","DCR"
      "AB Newsprint (ANC1)","63","0","0"

  MC  = maximum capability (MW)      <- what we want
  TNG = total net generation (MW, instantaneous)
  DCR = dispatched contingency reserve (MW)

  Asset ID is inside the parentheses and matches aeso_asset_registry.asset_id.
  Trailing "*" and "^" are report footnote markers, not part of the name.

THE PARSING HAZARD: only SOME sections carry a header. Simple Cycle, Cogeneration,
Combined Cycle and Gas Fired Steam do; Hydro, Energy Storage, Solar, Wind and Other
appear as bare blocks. Inferring fuel from block ORDER would work today and fail
silently whenever AESO reorders — producing a registry where wind is labelled hydro
and every capture-rate number is quietly wrong but still renders.

So: every unlabelled block is resolved by reconciling its MC sum against the
summary totals, and if a block cannot be matched to exactly one fuel within
tolerance the script writes NOTHING and reports what it saw. A loud failure is
worth far more than a plausible-looking wrong answer.

THIS IS A SNAPSHOT. MC is current-as-of-now, not a time series. Re-running updates
it. Historical capacity factors therefore use today's MC — acceptable for screening,
but it is an assumption, and it is recorded in the registry's source column.

Usage:
    python3 infra/seed-aeso-csd-assets.py [--dry-run]
"""
import csv, io, os, re, sys, logging
from collections import defaultdict
import requests
import psycopg2, psycopg2.extras

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DRY = "--dry-run" in sys.argv
URL = "http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet?contentType=csv"

# Fuel names as they appear in the summary block. Anything outside this set is
# not a generation fuel row (interties, totals, system metrics).
SUMMARY_FUELS = {
    "COGENERATION", "WIND", "COMBINED CYCLE", "GAS FIRED STEAM", "SOLAR",
    "SIMPLE CYCLE", "HYDRO", "OTHER", "ENERGY STORAGE",
}

# Reconciliation tolerance. AESO rounds MC to whole MW per asset, so a block of
# ~50 assets can drift a few MW from the summary total without anything being wrong.
TOL_MW = 12

ASSET_RE = re.compile(r"^(.*?)\s*\(([A-Z0-9_]+)\)\s*[\*\^]*\s*$")
HEADER_RE = re.compile(r"<center>\s*<b>\s*(.*?)\s*</b>\s*</center>", re.I)


def fetch() -> str:
    r = requests.get(URL, timeout=90, headers={"User-Agent": "grid-intelligence/1.0"})
    r.raise_for_status()
    return r.text


def parse(text: str):
    """Return (summary {fuel: mc}, blocks [ {fuel|None, assets [(id,name,mc)]} ])."""
    rows = list(csv.reader(io.StringIO(text)))
    summary, blocks = {}, []
    cur = None

    for row in rows:
        cells = [c.strip() for c in row]
        if not any(cells):
            continue

        # Section header, when present.
        m = HEADER_RE.search(cells[0]) if cells else None
        if m:
            if cur and cur["assets"]:
                blocks.append(cur)
            cur = {"fuel": m.group(1).strip().upper(), "assets": []}
            continue

        # Column header line starts a block that may have had no name header.
        if len(cells) >= 4 and cells[0].upper() == "ASSET" and cells[1].upper() == "MC":
            if cur is None or cur["assets"]:
                if cur and cur["assets"]:
                    blocks.append(cur)
                cur = {"fuel": None, "assets": []}
            continue

        if len(cells) < 2:
            continue

        label, val = cells[0], cells[1]

        # Summary fuel totals: "WIND","5684","2662","0"
        if label.upper() in SUMMARY_FUELS and len(cells) >= 3 and not ASSET_RE.match(label):
            try:
                summary[label.upper()] = float(val)
            except ValueError:
                pass
            continue

        # Asset row: "Travers (TVS1)","465","466","0"
        am = ASSET_RE.match(label)
        if am and len(cells) >= 2:
            try:
                mc = float(val)
            except ValueError:
                continue
            name, aid = am.group(1).strip(), am.group(2).strip()
            if cur is None:
                cur = {"fuel": None, "assets": []}
            cur["assets"].append((aid, name, mc))

    if cur and cur["assets"]:
        blocks.append(cur)
    return summary, blocks


def resolve(summary: dict, blocks: list):
    """Assign a fuel to every unlabelled block by reconciling MC sums.

    Returns (assignments, problems). Refuses ambiguity rather than picking one.
    """
    problems = []
    used = set()

    # Labelled blocks first — verify them too, don't just trust the header.
    for b in blocks:
        if b["fuel"]:
            got = sum(a[2] for a in b["assets"])
            want = summary.get(b["fuel"])
            if want is None:
                problems.append(f"block '{b['fuel']}' has no summary total")
            elif abs(got - want) > TOL_MW:
                problems.append(
                    f"block '{b['fuel']}' MC sum {got:.0f} != summary {want:.0f} "
                    f"(diff {got - want:+.0f} MW)")
            used.add(b["fuel"])

    remaining = {f: mc for f, mc in summary.items() if f not in used}

    for b in blocks:
        if b["fuel"]:
            continue
        got = sum(a[2] for a in b["assets"])
        matches = [f for f, mc in remaining.items() if abs(got - mc) <= TOL_MW]
        if len(matches) == 1:
            b["fuel"] = matches[0]
            remaining.pop(matches[0])
            log.info(f"  unlabelled block ({len(b['assets'])} assets, {got:.0f} MW) "
                     f"→ {b['fuel']} (summary {summary[b['fuel']]:.0f})")
        elif not matches:
            problems.append(
                f"unlabelled block of {len(b['assets'])} assets summing {got:.0f} MW "
                f"matches NO remaining fuel {list(remaining.items())}")
        else:
            problems.append(
                f"unlabelled block summing {got:.0f} MW is AMBIGUOUS between {matches} "
                "— tighten TOL_MW or fix upstream")
    return blocks, problems


def main():
    log.info("Fetching CSD report")
    text = fetch()
    summary, blocks = parse(text)

    log.info(f"Summary fuels: {len(summary)} · asset blocks: {len(blocks)} · "
             f"assets: {sum(len(b['assets']) for b in blocks)}")
    for f, mc in sorted(summary.items(), key=lambda kv: -kv[1]):
        log.info(f"    {f:16s} {mc:8.0f} MW")

    blocks, problems = resolve(summary, blocks)

    if problems:
        log.error("RECONCILIATION FAILED — writing nothing:")
        for p in problems:
            log.error(f"  · {p}")
        log.error("The report layout changed. Inspect before trusting any fuel label.")
        sys.exit(2)

    rows = []
    for b in blocks:
        for aid, name, mc in b["assets"]:
            rows.append((aid, b["fuel"], mc, name))

    # Duplicate asset IDs across blocks would mean a genuine source contradiction.
    seen = defaultdict(list)
    for aid, fuel, mc, name in rows:
        seen[aid].append(fuel)
    dupes = {a: f for a, f in seen.items() if len(set(f)) > 1}
    if dupes:
        log.error(f"Asset in multiple fuels — refusing to write: {dupes}")
        sys.exit(2)

    log.info(f"Parsed {len(rows)} generators across {len(blocks)} fuels, reconciled OK")

    if DRY:
        for aid, fuel, mc, name in rows[:15]:
            log.info(f"    {aid:8s} {fuel:16s} {mc:6.0f} MW  {name}")
        log.info("--dry-run: nothing written")
        return

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    with conn.cursor() as c:
        c.execute("ALTER TABLE aeso_asset_registry ADD COLUMN IF NOT EXISTS capability_source TEXT")
        # Only UPDATE — never INSERT. An asset in the CSD report but not in the
        # registry means our registry is stale, which is a finding to surface,
        # not a row to silently invent.
        psycopg2.extras.execute_values(c, """
            UPDATE aeso_asset_registry ar SET
              fuel_type = v.fuel,
              max_capability_mw = v.mc,
              capability_source = 'ETS CSD report snapshot'
            FROM (VALUES %s) AS v(asset_id, fuel, mc, name)
            WHERE ar.asset_id = v.asset_id
        """, [(a, f, m, n) for a, f, m, n in rows], page_size=500)
        updated = c.rowcount
    conn.commit()

    matched = {r[0] for r in rows}
    with conn.cursor() as c:
        c.execute("SELECT asset_id FROM aeso_asset_registry WHERE asset_id = ANY(%s)",
                  (list(matched),))
        in_registry = {r[0] for r in c.fetchall()}
    missing = sorted(matched - in_registry)

    log.info(f"=== updated {updated} registry rows")
    if missing:
        log.warning(f"=== {len(missing)} CSD assets NOT in registry (registry may be stale): "
                    f"{missing[:20]}")

    with conn.cursor() as c:
        c.execute("""SELECT fuel_type, COUNT(*), ROUND(SUM(max_capability_mw)::numeric)
                     FROM aeso_asset_registry WHERE max_capability_mw > 0
                     GROUP BY 1 ORDER BY 3 DESC""")
        for fuel, n, mw in c.fetchall():
            log.info(f"    {fuel:16s} {n:4d} assets  {mw:>8} MW")
    conn.close()


if __name__ == "__main__":
    main()
