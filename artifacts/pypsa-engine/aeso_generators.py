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

# ── PLANT NAME → BUS, the primary mapping ────────────────────────────────────
#
# PROVENANCE — READ THIS BEFORE CITING ANY CONGESTION RESULT.
# AESO's public API carries NO location data. Verified 2026-08-02 by probing
# every candidate endpoint (scripts/src/probe-aeso-endpoints.ts):
#   assetlist-api      → asset_ID, asset_name, asset_type, operating_status,
#                        pool_participant_ID/name.  No location field.
#   currentsupplydemand→ asset, fuel_type, maximum_capability, net_generation.
#                        No location field.
#   aeso_asset_registry.location is empty for all 3,728 rows as a result.
#
# So assets are placed by matching their NAME against known Alberta plant
# locations below. This is real geography but it is NOT an AESO-published
# mapping — it is assembled knowledge, and it is tagged per entry:
#   "high" — unambiguous, well-known major facility whose location is not in
#            reasonable doubt (Genesee, Syncrude, Shepard, Sheerness...).
#   "low"  — plausible but worth verifying against a sourced facility list
#            (AUC facility registry, or AESO Information Document 2010-001R
#            "Facility Modelling Data and List of Electrical Facilities").
#
# Anything unmatched is reported with its MW and EXCLUDED — never silently
# assigned to a default bus. Capacity-weighted confidence is returned in the
# diagnostics so the UI can state how much of the fleet is high-confidence.
#
# fragment (lowercase, matched as substring of asset_name) → (bus, confidence)
PLANT_NAME_TO_BUS: dict[str, tuple[str, str]] = {
    # ── EDMONTON: Wabamun/Genesee thermal cluster + capital region ──
    "genesee": ("EDMONTON", "high"),      # Warburg, SW of Edmonton
    "keephills": ("EDMONTON", "high"),    # Wabamun
    "sundance": ("EDMONTON", "high"),     # Wabamun
    "wabamun": ("EDMONTON", "high"),
    "clover bar": ("EDMONTON", "high"),
    "rossdale": ("EDMONTON", "high"),
    "scotford": ("EDMONTON", "high"),     # Shell, Fort Saskatchewan
    "redwater": ("EDMONTON", "high"),
    "sturgeon": ("EDMONTON", "high"),     # Sturgeon refinery, Redwater
    "heartland": ("EDMONTON", "high"),
    "strathcona": ("EDMONTON", "high"),   # Suncor Strathcona refinery cogen
    "edmonton": ("EDMONTON", "high"),
    "leduc": ("EDMONTON", "low"),
    "acheson": ("EDMONTON", "low"),
    "villeneuve": ("EDMONTON", "low"),
    # ── NORTHEAST: Fort McMurray / Athabasca oil sands cogeneration ──
    "syncrude": ("NORTHEAST", "high"),
    "mildred lake": ("NORTHEAST", "high"),
    "base plant": ("NORTHEAST", "high"),  # Suncor Base Plant
    "firebag": ("NORTHEAST", "high"),
    "mackay river": ("NORTHEAST", "high"),
    "muskeg river": ("NORTHEAST", "high"),
    "horizon": ("NORTHEAST", "high"),     # CNRL Horizon
    "kearl": ("NORTHEAST", "high"),
    "albian": ("NORTHEAST", "high"),
    "jackpine": ("NORTHEAST", "high"),
    "fort hills": ("NORTHEAST", "high"),
    "long lake": ("NORTHEAST", "high"),
    "surmont": ("NORTHEAST", "high"),
    "christina lake": ("NORTHEAST", "high"),
    "foster creek": ("NORTHEAST", "high"),
    "jackfish": ("NORTHEAST", "high"),
    "cold lake": ("NORTHEAST", "high"),
    "primrose": ("NORTHEAST", "low"),
    "sunrise": ("NORTHEAST", "low"),
    "cenovus": ("NORTHEAST", "low"),
    "suncor": ("NORTHEAST", "low"),
    "mcmurray": ("NORTHEAST", "high"),
    # ── CENTRAL: Red Deer / Hanna / Forestburg / Battle River ──
    "joffre": ("CENTRAL", "high"),        # near Red Deer
    "sheerness": ("CENTRAL", "high"),     # Hanna
    "battle river": ("CENTRAL", "high"),  # Forestburg
    "red deer": ("CENTRAL", "high"),
    "rimbey": ("CENTRAL", "low"),
    "hanna": ("CENTRAL", "high"),
    "halkirk": ("CENTRAL", "high"),       # wind, near Castor
    "paintearth": ("CENTRAL", "high"),
    "castor": ("CENTRAL", "low"),
    "provost": ("CENTRAL", "low"),
    "wainwright": ("CENTRAL", "low"),
    "drumheller": ("CENTRAL", "low"),
    "stettler": ("CENTRAL", "low"),
    "sharp hills": ("CENTRAL", "high"),   # Oyen, east-central
    "oyen": ("CENTRAL", "low"),
    "cavalier": ("CENTRAL", "low"),
    "sundre": ("CENTRAL", "low"),
    "nevis": ("CENTRAL", "low"),
    # ── CALGARY ──
    "shepard": ("CALGARY", "high"),
    "calgary": ("CALGARY", "high"),
    "balzac": ("CALGARY", "high"),
    "bearspaw": ("CALGARY", "high"),      # Bow River hydro
    "ghost": ("CALGARY", "high"),
    "horseshoe": ("CALGARY", "high"),
    "kananaskis": ("CALGARY", "high"),
    "barrier": ("CALGARY", "high"),
    "pocaterra": ("CALGARY", "high"),
    "interlakes": ("CALGARY", "low"),
    "spray": ("CALGARY", "low"),
    "airdrie": ("CALGARY", "low"),
    "langdon": ("CALGARY", "high"),
    "strathmore": ("CALGARY", "low"),
    "carseland": ("CALGARY", "low"),
    # ── SOUTH: Lethbridge / Pincher Creek / Brooks / Medicine Hat ──
    "travers": ("SOUTH", "high"),         # solar, Lomond/Vulcan
    "buffalo plains": ("SOUTH", "high"),  # wind, Lomond
    "blackspring": ("SOUTH", "high"),
    "castle rock": ("SOUTH", "high"),     # Pincher Creek
    "pincher": ("SOUTH", "high"),
    "oldman": ("SOUTH", "high"),
    "waterton": ("SOUTH", "high"),
    "medicine hat": ("SOUTH", "high"),
    "lethbridge": ("SOUTH", "high"),
    "brooks": ("SOUTH", "high"),
    "suffield": ("SOUTH", "high"),
    "whitla": ("SOUTH", "high"),
    "windrise": ("SOUTH", "high"),
    "forty mile": ("SOUTH", "high"),
    "jenner": ("SOUTH", "high"),
    "hays": ("SOUTH", "low"),
    "taber": ("SOUTH", "low"),
    "vauxhall": ("SOUTH", "low"),
    "burdett": ("SOUTH", "low"),
    "bow island": ("SOUTH", "low"),
    "chin chute": ("SOUTH", "low"),
    "st. mary": ("SOUTH", "low"),
    "raymond": ("SOUTH", "low"),
    "magrath": ("SOUTH", "low"),
    "summerview": ("SOUTH", "high"),      # Pincher Creek wind
    "ardenville": ("SOUTH", "low"),
    "cowley": ("SOUTH", "low"),
    "empress": ("SOUTH", "low"),
    "cassils": ("SOUTH", "low"),
    "rainbow": ("NORTHWEST", "high"),     # Rainbow Lake
    # ── NORTHWEST: Grande Prairie / Peace / Whitecourt / Hinton ──
    "grande prairie": ("NORTHWEST", "high"),
    "valleyview": ("NORTHWEST", "high"),
    "fox creek": ("NORTHWEST", "high"),
    "peace river": ("NORTHWEST", "high"),
    "whitecourt": ("NORTHWEST", "high"),
    "hinton": ("NORTHWEST", "high"),
    "cascade": ("NORTHWEST", "low"),      # Cascade Power, near Edson — Edson sits
                                          # near the NW/Edmonton boundary; verify.
    "sexsmith": ("NORTHWEST", "low"),
    "wapiti": ("NORTHWEST", "low"),
    "sturgeon lake": ("NORTHWEST", "low"),
    "high level": ("NORTHWEST", "low"),
    "manning": ("NORTHWEST", "low"),
    "fort nelson": ("NORTHWEST", "low"),
    "grovedale": ("NORTHWEST", "low"),
    "sundance mine": ("EDMONTON", "low"),
}

