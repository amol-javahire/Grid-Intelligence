"""
ERCOT Tier 2 — Real-topology PyPSA Network
-------------------------------------------
Loads 340 real 345kV buses + k-NN transmission graph from the ercot_buses /
ercot_lines DB tables (seeded by seed_topology.py), then assigns the 787 real
EIA 860 ERCOT generators (from the candidates table) to their nearest bus via
Haversine.

Bus load assignment (Tier 2):
  Priority 1 — PTDF shift factors (ercot_bus_shift_factors table):
    load_mw[bus] = zone_load_mw[eia_zone] × shift_factor[bus]
  Priority 2 — Capacity-weighted fallback (when shift factors unavailable):
    load_mw[bus] = system_load_mw × zone_share × (bus_cap / zone_cap)

Zone loads:
  Historical mode: actual EIA-930 values from ercot_load_by_zone (run_opf passes them in)
  Synthetic mode:  system_load_mw × EIA_ZONE_SYNTHETIC_SHARE

Tier 1 fallback (5-bus hardcoded) is used when DB tables are empty.
"""

import os, math, logging
import pypsa
import pandas as pd
import numpy as np
from typing import Any

logger = logging.getLogger("pypsa-engine")

HEAT_RATE_CC  = 7_500
HEAT_RATE_CT  = 10_000

BASE_MC: dict[str, float] = {
    "nuclear": 5.0, "hydro": 2.0, "biomass": 15.0,
    "wind": 0.0, "solar": 0.0, "storage": 0.0, "peaker": 499.0,
}

MAX_CF: dict[str, float] = {
    "gas_cc": 1.0, "gas_ct": 1.0, "nuclear": 0.92,
    "wind": 0.35, "solar": 0.22, "storage": 1.0, "hydro": 1.0, "biomass": 1.0,
}

# Legacy ERCOT LZ zone share — only used for Tier-2 capacity-weighted fallback
ZONE_LOAD_SHARE: dict[str, float] = {
    "LZ_HOUSTON": 0.335,
    "LZ_NORTH":   0.215,
    "LZ_SOUTH":   0.170,
    "LZ_WEST":    0.105,
    "LZ_AEN":     0.065,
    "LZ_CPS":     0.060,
    "LZ_LCRA":    0.025,
    None:          0.025,
}

# EIA sub-BA zone share of ERCOT system load (calibrated to EIA-930 averages)
# Used when real zone loads are unavailable (synthetic mode + shift factors)
EIA_ZONE_SYNTHETIC_SHARE: dict[str, float] = {
    "COAS": 0.330,  # Houston metro
    "NCEN": 0.215,  # Dallas / Fort Worth
    "SCEN": 0.170,  # San Antonio / Austin
    "NRTH": 0.075,  # North Texas
    "SOUT": 0.080,  # South Texas
    "FWES": 0.065,  # Far West / Permian
    "WEST": 0.035,  # West Texas / Lubbock
    "EAST": 0.030,  # East Texas
}


def _marginal_cost(carrier: str, gas_price: float) -> float:
    if carrier == "gas_cc":
        return round(HEAT_RATE_CC / 1_000 * gas_price, 2)
    if carrier == "gas_ct":
        return round(HEAT_RATE_CT / 1_000 * gas_price, 2)
    return BASE_MC.get(carrier, 30.0)


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.asin(min(1.0, math.sqrt(a)))


# ── DB topology loader ────────────────────────────────────────────────────────

def _load_topology_from_db() -> tuple[list[dict], list[dict]]:
    try:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        cur = conn.cursor()
        cur.execute("""
            SELECT bus_name, load_zone, hub, lat, lon, location_source
            FROM ercot_buses
            WHERE lat IS NOT NULL AND lon IS NOT NULL
            ORDER BY id
        """)
        buses = [
            {"name": r[0], "zone": r[1], "hub": r[2],
             "lat": float(r[3]), "lon": float(r[4]), "src": r[5]}
            for r in cur.fetchall()
        ]
        cur.execute("""
            SELECT from_bus, to_bus, length_km, x_pu, s_nom_mw
            FROM ercot_lines
            ORDER BY id
        """)
        lines = [
            {"from": r[0], "to": r[1],
             "length_km": float(r[2] or 50),
             "x_pu": float(r[3]),
             "s_nom": float(r[4])}
            for r in cur.fetchall()
        ]
        conn.close()
        return buses, lines
    except Exception as e:
        logger.warning("Could not load topology from DB (%s) — using Tier 1 fallback", e)
        return [], []


