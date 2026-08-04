#!/usr/bin/env python3
"""
Seed hourly generation-by-fuel and zonal load for ERCOT, CAISO and PJM from
EIA-930, into six tables:

    ercot_hourly_gen_output_by_fuel_agg    ercot_hourly_zonal_load
    caiso_hourly_gen_output_by_fuel_agg    caiso_hourly_zonal_load
    pjm_hourly_gen_output_by_fuel_agg      pjm_hourly_zonal_load

WHY EIA-930 AND NOT THE ISOs' OWN FEEDS
---------------------------------------------------------------------------
One source, one methodology, three markets. Mixing ISO-native feeds would mean
three incompatible definitions of "generation by fuel" that cannot be compared
across markets. EIA-930 is the balancing authority's own reported operating
data, harmonised by EIA, published with a ~1-2 day lag.

Specifically:
  ERCOT — its own NP6-345-CD returns 404 on the public API even with a valid
          token, so EIA-930 is the only public zone-level load source.
  CAISO — runs real-time dispatch but does NOT publish per-resource output the
          way ERCOT's 60-day SCED disclosure does. EIA-930 is the best public
          source, not a fallback.
  PJM   — same shape, no auth needed.

THIS IS FUEL-TYPE AGGREGATE, NOT PER-GENERATOR
The `_by_fuel_agg` suffix is deliberate. These tables hold system-wide totals
per fuel per hour (~8 rows/hour), for the stacked-area generation-mix view.
Per-generator hourly output is a DIFFERENT thing and lives in
`ercot_hourly_dispatch` (real ERCOT SCED, ~1,500 resources/hour). Do not
conflate them: aggregating SCED would UNDERSTATE solar, because behind-the-
meter distributed generation is never dispatched and so never appears in SCED,
whereas EIA-930 counts everything the balancing authority saw.

ZONE GEOGRAPHY DIFFERS BY MARKET — READ BEFORE JOINING
  ERCOT sub-BAs ARE the eight weather zones (COAS/EAST/FWES/NCEN/NRTH/SCEN/
        SOUT/WEST), so they join cleanly to ercot_hourly_zonal_load consumers.
  CAISO sub-BAs are PGAE / SCE / SDGE / VEA. These ARE CAISO's official load
        geography — the four Default Load Aggregation Points (DLAPs) that load
        is actually settled at. They are NOT an EIA approximation; CAISO OASIS
        reports the same four.
        CAISO simply does not publish load by NP15/SP15/ZP26: those are
        TRADING HUBS for bilateral transactions, priced off generation PNodes,
        not load zones. So load and price use different partitions in CAISO by
        market design — do NOT join caiso_hourly_zonal_load to
        caiso_hub_da_rt_hourly on zone. Nothing is wrong; they are different
        geographies and always will be.
  PJM   sub-BAs are the 20 transmission zones, but EIA LABELS THEM DIFFERENTLY
        from PJM's own Data Miner. Verified 2026-08-03 — EIA returns:
          AE AEP AP ATSI BC CE DAY DEOK DOM DPL DUQ EKPC JC ME PE PEP PL PN PS RECO
        PJM's Data Miner `hrl_load_metered` calls the same zones:
          AECO AEP APS ATSI BGE COMED DAY DEOK DOM DPL DUQ EKPC JCPL METED
          PECO PEPCO PPL PENELEC PSEG RECO
        Mapping (EIA → PJM): AE→AECO, AP→APS, BC→BGE, CE→COMED, JC→JCPL,
          ME→METED, PE→PECO, PEP→PEPCO, PL→PPL, PN→PENELEC, PS→PSEG.
          (AEP, ATSI, DAY, DEOK, DOM, DPL, DUQ, EKPC, RECO are identical.)
        Zone codes here are stored AS EIA RETURNS THEM. Joining this table to
        pjm_node_stats on zone name will silently match nothing — translate
        first. Same trap as CAISO's TH_SP15_GEN-APND vs SP15.

        If PJM SETTLEMENT accuracy ever matters, prefer Data Miner metered
        load — that is the number PJM actually bills against.

NO TRUNCATE BY DEFAULT
Writes are ON CONFLICT DO NOTHING. An earlier script in this repo ran DELETE
then INSERT non-transactionally, was interrupted between them, and destroyed
2.5 years of real data (2026-08-03). Nothing here deletes unless you pass
--truncate explicitly, and that path is wrapped in a transaction.

Usage:
  python scripts/src/seed-eia930-markets.py --inspect          # read-only probe
  python scripts/src/seed-eia930-markets.py                    # all 3 markets
  python scripts/src/seed-eia930-markets.py --market CAISO
  SEED_START=2026-06 SEED_END=2026-08 python .../seed-eia930-markets.py
"""