# Free-text location fragment (lowercased substring) → planning-region bus.
# Retained as a SECOND chance in case AESO ever populates `location`, and used
# ahead of the name map when a location string is present. Confirmed empty for
# every row as of 2026-08-02, so today this never fires.
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
# Fallback prices for assets with NO offer in the selected window. Used only
# when the merit order has nothing for that asset — every asset that did offer
# gets its real per-block prices instead.
#
# HOW ALBERTA UNITS ACTUALLY OFFER (from the merit order, confirmed by Amol):
#   · Renewables offer at $0 — price takers.
#   · Efficient newer gas offers its FIRST block at $0 too, to stay in merit.
#     Measured 2026-06-01 HE18: CAL1, EC01, GNR1, GNR2, SCR1 all have a $0
#     first block and climb from there.
#   · Only PEAKERS and inefficient older units start high. Their first block is
#     roughly  heat_rate x gas_price + start cost + variable O&M  — the floor
#     that makes starting worth it. NPP1 (simple cycle) offers all five blocks
#     at ~$539.
#
# So a single number per carrier is wrong in principle for anything except
# renewables: real units have a CURVE, not a price. These values stand in only
# where no curve is available, and scgt is high precisely because a peaker's
# first block already carries its start cost.
#
# TODO: derive the gas entries from the live AECO price and a per-technology
# heat rate rather than hardcoding, so they track fuel. Needs the Alberta
# Reference Price wired into the engine (it is already in the frontend).
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