def _load_shift_factors_from_db() -> dict[str, dict]:
    """Load PTDF-derived bus shift factors from ercot_bus_shift_factors.
    Returns {bus_name: {"eia_zone": str, "shift_factor": float}} or {} if unavailable."""
    try:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        cur = conn.cursor()
        cur.execute("""
            SELECT bus_name, eia_zone, shift_factor
            FROM ercot_bus_shift_factors
            WHERE shift_factor > 0
        """)
        rows = cur.fetchall()
        conn.close()
        return {r[0]: {"eia_zone": r[1], "shift_factor": float(r[2])} for r in rows}
    except Exception as e:
        logger.warning("Could not load shift factors from DB: %s", e)
        return {}


def _load_zone_data_from_db(year: int, month: int, day: int, hour: int) -> dict[str, float] | None:
    try:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        cur = conn.cursor()
        cur.execute("""
            SELECT zone, CAST(load_mw AS float)
            FROM ercot_load_by_zone
            WHERE year = %s AND month = %s AND day = %s AND hour = %s
        """, (year, month, day, hour))
        rows = cur.fetchall()
        conn.close()
        if not rows:
            return None
        return {r[0]: r[1] for r in rows}
    except Exception as e:
        logger.warning("Could not load zone data from DB: %s", e)
        return None


def _load_gas_price_from_db(year: int, month: int, day: int) -> float | None:
    """Return Henry Hub spot price for the given date (or closest prior trading day)."""
    try:
        import psycopg2
        from datetime import date as _date
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        cur = conn.cursor()
        cur.execute("""
            SELECT price FROM gas_prices
            WHERE hub = 'henry_hub' AND date <= %s AND price > 0
            ORDER BY date DESC LIMIT 1
        """, (_date(year, month, day),))
        row = cur.fetchone()
        conn.close()
        return float(row[0]) if row else None
    except Exception as e:
        logger.warning("Could not load gas price from DB: %s", e)
        return None


def _load_fuel_mix_from_db(year: int, month: int, day: int, hour: int) -> dict[str, float] | None:
    try:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        cur = conn.cursor()
        cur.execute("""
            SELECT fuel_type, CAST(gen_mw AS float)
            FROM ercot_fuel_mix
            WHERE year = %s AND month = %s AND day = %s AND hour = %s
        """, (year, month, day, hour))
        rows = cur.fetchall()
        conn.close()
        if not rows:
            return None
        return {r[0]: r[1] for r in rows}
    except Exception as e:
        logger.warning("Could not load fuel mix from DB: %s", e)
        return None


def _derive_cfs_from_fuel_mix(fuel_mix: dict[str, float], year: int) -> dict[str, float]:
    wind_cap  = 40_000 if year <= 2024 else (45_000 if year == 2025 else 49_000)
    solar_cap = 24_000 if year <= 2024 else (33_000 if year == 2025 else 42_000)
    wind_mw  = fuel_mix.get("wind",  0.0)
    solar_mw = fuel_mix.get("solar", 0.0)
    wind_cf  = max(0.03, min(0.95, wind_mw  / max(wind_cap,  1)))
    solar_cf = max(0.00, min(0.95, solar_mw / max(solar_cap, 1)))
    return {"wind_cf": wind_cf, "solar_cf": solar_cf}


def _load_eia860_generators() -> list[dict]:
    try:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        cur = conn.cursor()
        cur.execute("""
            SELECT name, asset_type, capacity_mw, latitude, longitude
            FROM candidates
            WHERE market = 'ERCOT'
              AND capacity_mw IS NOT NULL
              AND latitude IS NOT NULL AND longitude IS NOT NULL
        """)
        rows = cur.fetchall()
        conn.close()
        return [
            {"name": r[0], "asset_type": str(r[1] or ""),
             "mw": float(r[2]), "lat": float(r[3]), "lon": float(r[4])}
            for r in rows
        ]
    except Exception as e:
        logger.warning("Could not load EIA 860 generators from DB: %s", e)
        return []


def _asset_type_to_carrier(asset_type: str) -> str:
    t = asset_type.lower()
    if "nuclear" in t:                           return "nuclear"
    if "wind" in t:                              return "wind"
    if "solar" in t or "pv" in t:               return "solar"
    if "storage" in t or "battery" in t:         return "storage"
    if "hydro" in t:                             return "hydro"
    if "biomass" in t or "landfill" in t:        return "biomass"
    if "combined" in t or "cc" in t:             return "gas_cc"
    if "gas" in t or "peaker" in t or "ct" in t: return "gas_ct"
    return "gas_ct"


