"""
ERCOT Real-Fleet 5-Bus PyPSA Network  (Tier 1)
------------------------------------------------
Same 5-zone topology as before, but generator fleet is sourced directly
from the EIA 860 database (787 ERCOT operable generators > 1 MW).

Each bus aggregates real capacity by fuel sub-type:
  - gas_cc  : combined-cycle units (capacity >= 200 MW threshold)
  - gas_ct  : combustion-turbine / peaker gas units
  - nuclear : baseload nuclear
  - wind    : wind farms
  - solar   : utility PV
  - storage : battery / pumped hydro storage
  - hydro   : run-of-river hydro
  - biomass : biomass / landfill gas

Marginal cost model ($/MWh):
  nuclear  :  $5   (baseload — below coal in stack)
  wind     :  $0   (zero-marginal, PTC credit)
  solar    :  $0
  storage  :  $0   (round-trip efficiency modeled via p_min_pu)
  hydro    :  $2   (opportunity cost proxy)
  biomass  :  $15
  gas_cc   :  heat_rate_cc  × gas_price   (EIA avg heat rate 7,500 BTU/kWh)
  gas_ct   :  heat_rate_ct  × gas_price   (EIA avg heat rate 10,000 BTU/kWh)

ERCOT hub/zone → bus mapping:
  NORTH  : HB_NORTH, LZ_NORTH
  WEST   : HB_WEST, LZ_WEST
  PAN    : HB_PAN
  SOUTH  : HB_SOUTH, LZ_SOUTH, LZ_CPS, LZ_AEN, LZ_LCRA
  HOUSTON: LZ_HOUSTON
"""

import pypsa
import pandas as pd
import numpy as np
from typing import Any

# ---------------------------------------------------------------------------
# Bus definitions — 5 geographic zones
# ---------------------------------------------------------------------------
BUSES: dict[str, dict] = {
    "NORTH":   {"x": -97.0,  "y": 33.0, "label": "North (Dallas/FW)",       "hub": "HB_NORTH"},
    "WEST":    {"x": -101.0, "y": 32.0, "label": "West Texas (CREZ)",        "hub": "HB_WEST"},
    "PAN":     {"x": -101.5, "y": 35.5, "label": "Panhandle (Wind)",         "hub": "HB_PAN"},
    "SOUTH":   {"x": -98.5,  "y": 29.5, "label": "South (San Antonio/Hill)", "hub": "HB_SOUTH"},
    "HOUSTON": {"x": -95.4,  "y": 29.8, "label": "Houston / Coast",          "hub": "HB_HOUSTON"},
}

HUB_MAP = {bus: meta["hub"] for bus, meta in BUSES.items()}

# EIA 860 → 5-bus zone mapping  (pricing_hub_node → bus)
ZONE_TO_BUS: dict[str, str] = {
    "HB_NORTH":  "NORTH",
    "LZ_NORTH":  "NORTH",
    "HB_WEST":   "WEST",
    "LZ_WEST":   "WEST",
    "HB_PAN":    "PAN",
    "HB_SOUTH":  "SOUTH",
    "LZ_SOUTH":  "SOUTH",
    "LZ_CPS":    "SOUTH",
    "LZ_AEN":    "SOUTH",
    "LZ_LCRA":   "SOUTH",
    "LZ_HOUSTON":"HOUSTON",
}

# ---------------------------------------------------------------------------
# Transmission lines — calibrated to CREZ TTC corridors
# ---------------------------------------------------------------------------
LINES: list[dict] = [
    {"name": "NORTH-HOUSTON", "bus0": "NORTH",   "bus1": "HOUSTON", "s_nom": 4200, "x": 0.08},
    {"name": "NORTH-WEST",    "bus0": "NORTH",   "bus1": "WEST",    "s_nom": 2000, "x": 0.12},
    {"name": "NORTH-SOUTH",   "bus0": "NORTH",   "bus1": "SOUTH",   "s_nom": 1400, "x": 0.14},
    {"name": "WEST-PAN",      "bus0": "WEST",    "bus1": "PAN",     "s_nom": 1600, "x": 0.10},
    {"name": "WEST-SOUTH",    "bus0": "WEST",    "bus1": "SOUTH",   "s_nom": 600,  "x": 0.16},
    {"name": "SOUTH-HOUSTON", "bus0": "SOUTH",   "bus1": "HOUSTON", "s_nom": 2800, "x": 0.10},
]