def _map_asset_name(asset_name: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """
    Match a plant name → (bus, confidence). Longest fragment wins so
    "sundance mine" beats "sundance" and "base plant" isn't shadowed.

    Asset names look like "GNR1 Genesee Repower 1", "SCR6 Firebag",
    "EGC1 Shepard" — the AESO asset ID prefix is harmless to the substring
    match. Returns (None, None) when nothing matches, so the caller can report
    it rather than guess.
    """
    if not asset_name:
        return None, None
    name = asset_name.strip().lower()
    if not name:
        return None, None
    best: Optional[tuple[str, str]] = None
    best_len = 0
    for frag, (bus, conf) in PLANT_NAME_TO_BUS.items():
        if frag in name and len(frag) > best_len:
            best, best_len = (bus, conf), len(frag)
    return best if best else (None, None)


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


def load_real_generators(
    offer_days: int = 30,
    estimator: str = "mode",
    months: Optional[list[int]] = None,
) -> Optional[dict[str, Any]]:
    """
    Return PER-BLOCK generators for the 9-bus model, or None to signal the
    caller should keep the aggregated LTP blocks.

    ONE COMPONENT PER OFFER BLOCK, NOT PER ASSET
    ---------------------------------------------------------------------------
    An earlier version collapsed each asset's blocks into one capacity-weighted
    price:  SUM(offer_price * block_mw) / SUM(block_mw).  That destroys the
    supply curve, because Alberta generators routinely place their final block
    at the $999.99 cap. Measured on 2026-06-01 HE18:

        CAL1  6 blocks  $0 - 999.99   weighted avg $398.91
        EC01  4 blocks  $0 - 999.96   weighted avg $499.43
        CMH1  6 blocks  $0 - 999.99   weighted avg $304.56

    CAL1's first MW is free, and the averaged model charged $398.91 for all of
    it. Those cap-block units are the flexible gas plants that set price in
    mid-load hours, so the model priced its most important marginal units two
    orders of magnitude too high. Calibration showed the consequence: hours that
    settled at $13.53 were modelled at $216.63 — WORSE than the crude carrier
    fallback, despite using real data.

    Per-block keeps each step at its own price. ~287 blocks/hour against ~188
    assets, so roughly 100 extra components — nothing for the solver.

    ESTIMATOR — how to collapse one block's price across the window.
    A block's price varies hour to hour, so some statistic is needed. `mode`
    is the default because generators repeat a standing offer most hours: the
    mode captures that normal offer, while the mean is dragged upward by
    occasional strategic or scarcity pricing. min/max/avg are available for
    comparison; the right choice is an empirical question, not a given.

    SEASON — `months` restricts the window to specific calendar months.
    Offer behaviour is seasonal: large units take maintenance outages in SPRING,
    so a spring stack misrepresents summer. Passing months=[6,7,8] builds the
    stack from summer offers regardless of how recent they are. Default None
    keeps the trailing `offer_days` window.

    Returns:
      {
        "generators": [ {name, bus, carrier, p_nom, marginal_cost,
                         price_source, asset_id, block_number}, ... ],
        "diagnostics": { ... coverage stats, unmapped locations ... },
      }
    """
    if estimator not in {"mode", "avg", "min", "max"}:
        raise ValueError(f"estimator must be mode/avg/min/max, got {estimator!r}")
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

            # PER-ASSET, PER-BLOCK offers — each block keeps its own price.
            # See the docstring for why collapsing them to one price per asset
            # is destructive.
            #
            # mode() WITHIN GROUP is Postgres' statistical mode. Prices are
            # rounded to the CENT first: offers repeat exactly, so cent-rounding
            # finds genuine repeats, whereas rounding to the dollar would merge
            # distinct offers that merely sit close together.
            blocks: list[tuple] = []
            window_desc = ""
            try:
                if months:
                    season_sql = "AND EXTRACT(MONTH FROM date)::int = ANY(%(months)s)"
                    params: dict[str, Any] = {"months": months}
                    window_desc = f"months={months}"
                else:
                    season_sql = ("AND date >= (SELECT MAX(date) FROM aeso_merit_order) "
                                  "- %(days)s::int")
                    params = {"days": offer_days}
                    window_desc = f"trailing {offer_days}d"

                cur.execute(f"""
                    SELECT asset_id,
                           merit_order_rank AS block_number,
                           mode() WITHIN GROUP (ORDER BY ROUND(offer_price, 2)) AS price_mode,
                           AVG(offer_price) AS price_avg,
                           MIN(offer_price) AS price_min,
                           MAX(offer_price) AS price_max,
                           AVG(block_mw)    AS block_mw,
                           COUNT(*)         AS observations
                    FROM aeso_merit_order
                    WHERE offer_price IS NOT NULL AND block_mw > 0
                      {season_sql}
                    GROUP BY asset_id, merit_order_rank
                    ORDER BY asset_id, merit_order_rank
                """, params)
                blocks = cur.fetchall()
            except Exception as e:
                logger.warning("merit-order blocks unavailable (%s) — using carrier fallback prices", e)

            # asset_id -> [ {block_number, price, mw, observations}, ... ]
            _PRICE_COL = {"mode": 2, "avg": 3, "min": 4, "max": 5}[estimator]
            offer_blocks: dict[str, list[dict[str, Any]]] = {}
            for row in blocks:
                price, mw = row[_PRICE_COL], row[6]
                if price is None or mw is None:
                    continue
                offer_blocks.setdefault(row[0], []).append({
                    "block_number": row[1],
                    "price": float(price),
                    "mw": float(mw),
                    "observations": int(row[7]),
                })
            for lst in offer_blocks.values():
                lst.sort(key=lambda b: b["price"])   # cheapest first = merit order
    finally:
        conn.close()

    if not assets:
        logger.warning("aeso_asset_registry empty — keeping aggregated LTP blocks")
        return None

    generators: list[dict[str, Any]] = []
    unmapped: dict[str, float] = {}
    capacity_mismatch: dict[str, tuple[float, float]] = {}
    mapped_mw = 0.0
    total_mw = 0.0
    priced_real = 0
    mw_by_confidence: dict[str, float] = {"high": 0.0, "low": 0.0}

    for asset_id, name, fuel, sub_fuel, cap, location, status in assets:
        cap = float(cap)

        # Skip retired/inactive BEFORE counting toward the fleet total, or
        # coverage is measured against a denominator that includes plants that
        # no longer exist. (The registry holds 1,573 retired assets.)
        if status and str(status).strip().lower() in {
            "retired", "decommissioned", "cancelled", "inactive", "suspended"
        }:
            continue

        total_mw += cap

        # Location column first (empty in practice today), then plant name.
        bus = _map_location(location)
        confidence = "high" if bus else None
        if bus is None:
            bus, confidence = _map_asset_name(name)

        if bus is None:
            key = str(name or asset_id or "(unnamed)")
            unmapped[key] = unmapped.get(key, 0.0) + cap
            continue

        mw_by_confidence[confidence or "low"] = mw_by_confidence.get(confidence or "low", 0.0) + cap

        carrier = _map_carrier(fuel, sub_fuel)
        asset_blocks = offer_blocks.get(asset_id)

        if asset_blocks:
            # ONE COMPONENT PER BLOCK. Each keeps its own offered price, so a
            # unit whose first block is free stays free for that much capacity
            # and only becomes expensive further up its own curve.
            #
            # Renewables offer at $0 and efficient gas offers its FIRST block at
            # $0 to stay in merit — that zero-priced tranche is most of why
            # Alberta settles under $30 for three quarters of the year. Averaging
            # it against the same unit's $999.99 cap block erased it entirely.
            offered_mw = sum(b["mw"] for b in asset_blocks)
            for b in asset_blocks:
                generators.append({
                    "name": f"{asset_id}_b{b['block_number']}_{carrier}",
                    "asset_id": asset_id,
                    "asset_name": name or asset_id,
                    "block_number": b["block_number"],
                    "bus": bus,
                    "carrier": carrier,
                    "p_nom": b["mw"],
                    "marginal_cost": b["price"],
                    "price_source": f"merit_order_{estimator}",
                    "observations": b["observations"],
                    "location_confidence": confidence or "low",
                })
            priced_real += 1
            mapped_mw += offered_mw

            # Offered capacity should broadly track registered capability. A
            # large gap means the asset offered only part of itself in this
            # window (outage, derate, or partial participation) — worth seeing
            # rather than silently accepting.
            if cap > 0 and abs(offered_mw - cap) / cap > 0.25:
                capacity_mismatch[asset_id] = (offered_mw, cap)
        else:
            # No offers in this window: price-takers that never appear in the
            # stack, or units that simply did not offer. Fall back to the
            # carrier assumption at registered capability.
            mc = CARRIER_MC_FALLBACK.get(carrier, 40.0)
            generators.append({
                "name": f"{asset_id}_{carrier}",
                "asset_id": asset_id,
                "asset_name": name or asset_id,
                "block_number": None,
                "bus": bus,
                "carrier": carrier,
                "p_nom": cap,
                "marginal_cost": mc,
                "price_source": "carrier_assumption",
                "location_confidence": confidence or "low",
            })
            mapped_mw += cap

    coverage = mapped_mw / total_mw if total_mw else 0.0

    if unmapped:
        logger.warning("=" * 62)
        logger.warning("UNPLACED AESO assets (%.0f MW, %.1f%% of active fleet):",
                       sum(unmapped.values()), 100 * (1 - coverage))
        for loc, mw in sorted(unmapped.items(), key=lambda kv: -kv[1])[:30]:
            logger.warning("    %-44s %8.1f MW", loc[:44], mw)
        logger.warning("Add these plant names to PLANT_NAME_TO_BUS in aeso_generators.py.")
        logger.warning("They are EXCLUDED from the model, not defaulted to a bus.")
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

    hi_mw = mw_by_confidence.get("high", 0.0)
    diagnostics = {
        "unit_count": len(generators),
        "mapped_mw": round(mapped_mw, 1),
        "total_active_registry_mw": round(total_mw, 1),
        "location_coverage_pct": round(100 * coverage, 1),
        # Location provenance. AESO publishes NO generator locations, so buses
        # come from a hand-built plant-name map — see PLANT_NAME_TO_BUS. State
        # this wherever congestion output is shown.
        "location_method": "plant_name_map (AESO publishes no location data)",
        "high_confidence_mw": round(hi_mw, 1),
        "low_confidence_mw": round(mw_by_confidence.get("low", 0.0), 1),
        "high_confidence_pct_of_placed": round(100 * hi_mw / mapped_mw, 1) if mapped_mw else 0.0,
        "assets_with_real_offers": priced_real,
        "assets_with_assumed_price": sum(1 for g in generators
                                         if g["price_source"] == "carrier_assumption"),
        "offer_blocks": sum(1 for g in generators if g.get("block_number") is not None),
        "price_estimator": estimator,
        "offer_window": window_desc,
        "distinct_price_steps": len({round(g["marginal_cost"], 2) for g in generators}),
        # How much capacity sits at or near zero. Renewables offer at $0 and
        # efficient gas offers its FIRST block at $0 to stay in merit, so this
        # tranche is most of why Alberta settles under $30 three quarters of the
        # year. A per-asset average destroyed it — this figure makes its
        # survival checkable at a glance.
        "zero_priced_mw": round(sum(g["p_nom"] for g in generators
                                    if g["marginal_cost"] <= 0.01), 1),
        "capacity_at_cap_mw": round(sum(g["p_nom"] for g in generators
                                        if g["marginal_cost"] >= 999.0), 1),
        "capacity_by_bus_mw": {k: round(v, 1) for k, v in sorted(by_bus.items())},
        "unplaced_assets_mw": {k: round(v, 1) for k, v in
                               sorted(unmapped.items(), key=lambda kv: -kv[1])[:30]},
        "offered_vs_registered_mismatch": {
            k: {"offered_mw": round(v[0], 1), "registered_mw": round(v[1], 1)}
            for k, v in sorted(capacity_mismatch.items(),
                               key=lambda kv: -abs(kv[1][0] - kv[1][1]))[:15]
        },
    }

    logger.info(
        "Real AESO stack: %d components from %d assets (%d offer blocks, %s over %s), "
        "%.0f MW placed (%.0f%% of fleet), %d distinct price steps, "
        "%.0f MW at $0 / %.0f MW at cap",
        len(generators), priced_real + diagnostics["assets_with_assumed_price"],
        diagnostics["offer_blocks"], estimator, window_desc,
        mapped_mw, 100 * coverage, diagnostics["distinct_price_steps"],
        diagnostics["zero_priced_mw"], diagnostics["capacity_at_cap_mw"],
    )
    if capacity_mismatch:
        logger.info("  %d assets offered materially less/more than registered capability "
                    "(outage, derate or partial participation)", len(capacity_mismatch))

    return {"generators": generators, "diagnostics": diagnostics}
