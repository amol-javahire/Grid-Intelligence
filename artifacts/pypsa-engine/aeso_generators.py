"""
aeso_generators.py — build a REAL per-unit Alberta generator stack for the
9-bus DC OPF, replacing the six flat carrier prices in aeso_network_regional.py.

WHY THIS EXISTS
---------------------------------------------------------------------------
aeso_network_regional.py originally built generation from REGION_GENERATION —
about 30 aggregated (region, carrier) blocks, each priced at one flat
CARRIER_MC value (wind 0, hydro 5, cogen 45, ccgt 55, scgt 120, ...). That
predates aeso_asset_registry and aeso_merit_order existing.

The consequence, reported 2026-08: LMP was identical at every bus and did not
move when load varied. That is the arithmetically correct answer for that
model, not a solver bug — with only ~6 distinct prices in the whole supply
curve, a 1,000 MW load swing leaves the same block marginal, so the shadow
price on every nodal balance is unchanged. A real Alberta stack has ~230 units
and, with merit-order offers, hundreds of distinct price steps.

DATA SOURCES (both real, from apimgw.aeso.ca)
  aeso_asset_registry  — one row per asset: capacity, fuel, free-text location
  aeso_merit_order     — per-asset offer blocks with real $/MWh offer prices

PRICE PRIORITY, highest wins:
  1. Real merit-order offer for that asset (capacity-weighted mean offer over
     the sampled window). This is an actual submitted price, not an assumption.
  2. CARRIER_MC fallback for assets with no offer history (intermittent
     resources are price-takers and often absent from the offer stack).
Every generator records which was used in `price_source` so the UI can never
present an assumed cost as an observed one.

BUS ASSIGNMENT
  aeso_asset_registry has a free-text `location` column and NO lat/lon, so
  assets are mapped to the nine planning-region buses by matching location
  text against LOCATION_TO_BUS below. Unmatched locations are reported LOUDLY
  and fall back to proportional allocation — they are never silently dropped,
  and never silently dumped into one bus. (Dumping unknowns into a default
  bucket is exactly how the ERCOT resource_type bug hid for six months.)

  LOCATION_TO_BUS is deliberately incomplete until the real distinct values are
  known — run `pnpm --filter @workspace/scripts inspect-aeso-assets` and extend
  it from that output. The loader is safe to run before then: it will report
  low coverage and fall back rather than produce wrong buses.

FALLBACK CONTRACT
  If the registry is empty/unreachable, or matched capacity is implausibly low
  versus Alberta's ~23 GW installed base, load_real_generators() returns None
  and the caller keeps the old aggregated blocks. Degrading loudly to a known
  model beats silently modelling a fictional grid.
"""

from __future__ import annotations

import os
import logging
from typing import Any, Optional

logger = logging.getLogger("pypsa-engine")

# Nine buses of aeso_network_regional.py. Six internal planning regions plus
# three intertie boundaries (no generation sits on the boundary buses).
INTERNAL_BUSES = ["NORTHWEST", "NORTHEAST", "CENTRAL", "EDMONTON", "CALGARY", "SOUTH"]

# Free-text location fragment (lowercased substring) → planning-region bus.
# Ordered longest-first at match time so "fort mcmurray" wins over "fort".
# EXTEND THIS from inspect-aeso-assets output; unmatched assets are reported.
LOCATION_TO_BUS: dict[str, str] = {
    # ── Northwest: Peace River / Grande Prairie / Valleyview-Fox Creek ──
    "grande prairie": "NORTHWEST", "peace river": "NORTHWEST", "valleyview": "NORTHWEST",
    "fox creek": "NORTHWEST", "rainbow lake": "NORTHWEST", "high level": "NORTHWEST",
    "whitecourt": "NORTHWEST", "hinton": "NORTHWEST", "grovedale": "NORTHWEST",
    # ── Northeast: Fort McMurray oil sands ──
    "fort mcmurray": "NORTHEAST", "wood buffalo": "NORTHEAST", "athabasca": "NORTHEAST",
    "mildred lake": "NORTHEAST", "muskeg river": "NORTHEAST", "firebag": "NORTHEAST",
    "cold lake": "NORTHEAST", "bonnyville": "NORTHEAST", "lac la biche": "NORTHEAST",
    # ── Edmonton ──
    "edmonton": "EDMONTON", "wabamun": "EDMONTON", "genesee": "EDMONTON",
    "keephills": "EDMONTON", "sundance": "EDMONTON", "fort saskatchewan": "EDMONTON",
    "leduc": "EDMONTON", "sherwood park": "EDMONTON", "strathcona": "EDMONTON",
    "devon": "EDMONTON", "spruce grove": "EDMONTON",
    # ── Central: Red Deer / Hanna / Bickerdike ──
    "red deer": "CENTRAL", "hanna": "CENTRAL", "bickerdike": "CENTRAL",
    "rimbey": "CENTRAL", "lacombe": "CENTRAL", "stettler": "CENTRAL",
    "drumheller": "CENTRAL", "camrose": "CENTRAL", "wetaskiwin": "CENTRAL",
    "rocky mountain house": "CENTRAL", "battle river": "CENTRAL", "sheerness": "CENTRAL",
    # ── Calgary ──
    "calgary": "CALGARY", "airdrie": "CALGARY", "cochrane": "CALGARY",
    "okotoks": "CALGARY", "langdon": "CALGARY", "strathmore": "CALGARY",
    "canmore": "CALGARY", "banff": "CALGARY", "ghost": "CALGARY",
    # ── South: Lethbridge / Pincher Creek / Brooks / Medicine Hat ──
    "lethbridge": "SOUTH", "pincher creek": "SOUTH", "brooks": "SOUTH",
    "medicine hat": "SOUTH", "taber": "SOUTH", "cardston": "SOUTH",
    "fort macleod": "SOUTH", "vulcan": "SOUTH", "milk river": "SOUTH",
    "suffield": "SOUTH", "bow island": "SOUTH", "burdett": "SOUTH",
    "cassils": "SOUTH", "newell": "SOUTH", "oyen": "SOUTH", "milo": "SOUTH",
    "crowsnest": "SOUTH", "waterton": "SOUTH", "magrath": "SOUTH",
}