import os
import sys
import time
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import psycopg2
import psycopg2.extras

EIA_KEY = os.environ.get("EIA_API_KEY")
if not EIA_KEY:
    sys.exit("EIA_API_KEY not set")

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL and "--inspect" not in sys.argv:
    sys.exit("DATABASE_URL not set")


def _ym(env_name: str, default: tuple[int, int]) -> tuple[int, int]:
    raw = os.environ.get(env_name)
    if not raw:
        return default
    y, m = raw.split("-")
    return int(y), int(m)


_today = datetime.date.today()
START_YEAR, START_MONTH = _ym("SEED_START", (2024, 1))
# Track the current month — EIA-930 lags ~1-2 days, so a partial current month
# is expected and correct. Never hardcode this; a stale constant froze the
# ERCOT tables five weeks behind while looking like a source limitation.
END_YEAR, END_MONTH = _ym("SEED_END", (_today.year, _today.month))

# market key → EIA-930 balancing authority code
MARKETS = {"ERCOT": "ERCO", "CAISO": "CISO", "PJM": "PJM"}

FUEL_MAP = {
    "COL": "coal", "NG": "natural_gas", "NUC": "nuclear", "OTH": "other",
    "SUN": "solar", "WAT": "hydro", "WND": "wind", "BAT": "storage",
    "OIL": "oil", "GEO": "geothermal", "BIO": "biomass", "PS": "pumped_storage",
    # UES = Unknown Energy Source. EIA uses it when a balancing authority
    # reports generation it cannot attribute to a fuel. Observed in ERCOT
    # 2026-08-03. Mapped to its own category, NOT folded into "other", so the
    # unattributed volume stays visible rather than inflating a real bucket.
    "UES": "unknown",
}

# Codes seen in the feed but absent from FUEL_MAP. Reported at end of run so an
# EIA vocabulary change fails LOUDLY. The ERCOT SCED seeder had exactly this
# gap and silently dumped 122,069 GWh into "other" for six months.
_unmapped_fuels: dict[str, int] = {}


def map_fuel(code: str) -> str:
    mapped = FUEL_MAP.get(code)
    if mapped is None:
        _unmapped_fuels[code] = _unmapped_fuels.get(code, 0) + 1
        return "other"
    return mapped

EIA_BASE = "https://api.eia.gov/v2/electricity/rto"
SOURCE = "eia930"


def eia_fetch_all(endpoint: str, extra_params: dict, label: str = "") -> list:
    """Fetch every page from an EIA v2 hourly endpoint.

    Uses requests with a params dict — NOT curl. curl needs -g/--globoff for
    EIA URLs because facets[x][] contains brackets it reads as range globs;
    requests has no such problem.
    """
    url = f"{EIA_BASE}/{endpoint}/data/"
    params = {"api_key": EIA_KEY, "frequency": "hourly", "length": 5000, **extra_params}
    rows: list = []
    offset = 0
    while True:
        params["offset"] = offset
        try:
            resp = requests.get(url, params=params, timeout=90)
        except requests.RequestException as e:
            print(f"  [{label}] request failed: {e}", flush=True)
            break
        if resp.status_code == 429:
            print(f"  [{label}] rate-limited, sleeping 30s …", flush=True)
            time.sleep(30)
            continue
        if resp.status_code != 200:
            print(f"  [{label}] EIA {resp.status_code}: {resp.text[:200]}", flush=True)
            break
        body = resp.json().get("response", {})
        batch = body.get("data", [])
        rows.extend(batch)
        total = int(body.get("total", len(rows)))
        if len(rows) >= total or not batch:
            break
        offset += 5000
        time.sleep(0.3)
    return rows


def month_window(year: int, month: int) -> tuple[str, str]:
    start = datetime.date(year, month, 1)
    end = (datetime.date(year + 1, 1, 1) if month == 12
           else datetime.date(year, month + 1, 1)) - datetime.timedelta(days=1)
    return start.isoformat(), end.isoformat()


def parse_period(period: str) -> tuple[int, int, int, int]:
    """'2024-01-15T14' → (2024, 1, 15, 14)"""
    date_part, h = period.split("T")
    y, m, d = map(int, date_part.split("-"))
    return y, m, d, int(h)


