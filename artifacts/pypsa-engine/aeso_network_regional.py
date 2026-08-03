"""
aeso_network_regional.py — 9-bus Alberta DC OPF, built from AESO's own
published planning data
============================================================================

This is a second, larger network alongside aeso_network.py's original
3-bus illustrative model. It does NOT replace that model — the 3-bus model
stays as-is (still labeled "Alberta 3-Bus Illustrative", still Phase-0
honest). This module is what the AESO_PYPSA_VALIDATION.md doc calls
"Phase 2": more buses, built from real AESO source documents instead of an
academic 3-zone guess.

WHERE EVERY NUMBER CAME FROM — read before trusting a figure
--------------------------------------------------------------------------
Six internal buses = AESO's own 2025 Long-Term Transmission Plan (LTP)
planning regions, verbatim (Northwest, Northeast, Central, Edmonton,
Calgary, South). Load and generation-by-fuel-type figures for each are the
"Existing (MW)" column from that document's per-region forecast tables
(Tables 11, 14, 17, 18, 21, 23):
  https://www.aeso.ca/assets/2025-AESO-Long-Term-Transmission-Plan.pdf

Three boundary buses (BC, Montana, Saskatchewan) use AESO's own published
Available Transfer Capability figures, "System Normal" condition (both
seasons unless noted):
  https://www.aeso.ca/assets/Information-Documents/2011-001R-ATC-and-Transfer-Path-Management-2023-03-10.pdf
  BC import 800 MW / export 1000 MW (Tables 1a/1b, 2a/2b)
  Montana (MATL) import 310 MW / export 315 MW (Tables 3a, 3b)
  Saskatchewan import 153 MW / export 153 MW (Tables 4a, 4b)

Two internal HVDC backbone lines have real, publicly documented ratings:
  WATL (Edmonton <-> Calgary, 500kV HVDC): 1,000 MW initial capacity
  EATL (Edmonton <-> South/Newell, 500kV HVDC bipole): 1,000 MW initial
    capacity (expandable to 2,000 MW per ATCO/Wikipedia, not yet built out)

EVERYTHING ELSE ON THIS LIST IS NOT SOURCED THIS PRECISELY. The remaining
five internal AC ties (Edmonton-Northeast, Edmonton-Northwest,
Edmonton-Central, Central-Calgary, Calgary-South) are qualitatively
described in the 2025 LTP (which 240kV/500kV corridors exist, roughly how
congested they are) but the LTP explicitly says exact thermal capability
numbers now live in a separate AESO product — the Transmission Capability
Map and Cluster Assessment Reporting — which has not been fetched into this
project yet. Those five line limits below are ENGINEERING-JUDGMENT
ESTIMATES sized relative to the real load/generation magnitudes of the
regions they connect, explicitly flagged via capacity_source="estimated" in
get_topology_regional() and in every OPF result. Do not present these five
numbers as AESO-published in an interview — the two HVDC lines and three
boundary interties are the only line ratings that are.

WHAT THIS MODEL DOES NOT DO
--------------------------------------------------------------------------
- No historical replay / calibration against real settlement data (that's
  Phase 3 in the validation doc).
- No sub-regional split of South into Southeast/Southwest — the 2025 LTP
  publishes South as one combined load/generation figure; the qualitative
  text describes two sub-regions with different transmission paths (CBW
  path for Southeast, Montana-intertie collector system for Southwest) but
  does not publish a separate load/generation table for each, so this
  model does not fabricate a split. Splitting South is a natural Phase 2.5
  refinement once the Transmission Capability Map is available.
- Same single-snapshot DC-OPF design as the 3-bus model (no chronological
  simulation, no storage state-of-charge across periods).
"""

import logging
import pypsa
import numpy as np
import pandas as pd
from typing import Optional

logger = logging.getLogger("pypsa-engine")


# ─── Bus definitions ─────────────────────────────────────────────────────────
# lat/lon are representative points (regional capital / major substation
# area), not official AESO zone centroids.