# AESO fuel_type / sub_fuel_type → the carriers aeso_network_regional.py knows.
FUEL_TO_CARRIER: dict[str, str] = {
    "wind": "wind", "solar": "solar", "hydro": "hydro",
    "cogeneration": "cogen", "cogen": "cogen",
    "combined cycle": "ccgt", "simple cycle": "scgt",
    "gas fired steam": "ccgt", "coal": "ccgt",   # all Alberta coal is now gas-converted
    "energy storage": "storage", "storage": "storage",
    "battery": "storage", "other": "other", "biomass": "other", "dual fuel": "other",
}

# Fallback price when an asset has no merit-order offer history. Same values
# aeso_network_regional.CARRIER_MC uses — kept here so this module is
# self-contained, but they must stay in sync.
CARRIER_MC_FALLBACK = {
    "wind": 0.0, "solar": 0.0, "hydro": 5.0, "cogen": 45.0,
    "ccgt": 55.0, "scgt": 120.0, "storage": 20.0, "other": 40.0,
}

# Alberta installed capacity is ~23 GW. If mapped capacity falls below this,
# the registry is too incomplete to model and we fall back to LTP blocks.
MIN_PLAUSIBLE_MW = 12_000.0
# Fraction of capacity that must map to a bus before we trust the assignment.
MIN_LOCATION_COVERAGE = 0.60


def _map_location(location: Optional[str]) -> Optional[str]:
    """Longest-fragment-wins match of free-text location → bus."""
    if not location:
        return None
    loc = location.strip().lower()
    if not loc:
        return None
    # A location may already BE a region name (AESO sometimes returns these).
    for bus in INTERNAL_BUSES:
        if loc == bus.lower():
            return bus
    best: Optional[str] = None
    best_len = 0
    for frag, bus in LOCATION_TO_BUS.items():
        if frag in loc and len(frag) > best_len:
            best, best_len = bus, len(frag)
    return best


def _map_carrier(fuel: Optional[str], sub_fuel: Optional[str]) -> str:
    for raw in (sub_fuel, fuel):
        if not raw:
            continue
        key = raw.strip().lower()
        if key in FUEL_TO_CARRIER:
            return FUEL_TO_CARRIER[key]
        for frag, carrier in FUEL_TO_CARRIER.items():
            if frag in key:
                return carrier
    return "other"