# ── Tier 1 fallback (5-bus hardcoded) ────────────────────────────────────────

_T1_BUSES = {
    "NORTH":   {"hub": "HB_NORTH",   "label": "North (Dallas/FW)",       "x": -97.0,  "y": 33.0},
    "WEST":    {"hub": "HB_WEST",    "label": "West Texas (CREZ)",        "x": -101.0, "y": 32.0},
    "PAN":     {"hub": "HB_PAN",     "label": "Panhandle (Wind)",         "x": -101.5, "y": 35.5},
    "SOUTH":   {"hub": "HB_SOUTH",   "label": "South (San Antonio/Hill)", "x": -98.5,  "y": 29.5},
    "HOUSTON": {"hub": "HB_HOUSTON", "label": "Houston / Coast",          "x": -95.4,  "y": 29.8},
}

_T1_LINES = [
    {"name": "NORTH-HOUSTON", "bus0": "NORTH",   "bus1": "HOUSTON", "s_nom": 4200, "x": 0.08},
    {"name": "NORTH-WEST",    "bus0": "NORTH",   "bus1": "WEST",    "s_nom": 2000, "x": 0.12},
    {"name": "NORTH-SOUTH",   "bus0": "NORTH",   "bus1": "SOUTH",   "s_nom": 1400, "x": 0.14},
    {"name": "WEST-PAN",      "bus0": "WEST",    "bus1": "PAN",     "s_nom": 1600, "x": 0.10},
    {"name": "WEST-SOUTH",    "bus0": "WEST",    "bus1": "SOUTH",   "s_nom": 600,  "x": 0.16},
    {"name": "SOUTH-HOUSTON", "bus0": "SOUTH",   "bus1": "HOUSTON", "s_nom": 2800, "x": 0.10},
]

_T1_FLEET = [
    ("NORTH", "gas_cc",  4243, 5), ("NORTH", "gas_ct",  474, 8),
    ("NORTH", "wind",    9613, 40), ("NORTH", "solar",  4901, 27),
    ("NORTH", "storage", 668, 12), ("NORTH", "hydro",   114, 2),
    ("WEST",  "gas_cc",  7709, 10), ("WEST",  "gas_ct",  330, 26),
    ("WEST",  "wind",    7434, 40), ("WEST",  "solar",  4154, 27),
    ("WEST",  "storage", 1364, 14), ("WEST",  "hydro",   73, 3),
    ("PAN",   "wind",    1458, 7),
    ("SOUTH", "gas_cc",  24691, 41), ("SOUTH", "gas_ct", 1818, 39),
    ("SOUTH", "nuclear", 2709, 1),   ("SOUTH", "wind",  14776, 70),
    ("SOUTH", "solar",   9479, 75),  ("SOUTH", "storage",3635, 67),
    ("SOUTH", "hydro",   301, 9),    ("SOUTH", "biomass", 127, 4),
    ("HOUSTON","gas_cc", 55877, 165), ("HOUSTON","gas_ct",1099, 97),
    ("HOUSTON","nuclear",2430, 1),    ("HOUSTON","wind",  5286, 25),
    ("HOUSTON","solar",  3637, 28),   ("HOUSTON","storage",2394, 31),
    ("HOUSTON","hydro",   82, 6),     ("HOUSTON","biomass",  3, 1),
]

_T1_LOAD = {"HOUSTON": 0.38, "NORTH": 0.22, "SOUTH": 0.27, "WEST": 0.11, "PAN": 0.02}
_T1_PEAKER = {"NORTH": 20000, "WEST": 15000, "PAN": 10000, "SOUTH": 25000, "HOUSTON": 25000}

# ── Public aliases (backward-compat for simulators.py) ───────────────────────
BUSES = _T1_BUSES
LINES = _T1_LINES
LOAD_FRACTIONS = _T1_LOAD
HUB_MAP: dict[str, str] = {bus_id: meta["hub"] for bus_id, meta in _T1_BUSES.items()}
HIDDEN_CARRIERS: set[str] = {"peaker"}
GENERATORS: list[dict] = [
    {
        "name": f"{bus[:3]}-{carrier}",
        "bus": bus,
        "carrier": carrier,
        "p_nom": float(total_mw),
        "marginal_cost": _marginal_cost(carrier, 3.5),
        "p_max_pu": MAX_CF.get(carrier, 1.0),
    }
    for (bus, carrier, total_mw, _) in _T1_FLEET
]