def months():
    y, m = START_YEAR, START_MONTH
    while (y, m) <= (END_YEAR, END_MONTH):
        yield y, m
        m += 1
        if m > 12:
            y, m = y + 1, 1


def ensure_tables(cur, market: str) -> None:
    ml = market.lower()
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS {ml}_hourly_gen_output_by_fuel_agg (
            id serial PRIMARY KEY,
            year int NOT NULL, month int NOT NULL, day int NOT NULL, hour int NOT NULL,
            fuel_type text NOT NULL,
            gen_mw numeric(12,2),
            source text NOT NULL DEFAULT '{SOURCE}',
            UNIQUE (year, month, day, hour, fuel_type));
        CREATE INDEX IF NOT EXISTS {ml}_genagg_time_idx
            ON {ml}_hourly_gen_output_by_fuel_agg (year, month, day, hour);
        CREATE INDEX IF NOT EXISTS {ml}_genagg_fuel_idx
            ON {ml}_hourly_gen_output_by_fuel_agg (fuel_type);

        CREATE TABLE IF NOT EXISTS {ml}_hourly_zonal_load (
            id serial PRIMARY KEY,
            year int NOT NULL, month int NOT NULL, day int NOT NULL, hour int NOT NULL,
            zone text NOT NULL,
            load_mw numeric(12,2),
            source text NOT NULL DEFAULT '{SOURCE}',
            UNIQUE (year, month, day, hour, zone));
        CREATE INDEX IF NOT EXISTS {ml}_zload_time_idx
            ON {ml}_hourly_zonal_load (year, month, day, hour);
        CREATE INDEX IF NOT EXISTS {ml}_zload_zone_idx
            ON {ml}_hourly_zonal_load (zone);
    """)


def seed_market(market: str, ba: str, truncate: bool, only: str = "both") -> dict:
    """Seed one market. Runs in its own DB connection so markets can overlap.

    `only`: "load" | "gen" | "both" — lets the two datasets be seeded
    independently, so a load-first run doesn't wait on the generation pull.
    """
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    gen_rows = load_rows = 0
    fuels_seen: set[str] = set()
    zones_seen: set[str] = set()
    ml = market.lower()

    try:
        with conn.cursor() as cur:
            ensure_tables(cur, market)
            conn.commit()

            if truncate:
                # Transactional: an interrupted run rolls back rather than
                # leaving the tables empty. Only truncates what is being
                # re-seeded, so `--only load --truncate` cannot wipe gen data.
                targets = []
                if only in ("gen", "both"):
                    targets.append(f"{ml}_hourly_gen_output_by_fuel_agg")
                if only in ("load", "both"):
                    targets.append(f"{ml}_hourly_zonal_load")
                cur.execute(f"TRUNCATE {', '.join(targets)} RESTART IDENTITY")
                conn.commit()

            for year, month in months():
                start_d, end_d = month_window(year, month)
                tag = f"{market} {year}-{month:02d}"

                # ── generation by fuel type ──────────────────────────────
                fuel = [] if only == "load" else eia_fetch_all("fuel-type-data", {
                    "data[0]": "value",
                    "facets[respondent][]": ba,
                    "start": f"{start_d}T00", "end": f"{end_d}T23",
                }, tag)
                batch = []
                for r in fuel:
                    v = r.get("value")
                    if v is None:
                        continue
                    y, m, d, h = parse_period(r["period"])
                    ft = map_fuel(r.get("fueltype", ""))
                    fuels_seen.add(r.get("fueltype", ""))
                    batch.append((y, m, d, h, ft, float(v)))
                if batch:
                    psycopg2.extras.execute_values(cur, f"""
                        INSERT INTO {ml}_hourly_gen_output_by_fuel_agg
                          (year, month, day, hour, fuel_type, gen_mw)
                        VALUES %s ON CONFLICT DO NOTHING""", batch, page_size=1000)
                    gen_rows += len(batch)

                # ── zonal load (sub-BA) ─────────────────────────────────
                load = [] if only == "gen" else eia_fetch_all("region-sub-ba-data", {
                    "data[0]": "value",
                    "facets[parent][]": ba,
                    "start": f"{start_d}T00", "end": f"{end_d}T23",
                }, tag)
                batch = []
                for r in load:
                    v = r.get("value")
                    if v is None:
                        continue
                    y, m, d, h = parse_period(r["period"])
                    z = r.get("subba", "")
                    if not z:
                        continue
                    zones_seen.add(z)
                    batch.append((y, m, d, h, z, float(v)))
                if batch:
                    psycopg2.extras.execute_values(cur, f"""
                        INSERT INTO {ml}_hourly_zonal_load
                          (year, month, day, hour, zone, load_mw)
                        VALUES %s ON CONFLICT DO NOTHING""", batch, page_size=1000)
                    load_rows += len(batch)

                conn.commit()
                print(f"  [{tag}] gen +{len(fuel):,}  load +{len(load):,}", flush=True)
    finally:
        conn.close()

    return {"market": market, "gen_rows": gen_rows, "load_rows": load_rows,
            "fuels": sorted(f for f in fuels_seen if f),
            "zones": sorted(zones_seen)}


def inspect() -> None:
    """Read-only: what does EIA-930 actually return for each market?"""
    print("=== EIA-930 probe (read-only, no DB writes) ===")
    probe_start, probe_end = month_window(END_YEAR, END_MONTH)
    for market, ba in MARKETS.items():
        print(f"\n── {market} (respondent/parent = {ba}) ──")
        fuel = eia_fetch_all("fuel-type-data", {
            "data[0]": "value", "facets[respondent][]": ba,
            "start": f"{probe_start}T00", "end": f"{probe_start}T23",
        }, market)
        fuels = sorted({r.get("fueltype", "") for r in fuel if r.get("fueltype")})
        print(f"  fuel types ({len(fuels)}): {', '.join(fuels)}")
        unmapped = [f for f in fuels if f not in FUEL_MAP]
        if unmapped:
            print(f"  *** UNMAPPED fuel codes — add to FUEL_MAP: {unmapped}")

        load = eia_fetch_all("region-sub-ba-data", {
            "data[0]": "value", "facets[parent][]": ba,
            "start": f"{probe_start}T00", "end": f"{probe_start}T23",
        }, market)
        zones = sorted({r.get("subba", "") for r in load if r.get("subba")})
        print(f"  sub-BA zones ({len(zones)}): {', '.join(zones)}")
        if fuel:
            print(f"  sample: {fuel[0]}")


def main() -> None:
    if "--inspect" in sys.argv:
        inspect()
        return

    truncate = "--truncate" in sys.argv
    selected = MARKETS
    if "--market" in sys.argv:
        m = sys.argv[sys.argv.index("--market") + 1].upper()
        if m not in MARKETS:
            sys.exit(f"unknown market {m}; choose from {list(MARKETS)}")
        selected = {m: MARKETS[m]}

    only = "both"
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1].lower()
        if only not in ("load", "gen", "both"):
            sys.exit("--only must be one of: load | gen | both")

    print(f"=== EIA-930 seed: {', '.join(selected)} | only={only} | "
          f"{START_YEAR}-{START_MONTH:02d} → {END_YEAR}-{END_MONTH:02d} "
          f"| truncate={truncate} ===\n")

    # Markets run concurrently — each has its own connection, and they write to
    # disjoint tables so there is no contention. EIA rate-limits are handled
    # per-request inside eia_fetch_all.
    results = []
    with ThreadPoolExecutor(max_workers=len(selected)) as pool:
        futures = {pool.submit(seed_market, mk, ba, truncate, only): mk
                   for mk, ba in selected.items()}
        for fut in as_completed(futures):
            mk = futures[fut]
            try:
                results.append(fut.result())
            except Exception as e:
                print(f"  ✗ {mk} FAILED: {e}", flush=True)

    print("\n=== Summary ===")
    for r in sorted(results, key=lambda x: x["market"]):
        print(f"  {r['market']:<6} gen {r['gen_rows']:>9,}  load {r['load_rows']:>9,}")
        print(f"         fuels: {', '.join(r['fuels'])}")
        print(f"         zones: {', '.join(r['zones'])}")

    if _unmapped_fuels:
        print("\n" + "=" * 62)
        print("UNMAPPED fuel codes — these were stored as 'other':")
        for code, n in sorted(_unmapped_fuels.items(), key=lambda kv: -kv[1]):
            print(f"    {code:<8} {n:>10,} rows")
        print("Add them to FUEL_MAP and re-run, or 'other' is overstated.")
        print("=" * 62)
    elif only in ("gen", "both"):
        print("\nAll fuel codes mapped cleanly.")


if __name__ == "__main__":
    main()