def load_real_generators(offer_days: int = 30) -> Optional[dict[str, Any]]:
    """
    Return per-unit generators for the 9-bus model, or None to signal the
    caller should keep the aggregated LTP blocks.

    Returns:
      {
        "generators": [ {name, bus, carrier, p_nom, marginal_cost,
                         price_source, asset_id}, ... ],
        "diagnostics": { ... coverage stats, unmapped locations ... },
      }
    """
    try:
        import psycopg2
    except ImportError:
        logger.warning("psycopg2 unavailable — keeping aggregated LTP blocks")
        return None

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        logger.warning("DATABASE_URL not set — keeping aggregated LTP blocks")
        return None

    try:
        conn = psycopg2.connect(dsn)
    except Exception as e:
        logger.warning("DB connect failed (%s) — keeping aggregated LTP blocks", e)
        return None

    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT asset_id, asset_name, fuel_type, sub_fuel_type,
                       max_capability_mw, location, status
                FROM aeso_asset_registry
                WHERE max_capability_mw IS NOT NULL AND max_capability_mw > 0
            """)
            assets = cur.fetchall()

            # Real offer prices, capacity-weighted per asset over the recent
            # window. This is what gives the supply curve hundreds of steps.
            offers: dict[str, float] = {}
            try:
                cur.execute("""
                    SELECT asset_id,
                           SUM(offer_price * block_mw) / NULLIF(SUM(block_mw), 0)
                    FROM aeso_merit_order
                    WHERE date >= (SELECT MAX(date) FROM aeso_merit_order) - %s::int
                      AND offer_price IS NOT NULL AND block_mw > 0
                    GROUP BY asset_id
                """, (offer_days,))
                offers = {r[0]: float(r[1]) for r in cur.fetchall() if r[1] is not None}
            except Exception as e:
                logger.warning("merit-order offers unavailable (%s) — using carrier fallback prices", e)
    finally:
        conn.close()

    if not assets:
        logger.warning("aeso_asset_registry empty — keeping aggregated LTP blocks")
        return None

    generators: list[dict[str, Any]] = []
    unmapped: dict[str, float] = {}
    mapped_mw = 0.0
    total_mw = 0.0
    priced_real = 0

    for asset_id, name, fuel, sub_fuel, cap, location, status in assets:
        cap = float(cap)
        total_mw += cap

        if status and str(status).strip().lower() in {"retired", "decommissioned", "cancelled"}:
            continue

        bus = _map_location(location)
        if bus is None:
            unmapped[str(location or "(empty)")] = unmapped.get(str(location or "(empty)"), 0.0) + cap
            continue

        carrier = _map_carrier(fuel, sub_fuel)
        offer = offers.get(asset_id)
        if offer is not None and offer > -1000:
            mc, src = float(offer), "merit_order"
            priced_real += 1
        else:
            mc, src = CARRIER_MC_FALLBACK.get(carrier, 40.0), "carrier_assumption"

        generators.append({
            "name": f"{asset_id}_{carrier}",
            "asset_id": asset_id,
            "asset_name": name or asset_id,
            "bus": bus,
            "carrier": carrier,
            "p_nom": cap,
            "marginal_cost": mc,
            "price_source": src,
        })
        mapped_mw += cap

    coverage = mapped_mw / total_mw if total_mw else 0.0

    if unmapped:
        logger.warning("=" * 62)
        logger.warning("UNMAPPED AESO locations (%.0f MW, %.1f%% of fleet):",
                       sum(unmapped.values()), 100 * (1 - coverage))
        for loc, mw in sorted(unmapped.items(), key=lambda kv: -kv[1])[:25]:
            logger.warning("    %-40s %8.1f MW", loc[:40], mw)
        logger.warning("Add these to LOCATION_TO_BUS in aeso_generators.py.")
        logger.warning("=" * 62)

    if mapped_mw < MIN_PLAUSIBLE_MW or coverage < MIN_LOCATION_COVERAGE:
        logger.warning(
            "Real generator stack rejected: %.0f MW mapped (%.0f%% coverage) — "
            "below thresholds (%.0f MW / %.0f%%). Keeping aggregated LTP blocks.",
            mapped_mw, 100 * coverage, MIN_PLAUSIBLE_MW, 100 * MIN_LOCATION_COVERAGE,
        )
        return None

    by_bus: dict[str, float] = {}
    for g in generators:
        by_bus[g["bus"]] = by_bus.get(g["bus"], 0.0) + g["p_nom"]

    diagnostics = {
        "unit_count": len(generators),
        "mapped_mw": round(mapped_mw, 1),
        "total_registry_mw": round(total_mw, 1),
        "location_coverage_pct": round(100 * coverage, 1),
        "units_with_real_offer_price": priced_real,
        "units_with_assumed_price": len(generators) - priced_real,
        "distinct_price_steps": len({round(g["marginal_cost"], 2) for g in generators}),
        "capacity_by_bus_mw": {k: round(v, 1) for k, v in sorted(by_bus.items())},
        "unmapped_locations_mw": {k: round(v, 1) for k, v in
                                  sorted(unmapped.items(), key=lambda kv: -kv[1])[:25]},
    }

    logger.info(
        "Real AESO stack: %d units, %.0f MW, %.0f%% located, %d distinct price steps "
        "(%d real offers / %d assumed)",
        len(generators), mapped_mw, 100 * coverage,
        diagnostics["distinct_price_steps"], priced_real, len(generators) - priced_real,
    )

    return {"generators": generators, "diagnostics": diagnostics}