def _build_tier1(
    system_load_mw, wind_cf, solar_cf, gas_price,
    gas_derate_pct: float = 0.0, nuclear_derate_pct: float = 0.0, voll: float | None = None,
):
    n = pypsa.Network()
    n.set_snapshots(pd.DatetimeIndex(["2025-07-15 15:00"]))
    for bus_id, meta in _T1_BUSES.items():
        n.add("Bus", bus_id, x=meta["x"], y=meta["y"])
    for line in _T1_LINES:
        n.add("Line", line["name"], bus0=line["bus0"], bus1=line["bus1"],
              s_nom=float(line["s_nom"]), x=float(line["x"]))
    for bus_id, frac in _T1_LOAD.items():
        n.add("Load", f"{bus_id}-load", bus=bus_id, p_set=system_load_mw * frac)
    for (bus, carrier, total_mw, _) in _T1_FLEET:
        mc = _marginal_cost(carrier, gas_price)
        cf = wind_cf if carrier == "wind" else (solar_cf if carrier == "solar" else MAX_CF.get(carrier, 1.0))
        if carrier in ("gas_cc", "gas_ct"):
            cf *= (1 - gas_derate_pct / 100)
        elif carrier == "nuclear":
            cf *= (1 - nuclear_derate_pct / 100)
        n.add("Generator", f"{bus[:3]}-{carrier}", bus=bus, carrier=carrier,
              p_nom=float(total_mw), marginal_cost=mc, p_max_pu=max(0.0, cf), p_min_pu=0.0)
    peaker_mc = voll if voll is not None else 499.0
    for bus_id, p_nom in _T1_PEAKER.items():
        n.add("Generator", f"{bus_id[:3]}-peaker", bus=bus_id, carrier="peaker",
              p_nom=float(p_nom), marginal_cost=peaker_mc, p_max_pu=1.0, p_min_pu=0.0)
    return n


# ── Tier 2 builder ────────────────────────────────────────────────────────────