BUSES = {
    "NORTHWEST": {"x": -117.85, "y": 55.17, "kind": "region", "description": "AESO Northwest planning region (Grande Prairie / Peace River / Valleyview-Fox Creek)"},
    "NORTHEAST": {"x": -111.38, "y": 56.73, "kind": "region", "description": "AESO Northeast planning region (Fort McMurray oil sands cogeneration)"},
    "CENTRAL":   {"x": -113.80, "y": 52.27, "kind": "region", "description": "AESO Central planning region (Red Deer / Hanna / Bickerdike)"},
    "EDMONTON":  {"x": -113.49, "y": 53.55, "kind": "region", "description": "AESO Edmonton planning region — provincial transmission hub"},
    "CALGARY":   {"x": -114.07, "y": 51.05, "kind": "region", "description": "AESO Calgary planning region — southern transmission hub"},
    "SOUTH":     {"x": -112.83, "y": 49.85, "kind": "region", "description": "AESO South planning region (Lethbridge / Pincher Creek / Brooks — combined Southeast+Southwest, not split)"},
    "BC":        {"x": -118.20, "y": 50.90, "kind": "boundary", "description": "Alberta-BC intertie boundary (ties at Langdon, near Calgary)"},
    "MT":        {"x": -112.83, "y": 49.00, "kind": "boundary", "description": "Alberta-Montana (MATL) intertie boundary (South/Southwest sub-area)"},
    "SK":        {"x": -110.10, "y": 51.65, "kind": "boundary", "description": "Alberta-Saskatchewan intertie boundary (McNeill converter, near Hanna/Central)"},
}

# (from_bus, to_bus, limit_mw, reactance_pu, capacity_source)
LINES = [
    # ── Sourced: real published ratings ──────────────────────────────────
    ("EDMONTON", "CALGARY", 1000.0, 0.10, "sourced:WATL 500kV HVDC, 1000MW initial capacity"),
    ("EDMONTON", "SOUTH",   1000.0, 0.10, "sourced:EATL 500kV HVDC, 1000MW initial capacity (expandable to 2000MW, not yet built)"),
    ("CALGARY",  "BC",       800.0, 0.05, "sourced:AESO ATC 2011-001R Table 1a/1b, BC->AB import TTC system-normal"),
    ("SOUTH",    "MT",       310.0, 0.05, "sourced:AESO ATC 2011-001R Table 3a, MT->AB import TTC system-normal"),
    ("CENTRAL",  "SK",       153.0, 0.05, "sourced:AESO ATC 2011-001R Table 4a, SK->AB import TTC"),
    # ── Estimated: real corridors exist per 2025 LTP text, thermal rating
    #    is engineering judgment pending AESO's Transmission Capability Map ──
    ("EDMONTON", "NORTHEAST", 2500.0, 0.15, "estimated:500kV loop + Fort McMurray West line, rating not sourced"),
    ("EDMONTON", "NORTHWEST",  900.0, 0.20, "estimated:240kV Wabamun-fed corridor, rating not sourced"),
    ("EDMONTON", "CENTRAL",   3500.0, 0.08, "estimated:half of 'six 240kV lines Edmonton-Calgary through Central', rating not sourced"),
    ("CENTRAL",  "CALGARY",   3500.0, 0.08, "estimated:other half of the six-240kV-line corridor, rating not sourced"),
    ("CALGARY",  "SOUTH",    3000.0, 0.12, "estimated:Windy Flats + Cassils/Newell-Milo-Langdon paths combined, rating not sourced"),
]