# ---------------------------------------------------------------------------
# EIA 860 real fleet — aggregated by bus + carrier (from DB query)
# Units: total_mw from candidates table, market='ERCOT'
# gas sub-type: cc if any unit >= 200 MW avg, else ct
# ---------------------------------------------------------------------------
# Format: (bus, carrier, total_mw, n_units)
_EIA_FLEET_RAW: list[tuple[str, str, float, int]] = [
    # NORTH (HB_NORTH + LZ_NORTH)
    ("NORTH", "gas_cc",  3490 + 753,  5 + 2),
    ("NORTH", "gas_ct",  427 + 47,    8 + 3),
    ("NORTH", "wind",    7157 + 2456, 40 + 8),
    ("NORTH", "solar",   3961 + 940,  27 + 6),
    ("NORTH", "storage", 448 + 220,   12 + 4),
    ("NORTH", "hydro",   114,         2),
    # WEST (HB_WEST + LZ_WEST)
    ("WEST",  "gas_cc",  2605 + 5104, 3 + 7),
    ("WEST",  "gas_ct",  9 + 321,     7 + 26),
    ("WEST",  "wind",    3086 + 4348, 19 + 21),
    ("WEST",  "solar",   1537 + 2617, 10 + 17),
    ("WEST",  "storage", 240 + 1124,  5 + 14),
    ("WEST",  "hydro",   70 + 3,      2 + 1),
    # PAN (HB_PAN)
    ("PAN",   "wind",    1458,        7),
    # SOUTH (HB_SOUTH + LZ_SOUTH + LZ_CPS + LZ_AEN + LZ_LCRA)
    ("SOUTH", "gas_cc",  203 + 3485 + 15341 + 3840 + 1822, 1 + 5 + 25 + 6 + 4),
    ("SOUTH", "gas_ct",  280 + 24 + 859 + 230 + 425,       3 + 4 + 20 + 6 + 6),
    ("SOUTH", "nuclear", 2709,        1),
    ("SOUTH", "wind",    1341 + 2384 + 5500 + 2681 + 2870, 7 + 11 + 24 + 13 + 15),
    ("SOUTH", "solar",   500 + 2125 + 5099 + 816 + 939,    4 + 18 + 41 + 7 + 5),
    ("SOUTH", "storage", 312 + 1011 + 1888 + 151 + 273,    8 + 11 + 39 + 6 + 3),
    ("SOUTH", "hydro",   278 + 23,    6 + 3),
    ("SOUTH", "biomass", 114 + 8 + 5, 1 + 2 + 1),
    # HOUSTON (LZ_HOUSTON)
    ("HOUSTON","gas_cc",  27389 + 28488, 34 + 131),   # HB_SOUTH gas_cc also mapped to HOUSTON bucket
    ("HOUSTON","gas_ct",  1099,          97),
    ("HOUSTON","nuclear", 2430,          1),
    ("HOUSTON","wind",    5286,          25),
    ("HOUSTON","solar",   3637,          28),
    ("HOUSTON","storage", 2394,          31),
    ("HOUSTON","hydro",   82,            6),
    ("HOUSTON","biomass", 3,             1),
]

# EIA average heat rates (BTU/kWh) — used to compute marginal cost
HEAT_RATE_CC  = 7500   # combined cycle
HEAT_RATE_CT  = 10000  # combustion turbine / simple cycle