def _build_tier2(
    buses: list[dict],
    lines: list[dict],
    generators: list[dict],
    system_load_mw: float,
    wind_cf: float,
    solar_cf: float,
    gas_price: float,
    zone_loads: dict[str, float] | None = None,
    shift_factors: dict[str, dict] | None = None,
    gas_derate_pct: float = 0.0,
    nuclear_derate_pct: float = 0.0,
    voll: float | None = None,
) -> pypsa.Network:
    """Build a PyPSA network from real 340-bus topology + EIA 860 generators.

    Bus load assignment (in priority order):
      1. PTDF shift factors × EIA zone loads  (most physically accurate)
      2. Capacity-weighted within LZ zone      (fallback)
    """
    n = pypsa.Network()
    n.set_snapshots(pd.DatetimeIndex(["2025-07-15 15:00"]))

    bus_set = {b["name"] for b in buses}

    for b in buses:
        n.add("Bus", b["name"], x=b["lon"], y=b["lat"])

    for i, l in enumerate(lines):
        if l["from"] not in bus_set or l["to"] not in bus_set:
            continue
        n.add("Line", f"L{i}", bus0=l["from"], bus1=l["to"],
              s_nom=l["s_nom"], x=l["x_pu"])

    # ── Assign EIA 860 generators to nearest bus ───────────────────────────────
    bus_arr = [(b["name"], b["lat"], b["lon"], b["zone"]) for b in buses]

    def nearest_bus(lat: float, lon: float) -> str:
        best_name, best_d = bus_arr[0][0], 1e9
        for name, blat, blon, _ in bus_arr:
            d = _haversine(lat, lon, blat, blon)
            if d < best_d:
                best_name, best_d = name, d
        return best_name

    bus_gen: dict[tuple[str, str], float] = {}
    for g in generators:
        carrier = _asset_type_to_carrier(g["asset_type"])
        bus = nearest_bus(g["lat"], g["lon"])
        key = (bus, carrier)
        bus_gen[key] = bus_gen.get(key, 0.0) + g["mw"]

    for (bus, carrier), mw in bus_gen.items():
        if bus not in bus_set:
            continue
        mc = _marginal_cost(carrier, gas_price)
        cf = wind_cf if carrier == "wind" else (solar_cf if carrier == "solar" else MAX_CF.get(carrier, 1.0))
        if carrier in ("gas_cc", "gas_ct"):
            cf *= (1 - gas_derate_pct / 100)
        elif carrier == "nuclear":
            cf *= (1 - nuclear_derate_pct / 100)
        n.add("Generator", f"{bus}-{carrier}", bus=bus, carrier=carrier,
              p_nom=mw, marginal_cost=mc, p_max_pu=max(0.0, cf), p_min_pu=0.0)

    # ── Assign bus loads ───────────────────────────────────────────────────────
    bus_cap: dict[str, float] = {}
    for (bus, carrier), mw in bus_gen.items():
        bus_cap[bus] = bus_cap.get(bus, 0.0) + mw

    bus_zone = {b["name"]: b["zone"] for b in buses}

    use_shift_factors = bool(shift_factors)
    load_assigned_count = 0

    if use_shift_factors:
        # Path 1: PTDF shift factors × EIA zone loads
        # Compute EIA zone loads (real if provided, else synthetic share)
        eia_zone_loads: dict[str, float] = {}
        if zone_loads:
            # zone_loads is {EIA_zone_code: mw} from ercot_load_by_zone
            eia_zone_loads = zone_loads
        else:
            # Synthetic: distribute system_load_mw by EIA zone share
            for zone_code, share in EIA_ZONE_SYNTHETIC_SHARE.items():
                eia_zone_loads[zone_code] = system_load_mw * share

        for b in buses:
            bname = b["name"]
            sf_entry = shift_factors.get(bname)
            if sf_entry is None:
                continue
            eia_zone = sf_entry["eia_zone"]
            sf = sf_entry["shift_factor"]
            zone_load_mw = eia_zone_loads.get(eia_zone, 0.0)
            load_mw = zone_load_mw * sf
            if load_mw < 0.5:
                continue
            n.add("Load", f"{bname}-load", bus=bname, p_set=load_mw)
            load_assigned_count += 1

        logger.info(
            "Tier 2 PTDF load: %d buses loaded, total=%.0f MW (real_zone_data=%s)",
            load_assigned_count, sum(eia_zone_loads.values()), zone_loads is not None
        )

    else:
        # Path 2: Capacity-weighted within ERCOT LZ zone (legacy fallback)
        zone_cap: dict[str | None, float] = {}
        for bus, cap in bus_cap.items():
            z = bus_zone.get(bus)
            zone_cap[z] = zone_cap.get(z, 0.0) + cap

        for b in buses:
            zone = b["zone"]
            zone_share = ZONE_LOAD_SHARE.get(zone, 0.025)
            bus_total_cap = bus_cap.get(b["name"], 0.0)
            zone_total_cap = zone_cap.get(zone, 1.0)
            cap_frac = bus_total_cap / max(zone_total_cap, 1.0) if zone_total_cap > 0 else 0.0
            load_mw = system_load_mw * zone_share * cap_frac
            if load_mw < 1.0:
                continue
            n.add("Load", f"{b['name']}-load", bus=b["name"], p_set=load_mw)
            load_assigned_count += 1

        logger.info("Tier 2 capacity-weighted load: %d buses loaded", load_assigned_count)

    # ── Emergency peakers at major zone hubs ──────────────────────────────────
    # Keeps large zone-level reserves (visible in dispatch chart)
    PEAKER_ZONES = {
        "LZ_HOUSTON": 30000, "LZ_NORTH": 20000, "LZ_SOUTH": 20000,
        "LZ_WEST": 15000, "LZ_AEN": 8000, "LZ_CPS": 8000, "LZ_LCRA": 5000,
    }
    zone_top_bus: dict[str, tuple[str, float]] = {}
    for bus, cap in bus_cap.items():
        zone = bus_zone.get(bus)
        if zone and (zone not in zone_top_bus or cap > zone_top_bus[zone][1]):
            zone_top_bus[zone] = (bus, cap)

    peaker_mc = voll if voll is not None else 499.0
    lsr_mc = (voll * 2) if voll is not None else 999.0

    for zone, (bus, _) in zone_top_bus.items():
        pnom = max(PEAKER_ZONES.get(zone, 5000), system_load_mw * 0.30)
        n.add("Generator", f"{bus}-peaker", bus=bus, carrier="peaker",
              p_nom=float(pnom), marginal_cost=peaker_mc, p_max_pu=1.0, p_min_pu=0.0)

    # ── Per-bus last-resort generators (guarantee LP feasibility at any load) ─
    # At high system loads (≥70 GW) or whenever zone peakers can't reach every
    # loaded bus via transmission, the LP becomes infeasible. Adding a small
    # last-resort generator at each loaded bus (cost $999/MWh) ensures the
    # problem always has a feasible solution — they only dispatch if transmission
    # is genuinely insufficient to serve local load.
    for load_name in list(n.loads.index):
        bus_name = str(n.loads.at[load_name, "bus"])
        load_set  = float(n.loads.at[load_name, "p_set"])
        gen_name  = f"{bus_name}-lsr"
        if gen_name not in n.generators.index:
            n.add("Generator", gen_name, bus=bus_name, carrier="peaker",
                  p_nom=load_set * 1.3, marginal_cost=lsr_mc,
                  p_max_pu=1.0, p_min_pu=0.0)

    return n