# Generation by (region, carrier) — MW, "Existing (MW)" column, AESO 2025 LTP
# Tables 11 (NW), 14 (NE), 17 (Central), 18 (Edmonton), 21 (Calgary), 23 (South).
# carrier -> assumed marginal cost $/MWh (screening-level, not AESO-published):
#   wind/solar 0, hydro 5, cogen 45, ccgt 55 (incl. coal-to-gas conversions,
#   which now burn gas), scgt 120, storage 20, other 40
REGION_GENERATION = {
    "NORTHWEST": {"cogen": 162, "ccgt": 373, "scgt": 440, "other": 207, "storage": 100},
    "NORTHEAST": {"cogen": 4500, "solar": 58, "other": 149},
    "CENTRAL":   {"ccgt": 1450, "cogen": 1223, "scgt": 47, "hydro": 485, "wind": 1334, "solar": 247, "other": 50, "storage": 88},
    "EDMONTON":  {"ccgt": 3131, "cogen": 92, "scgt": 270, "solar": 32},  # coal-to-gas (1725) folded into ccgt; component sum (3255) vs AESO-stated regional total (3348) differs by 93MW, source table as-published
    "CALGARY":   {"cogen": 29, "ccgt": 1318, "scgt": 144, "solar": 139, "other": 10, "storage": 10},
    "SOUTH":     {"ccgt": 1042, "cogen": 146, "scgt": 261, "hydro": 409, "wind": 4328, "solar": 2392, "other": 42, "storage": 167},  # coal-to-gas (800) folded into ccgt
}

CARRIER_MC = {"wind": 0.0, "solar": 0.0, "hydro": 5.0, "cogen": 45.0, "ccgt": 55.0,
              "scgt": 120.0, "storage": 20.0, "other": 40.0}
CARRIER_CF = {"wind": 0.35, "solar": 0.22}  # p_max_pu for variable resources; overridable

# Existing regional peak load, MW — AESO 2025 LTP, same tables as above
REGION_LOAD = {
    "NORTHWEST": 1185.0, "NORTHEAST": 3600.0, "CENTRAL": 2187.0,
    "EDMONTON": 2198.0, "CALGARY": 1936.0, "SOUTH": 1558.0,
}
TOTAL_BASE_LOAD = sum(REGION_LOAD.values())  # 12,664 MW

MODEL_LABEL = "Alberta 9-Bus Regional (2025 LTP-derived)"
MODEL_DISCLAIMER = (
    "Six internal buses are AESO's own 2025 Long-Term Transmission Plan planning "
    "regions with that document's published load/generation figures. Three "
    "boundary buses (BC/MT/SK) use AESO's own published Available Transfer "
    "Capability figures. Two internal lines (Edmonton-Calgary via WATL, "
    "Edmonton-South via EATL) use real published HVDC ratings. The remaining "
    "five internal AC line ratings are engineering-judgment ESTIMATES, not "
    "sourced to a specific AESO capability figure — see capacity_source per "
    "line. This is not a historical-replay or calibrated model (no chronological "
    "simulation, no settlement-data backtest) and South is not split into "
    "Southeast/Southwest sub-regions."
)


def _dependency_versions() -> dict:
    versions = {"pypsa": getattr(pypsa, "__version__", "unknown"),
                "numpy": np.__version__, "pandas": pd.__version__}
    try:
        import highspy
        versions["highspy"] = getattr(highspy, "__version__", "unknown")
    except Exception:
        versions["highspy"] = "not importable"
    return versions