# p_max_pu by carrier:
#   Thermal / nuclear / hydro → 1.0 (fully dispatchable up to nameplate; OPF decides)
#   Wind / solar → overridden at runtime by wind_cf / solar_cf parameters
#   Storage → 1.0 (OPF dispatches up to nameplate; round-trip losses not modeled in DC OPF)
DEFAULT_CF: dict[str, float] = {
    "gas_cc":  1.0,
    "gas_ct":  1.0,
    "nuclear": 0.92,   # slight derating for planned outage; nuclear runs near max always
    "wind":    0.35,   # overridden at runtime by wind_cf param
    "solar":   0.22,   # overridden at runtime by solar_cf param
    "storage": 1.0,
    "hydro":   1.0,
    "biomass": 1.0,
}

# ERCOT zonal load fractions — calibrated to real ISO settlement data.
# SOUTH aggregates LZ_SOUTH + LZ_CPS (San Antonio) + LZ_AEN + LZ_LCRA.
# PAN (Panhandle) is generation-dominant — tiny residential load vs huge wind export.
LOAD_FRACTIONS: dict[str, float] = {
    "HOUSTON": 0.38,   # LZ_HOUSTON: Gulf Coast industrial + residential core
    "NORTH":   0.22,   # LZ_NORTH: Dallas / Fort Worth metro
    "SOUTH":   0.27,   # LZ_SOUTH + CPS + AEN + LCRA: San Antonio + Hill Country
    "WEST":    0.11,   # LZ_WEST: Permian Basin + West Texas industrial
    "PAN":     0.02,   # Panhandle: sparse load, wind-export zone
}

# Carriers whose dispatch is hidden from the main generator table in the API
HIDDEN_CARRIERS: set[str] = {"peaker"}


def _base_marginal_cost(carrier: str, gas_price_mmbtu: float) -> float:
    """Compute $/MWh marginal cost from carrier + real-time gas price."""
    if carrier == "gas_cc":
        return round(HEAT_RATE_CC / 1000 * gas_price_mmbtu, 2)
    if carrier == "gas_ct":
        return round(HEAT_RATE_CT / 1000 * gas_price_mmbtu, 2)
    return {
        "nuclear":  5.0,
        "wind":     0.0,
        "solar":    0.0,
        "storage":  0.0,
        "hydro":    2.0,
        "biomass": 15.0,
        "peaker": 499.0,
    }.get(carrier, 30.0)


def build_network(
    system_load_mw: float = 55000.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 3.50,
) -> pypsa.Network:
    """
    Build and return a PyPSA Network using the real EIA 860 ERCOT generator fleet.

    Parameters
    ----------
    system_load_mw : float
        Total ERCOT system load (MW). Default ~55 GW (typical mid-day).
    wind_cf : float
        Fleet-wide wind capacity factor (0–1). Default 0.35.
    solar_cf : float
        Fleet-wide solar capacity factor (0–1). Default 0.22.
    gas_price_mmbtu : float
        Natural gas price ($/MMBTU). Default $3.50 (Henry Hub).
    """
    n = pypsa.Network()
    n.set_snapshots(pd.DatetimeIndex(["2025-07-15 15:00"]))

    # Buses
    for bus_id, meta in BUSES.items():
        n.add("Bus", bus_id, x=meta["x"], y=meta["y"])

    # Lines
    for line in LINES:
        n.add("Line",
              line["name"],
              bus0=line["bus0"],
              bus1=line["bus1"],
              s_nom=float(line["s_nom"]),
              x=float(line["x"]))

    # Loads — distribute system load by zone fractions
    for bus_id, frac in LOAD_FRACTIONS.items():
        n.add("Load", f"{bus_id}-load", bus=bus_id, p_set=system_load_mw * frac)

    # Real EIA 860 generators
    for (bus, carrier, total_mw, n_units) in _EIA_FLEET_RAW:
        mc = _base_marginal_cost(carrier, gas_price_mmbtu)
        cf = wind_cf if carrier == "wind" else (solar_cf if carrier == "solar" else DEFAULT_CF.get(carrier, 0.8))
        gen_name = f"{bus[:3]}-{carrier}"
        n.add("Generator",
              gen_name,
              bus=bus,
              carrier=carrier,
              p_nom=float(total_mw),
              marginal_cost=mc,
              p_max_pu=cf,
              p_min_pu=0.0)

    # Emergency peakers at each zone — prevent infeasibility under extreme load
    # Represent oil peakers + demand response available at ERCOT price cap
    peaker_mw = {
        "NORTH":   20000,
        "WEST":    15000,
        "PAN":     10000,
        "SOUTH":   25000,
        "HOUSTON": 25000,
    }
    for bus_id, p_nom in peaker_mw.items():
        n.add("Generator",
              f"{bus_id[:3]}-peaker",
              bus=bus_id,
              carrier="peaker",
              p_nom=float(p_nom),
              marginal_cost=499.0,
              p_max_pu=1.0,
              p_min_pu=0.0)

    return n