# ── Public API ────────────────────────────────────────────────────────────────

def build_network(
    system_load_mw: float = 55000.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 3.50,
    zone_loads: dict[str, float] | None = None,
    gas_derate_pct: float = 0.0,
    nuclear_derate_pct: float = 0.0,
    voll: float | None = None,
) -> pypsa.Network:
    buses, lines = _load_topology_from_db()
    if not buses:
        logger.info("Using Tier 1 (5-bus fallback)")
        return _build_tier1(
            system_load_mw, wind_cf, solar_cf, gas_price_mmbtu,
            gas_derate_pct=gas_derate_pct, nuclear_derate_pct=nuclear_derate_pct, voll=voll,
        )
    generators = _load_eia860_generators()
    shift_factors = _load_shift_factors_from_db()
    logger.info(
        "Tier 2: %d buses, %d lines, %d generators, %d shift factors",
        len(buses), len(lines), len(generators), len(shift_factors)
    )
    return _build_tier2(
        buses, lines, generators,
        system_load_mw, wind_cf, solar_cf, gas_price_mmbtu,
        zone_loads=zone_loads,
        shift_factors=shift_factors or None,
        gas_derate_pct=gas_derate_pct, nuclear_derate_pct=nuclear_derate_pct, voll=voll,
    )


# ── Bus → hub aggregation (used by scarcity to roll 340 buses into 5 hubs) ────

_LZ_TO_HUB: dict[str, str] = {
    "LZ_HOUSTON": "HOUSTON",
    "LZ_NORTH":   "NORTH",
    "LZ_WEST":    "WEST",
    "LZ_SOUTH":   "SOUTH",
    "LZ_AEN":     "SOUTH",
    "LZ_CPS":     "SOUTH",
    "LZ_LCRA":    "SOUTH",
}


def bus_hub_map(buses: list[dict]) -> dict[str, str]:
    """Map every Tier-2 bus to one of the 5 ERCOT hub labels (HOUSTON/NORTH/
    WEST/SOUTH/PAN), using in priority order:
      1. The bus's own `hub` column (only ~88/340 buses have this set).
      2. Its ERCOT load-zone (`zone`), mapped via _LZ_TO_HUB.
      3. Nearest hub-labeled bus by haversine distance (last resort).
    """
    result: dict[str, str] = {}
    hub_labeled: list[tuple[float, float, str]] = []

    for b in buses:
        hub = b.get("hub")
        if hub:
            label = hub.replace("HB_", "")
            result[b["name"]] = label
            hub_labeled.append((b["lat"], b["lon"], label))

    for b in buses:
        name = b["name"]
        if name in result:
            continue
        zone = b.get("zone")
        if zone in _LZ_TO_HUB:
            result[name] = _LZ_TO_HUB[zone]
            continue
        if hub_labeled:
            best_label, best_d = "SOUTH", 1e9
            for hlat, hlon, label in hub_labeled:
                d = _haversine(b["lat"], b["lon"], hlat, hlon)
                if d < best_d:
                    best_d, best_label = d, label
            result[name] = best_label
        else:
            result[name] = "SOUTH"

    return result