def build_network(
    system_load_scale: float = 1.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 4.50,
    line_overrides: Optional[dict] = None,
    use_real_generators: bool = True,
) -> pypsa.Network:
    """
    Build the 9-bus network. system_load_scale multiplies every region's
    "Existing (MW)" load uniformly (e.g. 1.1 for a +10% provincial demand
    scenario) — a simple lever since per-region load *forecasts* (Near-Term /
    Longer-Term columns) exist in the LTP but aren't wired in yet.
    """
    net = pypsa.Network()
    net.set_snapshots(pd.RangeIndex(1))

    for bus, meta in BUSES.items():
        net.add("Bus", bus, x=meta["x"], y=meta["y"])

    # Slack at EDMONTON — the provincial transmission hub, matching its role
    # in the real topology (500kV loop connects it to every other region).
    net.add("Generator", "_slack_EDMONTON", bus="EDMONTON", carrier="slack",
             p_nom=25_000, marginal_cost=1_000.0)

    overrides = line_overrides or {}
    for (f, t, default_lim, x, source) in LINES:
        key = f"{f}-{t}"
        lim = overrides.get(key, default_lim)
        net.add("Line", key, bus0=f, bus1=t, x=x, s_nom=lim)

    gas_mw_cost = gas_price_mmbtu * 7.0  # ~7.0 MMBtu/MWh average fleet heat rate

    # ── Supply stack ──────────────────────────────────────────────────────────
    # Preferred: ~230 REAL units from aeso_asset_registry, priced from real
    # aeso_merit_order offers. Fallback: the ~30 aggregated (region, carrier)
    # LTP blocks below.
    #
    # This matters for congestion, not cosmetics. The aggregated stack has only
    # ~6 distinct prices, so a 1,000 MW load swing leaves the same block
    # marginal and every bus returns an identical, unchanging LMP — which is
    # what was reported 2026-08 and looked like a solver bug but is just the
    # arithmetic of a 6-step supply curve. Real per-unit offers give hundreds
    # of steps, so the marginal unit — and therefore LMP — actually moves.
    real_stack = None
    if use_real_generators:
        try:
            from aeso_generators import load_real_generators
            real_stack = load_real_generators()
        except Exception as e:
            logger.warning("Real generator load failed (%s) — using LTP blocks", e)
            real_stack = None

    if real_stack:
        for g in real_stack["generators"]:
            carrier = g["carrier"]
            # Gas units still track the gas-price lever ONLY where the price is
            # an assumption. A real submitted offer already embeds that unit's
            # own fuel cost and must not be overwritten by a generic heat rate.
            mc = g["marginal_cost"]
            if g["price_source"] == "carrier_assumption":
                if carrier == "ccgt":
                    mc = gas_mw_cost
                elif carrier == "cogen":
                    mc = gas_mw_cost * 0.82
                elif carrier == "scgt":
                    mc = gas_mw_cost * 1.7
            p_max_pu = wind_cf if carrier == "wind" else solar_cf if carrier == "solar" else 1.0
            net.add("Generator", g["name"], bus=g["bus"], carrier=carrier,
                    p_nom=g["p_nom"], marginal_cost=mc,
                    p_max_pu=p_max_pu, p_min_pu=0.0)
        net._aeso_stack_source = "asset_registry"          # type: ignore[attr-defined]
        net._aeso_stack_diagnostics = real_stack["diagnostics"]  # type: ignore[attr-defined]
    else:
        for region, fuels in REGION_GENERATION.items():
            for carrier, p_nom in fuels.items():
                mc = CARRIER_MC[carrier]
                if carrier == "ccgt":
                    mc = gas_mw_cost
                elif carrier == "cogen":
                    mc = gas_mw_cost * 0.82  # cogen typically more efficient / partially offset by heat sales
                elif carrier == "scgt":
                    mc = gas_mw_cost * 1.7  # open-cycle peaker heat rate penalty
                p_max_pu = 1.0
                if carrier == "wind":
                    p_max_pu = wind_cf
                elif carrier == "solar":
                    p_max_pu = solar_cf
                net.add("Generator", f"{carrier}_{region}", bus=region, carrier=carrier,
                         p_nom=p_nom, marginal_cost=mc, p_max_pu=p_max_pu, p_min_pu=0.0)
        net._aeso_stack_source = "ltp_aggregated_blocks"   # type: ignore[attr-defined]
        net._aeso_stack_diagnostics = {
            "unit_count": sum(len(f) for f in REGION_GENERATION.values()),
            "distinct_price_steps": len(set(CARRIER_MC.values())),
            "note": "Aggregated LTP blocks — too coarse for meaningful nodal price separation.",
        }  # type: ignore[attr-defined]

    for region, load_mw in REGION_LOAD.items():
        net.add("Load", f"Load_{region}", bus=region, p_set=load_mw * system_load_scale)

    return net