def run_opf(
    system_load_mw: float = 55000.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 3.50,
) -> dict[str, Any]:
    """
    Run DC OPF with the real EIA 860 fleet and return structured results.
    """
    n = build_network(system_load_mw, wind_cf, solar_cf, gas_price_mmbtu)

    status = n.optimize(solver_name="highs")

    if n.objective is None:
        return {"error": "Optimization failed — check feasibility"}

    # Nodal LMPs
    lmp: dict[str, float] = {}
    for bus_id in BUSES:
        try:
            val = float(n.buses_t.marginal_price.get(bus_id, pd.Series([0.0])).iloc[0])
        except Exception:
            val = 0.0
        lmp[bus_id] = round(val, 2)

    # Line flows
    lines_result = []
    for line in LINES:
        name = line["name"]
        try:
            flow = float(n.lines_t.p0[name].iloc[0])
        except Exception:
            flow = 0.0
        cap = float(line["s_nom"])
        loading_pct = abs(flow) / cap * 100 if cap > 0 else 0.0
        cong_rent = abs(lmp.get(line["bus1"], 0) - lmp.get(line["bus0"], 0)) * abs(flow) / 1000.0
        lines_result.append({
            "name": name,
            "bus0": line["bus0"],
            "bus1": line["bus1"],
            "flow_mw": round(flow, 1),
            "capacity_mw": cap,
            "loading_pct": round(loading_pct, 1),
            "congestion_rent_k$": round(cong_rent, 1),
            "is_congested": loading_pct >= 95.0,
        })

    # Generator dispatch — collect all (including peakers for bus balance)
    all_dispatch: dict[str, float] = {}
    for gen_name in n.generators.index:
        try:
            all_dispatch[gen_name] = float(n.generators_t.p[gen_name].iloc[0])
        except Exception:
            all_dispatch[gen_name] = 0.0

    # Visible generator results (exclude peakers)
    gen_result = []
    for (bus, carrier, total_mw, n_units) in _EIA_FLEET_RAW:
        gen_name = f"{bus[:3]}-{carrier}"
        dispatch = all_dispatch.get(gen_name, 0.0)
        cf = dispatch / total_mw if total_mw > 0 else 0.0
        mc = _base_marginal_cost(carrier, gas_price_mmbtu)
        gen_result.append({
            "name": gen_name,
            "bus": bus,
            "carrier": carrier,
            "n_units": n_units,
            "dispatch_mw": round(dispatch, 1),
            "capacity_mw": round(total_mw, 0),
            "cf": round(cf, 3),
            "marginal_cost": round(mc, 2),
        })

    # Bus summary
    buses_result = []
    for bus_id, meta in BUSES.items():
        load = system_load_mw * LOAD_FRACTIONS[bus_id]
        gen_at_bus = sum(d for g, d in all_dispatch.items()
                         if n.generators.at[g, "bus"] == bus_id)
        buses_result.append({
            "id": bus_id,
            "hub": HUB_MAP[bus_id],
            "label": meta["label"],
            "x": meta["x"],
            "y": meta["y"],
            "lmp": lmp.get(bus_id, 0.0),
            "load_mw": round(load, 0),
            "gen_mw": round(gen_at_bus, 0),
            "net_export_mw": round(gen_at_bus - load, 0),
        })

    # System totals by carrier
    totals: dict[str, float] = {}
    for gen_name, dispatch in all_dispatch.items():
        carrier = n.generators.at[gen_name, "carrier"]
        totals[carrier] = totals.get(carrier, 0.0) + dispatch

    wind_gen    = totals.get("wind", 0.0)
    solar_gen   = totals.get("solar", 0.0)
    nuclear_gen = totals.get("nuclear", 0.0)
    gas_gen     = totals.get("gas_cc", 0.0) + totals.get("gas_ct", 0.0)
    storage_gen = totals.get("storage", 0.0)
    total_gen   = wind_gen + solar_gen + nuclear_gen + gas_gen + storage_gen

    total_cost = sum(
        all_dispatch.get(g, 0.0) * float(n.generators.at[g, "marginal_cost"])
        for g in n.generators.index
    )

    # Fleet capacity summary per bus
    fleet_summary: dict[str, dict[str, float]] = {}
    for (bus, carrier, total_mw, _) in _EIA_FLEET_RAW:
        fleet_summary.setdefault(bus, {})[carrier] = \
            fleet_summary.get(bus, {}).get(carrier, 0.0) + total_mw

    return {
        "status": "optimal",
        "model_version": "tier1_eia860",
        "fleet_units": len(_EIA_FLEET_RAW),
        "system_load_mw": system_load_mw,
        "gas_price_mmbtu": gas_price_mmbtu,
        "total_cost_per_hour": round(total_cost, 0),
        "renewable_pct": round((wind_gen + solar_gen) / max(total_gen, 1) * 100, 1),
        "wind_mw": round(wind_gen, 0),
        "solar_mw": round(solar_gen, 0),
        "nuclear_mw": round(nuclear_gen, 0),
        "gas_mw": round(gas_gen, 0),
        "storage_mw": round(storage_gen, 0),
        "avg_lmp": round(sum(lmp.values()) / len(lmp), 2),
        "max_lmp": max(lmp.values()),
        "min_lmp": min(lmp.values()),
        "lmp_spread": round(max(lmp.values()) - min(lmp.values()), 2),
        "congested_lines": sum(1 for l in lines_result if l["is_congested"]),
        "buses": buses_result,
        "lines": lines_result,
        "generators": gen_result,
        "fleet_summary": fleet_summary,
    }