def run_opf(
    system_load_mw: float = 55000.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 3.50,
    gas_derate_pct: float = 0.0,
    simulation_datetime: str | None = None,
) -> dict[str, Any]:
    """Run DC OPF. If simulation_datetime (ISO8601) is provided, real hourly
    ERCOT zone loads and fuel-mix-derived CFs override the synthetic parameters."""

    data_source = "synthetic"
    actual_zone_loads: dict[str, float] | None = None

    if simulation_datetime:
        try:
            from datetime import datetime as _dt
            dt = _dt.fromisoformat(simulation_datetime.replace("Z", "+00:00"))
            yr, mo, dy, hr = dt.year, dt.month, dt.day, dt.hour
            actual_zone_loads = _load_zone_data_from_db(yr, mo, dy, hr)
            fuel_mix = _load_fuel_mix_from_db(yr, mo, dy, hr)
            if actual_zone_loads and fuel_mix:
                total_load = sum(actual_zone_loads.values())
                system_load_mw = total_load
                cfs = _derive_cfs_from_fuel_mix(fuel_mix, yr)
                wind_cf  = cfs["wind_cf"]
                solar_cf = cfs["solar_cf"]
                real_gas = _load_gas_price_from_db(yr, mo, dy)
                if real_gas is not None:
                    gas_price_mmbtu = real_gas
                data_source = f"historical:{simulation_datetime}"
                logger.info(
                    "Historical mode %s: load=%.0f MW wind_cf=%.3f solar_cf=%.3f gas=%.2f zones=%s",
                    simulation_datetime, system_load_mw, wind_cf, solar_cf, gas_price_mmbtu,
                    {z: round(v, 0) for z, v in actual_zone_loads.items()}
                )
            else:
                logger.warning("No DB data for %s — using synthetic params", simulation_datetime)
        except Exception as e:
            logger.warning("Could not parse simulation_datetime '%s': %s", simulation_datetime, e)

    buses_db, lines_db = _load_topology_from_db()
    tier = 2 if buses_db else 1

    # Pass real zone loads into build_network so Tier 2 can use PTDF shift factors
    n = build_network(
        system_load_mw, wind_cf, solar_cf, gas_price_mmbtu,
        zone_loads=actual_zone_loads,
        gas_derate_pct=gas_derate_pct,
    )

    try:
        n.optimize(solver_name="highs")
    except Exception as e:
        return {"error": f"OPF failed: {e}"}

    if n.objective is None:
        return {"error": "Optimization infeasible"}

    # ── Collect LMPs ──────────────────────────────────────────────────────────
    lmp: dict[str, float] = {}
    for bus_id in n.buses.index:
        try:
            val = float(n.buses_t.marginal_price.get(bus_id, pd.Series([0.0])).iloc[0])
        except Exception:
            val = 0.0
        lmp[bus_id] = round(val, 2)

    # ── Collect dispatch ──────────────────────────────────────────────────────
    all_dispatch: dict[str, float] = {}
    for g in n.generators.index:
        try:
            all_dispatch[g] = float(n.generators_t.p[g].iloc[0])
        except Exception:
            all_dispatch[g] = 0.0

    def _get_load_mw(load_name: str) -> float:
        if load_name not in n.loads.index:
            return 0.0
        if hasattr(n, "loads_t") and load_name in getattr(n.loads_t, "p", pd.DataFrame()).columns:
            return float(n.loads_t.p[load_name].iloc[0])
        if load_name in getattr(n.loads_t, "p_set", pd.DataFrame()).columns:
            return float(n.loads_t.p_set[load_name].iloc[0])
        return float(n.loads.at[load_name, "p_set"])

    # ── Bus results ───────────────────────────────────────────────────────────
    buses_result = []
    if tier == 2:
        for b in buses_db:
            bname = b["name"]
            load_mw = _get_load_mw(f"{bname}-load")
            gen_mw = sum(d for g, d in all_dispatch.items() if n.generators.at[g, "bus"] == bname)
            buses_result.append({
                "id": bname, "hub": b.get("hub") or bname,
                "label": bname, "zone": b.get("zone"),
                "lat": b["lat"], "lon": b["lon"],
                "lmp": lmp.get(bname, 0.0),
                "load_mw": round(load_mw, 0),
                "gen_mw": round(gen_mw, 0),
                "net_export_mw": round(gen_mw - load_mw, 0),
            })
    else:
        for bus_id, meta in _T1_BUSES.items():
            load_mw = _get_load_mw(f"{bus_id}-load")
            gen_mw = sum(d for g, d in all_dispatch.items()
                         if n.generators.at[g, "bus"] == bus_id)
            buses_result.append({
                "id": bus_id, "hub": meta["hub"],
                "label": meta["label"], "zone": bus_id,
                "lat": meta["y"], "lon": meta["x"],
                "lmp": lmp.get(bus_id, 0.0),
                "load_mw": round(load_mw, 0),
                "gen_mw": round(gen_mw, 0),
                "net_export_mw": round(gen_mw - load_mw, 0),
            })

    # ── Line results ──────────────────────────────────────────────────────────
    lines_result = []
    for line_id in n.lines.index:
        try:
            flow = float(n.lines_t.p0[line_id].iloc[0])
        except Exception:
            flow = 0.0
        cap = float(n.lines.at[line_id, "s_nom"])
        loading_pct = abs(flow) / cap * 100 if cap > 0 else 0.0
        b0 = n.lines.at[line_id, "bus0"]
        b1 = n.lines.at[line_id, "bus1"]
        cong_rent = abs(lmp.get(b1, 0) - lmp.get(b0, 0)) * abs(flow) / 1000.0
        lines_result.append({
            "name": line_id, "bus0": b0, "bus1": b1,
            "flow_mw": round(flow, 1),
            "capacity_mw": cap,
            "loading_pct": round(loading_pct, 1),
            "congestion_rent_k$": round(cong_rent, 1),
            "is_congested": loading_pct >= 95.0,
        })

    # ── Generator results (non-peaker, aggregated by carrier) ────────────────
    carrier_totals: dict[str, dict[str, float]] = {}
    for g in n.generators.index:
        carrier = n.generators.at[g, "carrier"]
        if carrier == "peaker":
            continue
        if carrier not in carrier_totals:
            carrier_totals[carrier] = {"dispatch": 0.0, "capacity": 0.0}
        carrier_totals[carrier]["dispatch"] += all_dispatch.get(g, 0.0)
        carrier_totals[carrier]["capacity"] += float(n.generators.at[g, "p_nom"])

    gen_result = [
        {"name": c, "carrier": c,
         "dispatch_mw": round(v["dispatch"], 1),
         "capacity_mw": round(v["capacity"], 0),
         "cf": round(v["dispatch"] / max(v["capacity"], 1), 3),
         "marginal_cost": round(_marginal_cost(c, gas_price_mmbtu), 2)}
        for c, v in carrier_totals.items()
    ]

    wind_mw    = carrier_totals.get("wind",    {}).get("dispatch", 0)
    solar_mw   = carrier_totals.get("solar",   {}).get("dispatch", 0)
    nuclear_mw = carrier_totals.get("nuclear", {}).get("dispatch", 0)
    gas_mw     = (carrier_totals.get("gas_cc", {}).get("dispatch", 0) +
                  carrier_totals.get("gas_ct", {}).get("dispatch", 0))
    total_gen  = sum(v["dispatch"] for v in carrier_totals.values())

    all_lmps = list(lmp.values())
    total_cost = sum(
        all_dispatch.get(g, 0.0) * float(n.generators.at[g, "marginal_cost"])
        for g in n.generators.index
    )

    return {
        "status": "optimal",
        "model_version": f"tier{tier}_{'db' if tier==2 else 'eia860'}",
        "tier": tier,
        "data_source": data_source,
        "bus_count": len(buses_result),
        "line_count": len(lines_result),
        "system_load_mw": system_load_mw,
        "gas_price_mmbtu": gas_price_mmbtu,
        "total_cost_per_hour": round(total_cost, 0),
        "renewable_pct": round((wind_mw + solar_mw) / max(total_gen, 1) * 100, 1),
        "wind_mw":    round(wind_mw, 0),
        "solar_mw":   round(solar_mw, 0),
        "nuclear_mw": round(nuclear_mw, 0),
        "gas_mw":     round(gas_mw, 0),
        "avg_lmp":  round(sum(all_lmps) / len(all_lmps), 2) if all_lmps else 0,
        "max_lmp":  max(all_lmps) if all_lmps else 0,
        "min_lmp":  min(all_lmps) if all_lmps else 0,
        "lmp_spread": round(max(all_lmps) - min(all_lmps), 2) if all_lmps else 0,
        "congested_lines": sum(1 for l in lines_result if l["is_congested"]),
        "buses":      buses_result,
        "lines":      lines_result,
        "generators": gen_result,
    }