def run_opf(
    system_load_scale: float = 1.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 4.50,
    line_overrides: Optional[dict] = None,
) -> dict:
    net = build_network(system_load_scale, wind_cf, solar_cf, gas_price_mmbtu, line_overrides)

    try:
        opt_result = net.optimize(solver_name="highs")
    except Exception as e:
        return {"error": f"OPF solver failed: {e}", "model_label": MODEL_LABEL}

    if isinstance(opt_result, tuple) and len(opt_result) == 2:
        solver_status, termination_condition = opt_result
    else:
        solver_status, termination_condition = ("unknown", "unknown")

    solved_ok = (solver_status == "ok") and (termination_condition in ("optimal", "optimal_inaccurate"))
    if not solved_ok or net.buses_t.marginal_price.empty:
        return {
            "error": f"OPF did not reach an optimal solution (solver_status={solver_status!r}, termination_condition={termination_condition!r})",
            "solver_status": solver_status, "termination_condition": termination_condition,
            "model_label": MODEL_LABEL,
        }

    lmps: dict[str, float] = {}
    for bus in BUSES:
        try:
            lmps[bus] = round(float(net.buses_t.marginal_price.get(bus, pd.Series([np.nan]))[0]), 4)
        except Exception:
            lmps[bus] = 0.0

    bus_loads = {bus: REGION_LOAD.get(bus, 0.0) * system_load_scale for bus in BUSES}
    total_load = sum(bus_loads.values())
    avg_lmp_load_weighted = round(sum(lmps[b] * bus_loads[b] for b in BUSES) / max(total_load, 1e-6), 4)
    avg_lmp_unweighted = round(float(np.mean(list(lmps.values()))), 4)

    line_source = {f"{f}-{t}": src for (f, t, _l, _x, src) in LINES}
    line_results = []
    congested_lines = []
    for line_name in net.lines.index:
        try:
            flow = float(net.lines_t.p0[line_name][0])
            limit = float(net.lines.loc[line_name, "s_nom"])
            loading_pct = abs(flow) / limit * 100.0 if limit > 0 else 0.0
            near_limit = loading_pct >= 98.0
            binding = None
            congestion_basis = "loading_threshold_98pct"
            try:
                mu_upper = float(net.lines_t.mu_upper[line_name].iloc[0]) if line_name in getattr(net.lines_t, "mu_upper", pd.DataFrame()).columns else None
                mu_lower = float(net.lines_t.mu_lower[line_name].iloc[0]) if line_name in getattr(net.lines_t, "mu_lower", pd.DataFrame()).columns else None
                if mu_upper is not None or mu_lower is not None:
                    binding = abs(mu_upper or 0.0) > 1e-4 or abs(mu_lower or 0.0) > 1e-4
                    congestion_basis = "shadow_price_dual"
            except Exception:
                binding = None
            is_congested = binding if binding is not None else near_limit
            src = line_source.get(line_name, "unknown")
            line_results.append({
                "name": line_name, "flow_mw": round(flow, 2), "limit_mw": round(limit, 2),
                "loading_pct": round(loading_pct, 2), "near_limit": near_limit, "binding": binding,
                "congestion_basis": congestion_basis, "congested": is_congested,
                "capacity_source": src.split(":", 1)[0], "capacity_note": src.split(":", 1)[1] if ":" in src else "",
            })
            if is_congested:
                congested_lines.append(line_name)
        except Exception:
            pass

    dispatch = {}
    total_gen_by_carrier: dict[str, float] = {}
    slack_p = 0.0
    for gen_name in net.generators.index:
        try:
            p = float(net.generators_t.p[gen_name][0])
        except Exception:
            continue
        if gen_name.startswith("_slack"):
            slack_p += p
            continue
        try:
            carrier = net.generators.loc[gen_name, "carrier"]
            bus = net.generators.loc[gen_name, "bus"]
            dispatch[gen_name] = {
                "bus": bus, "carrier": carrier, "p_mw": round(p, 2),
                "p_nom": round(float(net.generators.loc[gen_name, "p_nom"]), 2),
                "utilization_pct": round(p / max(float(net.generators.loc[gen_name, "p_nom"]), 1) * 100, 2),
            }
            total_gen_by_carrier[carrier] = total_gen_by_carrier.get(carrier, 0.0) + p
        except Exception:
            pass

    unserved_load_mw = round(slack_p, 2)
    model_status = "load_shed" if unserved_load_mw > 1.0 else "optimal"

    total_cost = sum(dispatch[g]["p_mw"] * float(net.generators.loc[g, "marginal_cost"]) for g in dispatch)
    slack_cost = slack_p * float(net.generators.loc["_slack_EDMONTON", "marginal_cost"]) if slack_p else 0.0
    total_cost += slack_cost

    total_dispatch_incl_slack = sum(float(net.generators_t.p[g][0]) for g in net.generators.index)
    energy_balance_residual_mw = round(total_dispatch_incl_slack - total_load, 4)

    return {
        "model_label": MODEL_LABEL,
        "disclaimer": MODEL_DISCLAIMER,
        # Which supply stack actually produced these prices. 'asset_registry' =
        # ~230 real units with real merit-order offers; 'ltp_aggregated_blocks'
        # = ~30 coarse blocks with ~6 prices, which cannot produce meaningful
        # nodal separation. Surfaced so the UI never presents the coarse model's
        # flat LMPs as a real congestion result.
        "supply_stack_source": getattr(net, "_aeso_stack_source", "unknown"),
        "supply_stack": getattr(net, "_aeso_stack_diagnostics", {}),
        "status": "optimal" if model_status == "optimal" else model_status,
        "solver_status": solver_status,
        "termination_condition": termination_condition,
        "model_status": model_status,
        "unserved_load_mw": unserved_load_mw,
        "energy_balance_residual_mw": energy_balance_residual_mw,
        "dependency_versions": _dependency_versions(),
        "avg_lmp": avg_lmp_load_weighted,
        "avg_lmp_load_weighted": avg_lmp_load_weighted,
        "avg_lmp_unweighted": avg_lmp_unweighted,
        "lmp_spread": round(max(lmps.values()) - min(lmps.values()), 4),
        "total_cost_cad_hr": round(total_cost, 2),
        "slack_cost_cad_hr": round(slack_cost, 2),
        "total_load_mw": round(total_load, 2),
        "lmps": lmps,
        "bus_loads_mw": {b: round(v, 2) for b, v in bus_loads.items()},
        "congestion_active": len(congested_lines) > 0,
        "congested_lines": congested_lines,
        "lines": line_results,
        "dispatch": dispatch,
        "gen_by_carrier_mw": {k: round(v, 2) for k, v in total_gen_by_carrier.items()},
        "inputs": {
            "system_load_scale": system_load_scale, "wind_cf": wind_cf, "solar_cf": solar_cf,
            "gas_price_mmbtu": gas_price_mmbtu,
        },
    }