def get_topology() -> dict[str, Any]:
    """Return static network topology (buses + lines + fleet summary) without running OPF."""
    fleet_by_bus: dict[str, list[dict]] = {}
    for (bus, carrier, total_mw, n_units) in _EIA_FLEET_RAW:
        fleet_by_bus.setdefault(bus, []).append({
            "carrier": carrier,
            "capacity_mw": total_mw,
            "n_units": n_units,
            "marginal_cost": _base_marginal_cost(carrier, 3.50),
        })

    return {
        "model_version": "tier1_eia860",
        "buses": [
            {
                "id": bid,
                "hub": HUB_MAP[bid],
                "label": meta["label"],
                "x": meta["x"],
                "y": meta["y"],
                "fleet": fleet_by_bus.get(bid, []),
            }
            for bid, meta in BUSES.items()
        ],
        "lines": [
            {**line, "hub0": HUB_MAP[line["bus0"]], "hub1": HUB_MAP[line["bus1"]]}
            for line in LINES
        ],
        "generators": [
            {
                "bus": bus,
                "carrier": carrier,
                "p_nom": total_mw,
                "n_units": n_units,
                "marginal_cost": _base_marginal_cost(carrier, 3.50),
            }
            for (bus, carrier, total_mw, n_units) in _EIA_FLEET_RAW
        ],
    }