def get_topology() -> dict[str, Any]:
    """Static topology — buses + lines. Used by /pypsa/network endpoint."""
    buses_db, lines_db = _load_topology_from_db()

    if not buses_db:
        return {
            "model_version": "tier1_eia860",
            "tier": 1,
            "buses": [
                {"id": bid, "hub": m["hub"], "label": m["label"],
                 "lat": m["y"], "lon": m["x"], "zone": bid}
                for bid, m in _T1_BUSES.items()
            ],
            "lines": [
                {"name": l["name"], "bus0": l["bus0"], "bus1": l["bus1"],
                 "s_nom": l["s_nom"], "x": l["x"]}
                for l in _T1_LINES
            ],
        }

    return {
        "model_version": "tier2_real_topology",
        "tier": 2,
        "bus_count": len(buses_db),
        "line_count": len(lines_db),
        "buses": [
            {"id": b["name"], "hub": b.get("hub") or b["name"],
             "label": b["name"], "lat": b["lat"], "lon": b["lon"],
             "zone": b["zone"], "location_source": b.get("src")}
            for b in buses_db
        ],
        "lines": [
            {"name": f"{l['from']}-{l['to']}", "bus0": l["from"], "bus1": l["to"],
             "s_nom": l["s_nom"], "x_pu": l["x_pu"], "length_km": l["length_km"]}
            for l in lines_db
        ],
    }