def get_topology_regional() -> dict:
    """Static topology for map/table rendering — buses, lines with source
    labels, and per-region generation-by-fuel-type composition."""
    return {
        "model": MODEL_LABEL,
        "disclaimer": MODEL_DISCLAIMER,
        "buses": [
            {"name": name, "lat": meta["y"], "lon": meta["x"], "kind": meta["kind"],
             "description": meta["description"], "load_mw": REGION_LOAD.get(name)}
            for name, meta in BUSES.items()
        ],
        "lines": [
            {
                "name": f"{f}-{t}", "from_bus": f, "to_bus": t, "limit_mw": lim,
                "capacity_source": src.split(":", 1)[0],
                "capacity_note": src.split(":", 1)[1] if ":" in src else "",
                "from_lat": BUSES[f]["y"], "from_lon": BUSES[f]["x"],
                "to_lat": BUSES[t]["y"], "to_lon": BUSES[t]["x"],
            }
            for f, t, lim, _x, src in LINES
        ],
        "generation_by_region": REGION_GENERATION,
        "load_by_region_mw": REGION_LOAD,
        "sources": {
            "planning_regions_and_load_gen": "https://www.aeso.ca/assets/2025-AESO-Long-Term-Transmission-Plan.pdf",
            "boundary_intertie_capacity": "https://www.aeso.ca/assets/Information-Documents/2011-001R-ATC-and-Transfer-Path-Management-2023-03-10.pdf",
            "watl_eatl_hvdc_ratings": "https://en.wikipedia.org/wiki/Eastern_Alberta_Transmission_Line",
        },
    }
