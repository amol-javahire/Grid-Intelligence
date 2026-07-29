"""
aeso_network.py — 3-node Alberta DC OPF using PyPSA
======================================================

Nodes (academic aggregation matching physical Alberta geography):

  SOUTH   — Southern AB wind belt (Medicine Hat / Lethbridge / Pincher Creek)
             Wind: ~6,200 MW | Solar: ~900 MW | Gas: 600 MW | Load: 2,500 MW

  CENTRAL — Edmonton-Calgary corridor (main load centre + dispatch hub)
             Gas: 9,000 MW | Hydro: 900 MW | Load: 9,500 MW

  NORTH   — Oil sands cogeneration belt (Fort McMurray / Peace River)
             Gas/Cogen: 5,000 MW | Biomass: 200 MW | Load: 3,200 MW

Key constraint: SOUTH → CENTRAL Southern Export Corridor (2,800 MW limit)
Interties: BC import (1,200 MW max) and SK (150 MW) wired at CENTRAL.

Alberta runs a single pool price today; this model is a planning/research
tool for AESO's planned Restructured Energy Market (REM) with nodal LMP
(targeted mid-2027). Results show indicative spatial price spreads that
would form under REM-style dispatch.

Note: Alberta has NO coal capacity (phased out by 2023 per Alberta regs).
"""

import pypsa
import numpy as np
import pandas as pd
from typing import Optional


# ─── Network topology constants ───────────────────────────────────────────────

BUSES = {
    "SOUTH": {
        "x": -112.5, "y": 49.8,          # ~Lethbridge area
        "description": "Southern AB wind belt",
    },
    "CENTRAL": {
        "x": -113.8, "y": 53.5,          # ~Edmonton
        "description": "Edmonton-Calgary corridor",
    },
    "NORTH": {
        "x": -111.5, "y": 56.8,          # ~Fort McMurray
        "description": "Oil sands cogeneration belt",
    },
}

# Transmission lines: (from_bus, to_bus, thermal_limit_mw, reactance_pu)
LINES = [
    # Southern Export Corridor — the key binding constraint (high-wind periods)
    ("SOUTH", "CENTRAL", 2800.0, 0.15),
    # North-South 500kV corridor
    ("CENTRAL", "NORTH", 1400.0, 0.20),
    # No direct SOUTH↔NORTH line (all flows via CENTRAL)
]

# Installed capacity by fuel type and node (MW) — 2025 calibrated
GENERATORS = {
    # SOUTH
    ("SOUTH", "Wind_SOUTH"): {
        "carrier": "wind", "p_nom": 6200.0, "marginal_cost": 0.0,
        "capital_cost": 1_500_000,
    },
    ("SOUTH", "Solar_SOUTH"): {
        "carrier": "solar", "p_nom": 900.0, "marginal_cost": 0.0,
        "capital_cost": 1_100_000,
    },
    ("SOUTH", "Gas_SOUTH"): {
        "carrier": "gas", "p_nom": 600.0, "marginal_cost": 65.0,
        "capital_cost": 900_000,
    },
    # CENTRAL — main gas fleet + hydro + BC/SK interties
    ("CENTRAL", "Gas_CENTRAL"): {
        "carrier": "gas", "p_nom": 9000.0, "marginal_cost": 55.0,
        "capital_cost": 900_000,
    },
    ("CENTRAL", "Hydro_CENTRAL"): {
        "carrier": "hydro", "p_nom": 900.0, "marginal_cost": 5.0,
        "capital_cost": 2_000_000,
    },
    ("CENTRAL", "BC_Import"): {
        "carrier": "import_bc", "p_nom": 1200.0, "marginal_cost": 45.0,
        "capital_cost": 0,
    },
    ("CENTRAL", "SK_Import"): {
        "carrier": "import_sk", "p_nom": 150.0, "marginal_cost": 50.0,
        "capital_cost": 0,
    },
    # Emergency peakers to prevent OPF infeasibility at extreme loads
    ("CENTRAL", "Peaker_CENTRAL"): {
        "carrier": "gas", "p_nom": 2000.0, "marginal_cost": 750.0,
        "capital_cost": 0,
    },
    # NORTH — oil sands cogen fleet
    ("NORTH", "GasCogen_NORTH"): {
        "carrier": "gas", "p_nom": 5000.0, "marginal_cost": 48.0,
        "capital_cost": 900_000,
    },
    ("NORTH", "Biomass_NORTH"): {
        "carrier": "biomass", "p_nom": 200.0, "marginal_cost": 35.0,
        "capital_cost": 1_800_000,
    },
    ("NORTH", "Peaker_NORTH"): {
        "carrier": "gas", "p_nom": 800.0, "marginal_cost": 750.0,
        "capital_cost": 0,
    },
    ("SOUTH", "Peaker_SOUTH"): {
        "carrier": "gas", "p_nom": 400.0, "marginal_cost": 750.0,
        "capital_cost": 0,
    },
}

# Peak demand by node (MW) — calibrated to Alberta totals (~10,500 MW peak AIL)
# AESO 2025: peak AIL ~11,800 MW (Dec), summer ~10,200 MW
BASE_LOAD = {
    "SOUTH": 2500.0,
    "CENTRAL": 9500.0,
    "NORTH": 3200.0,
}
TOTAL_BASE = sum(BASE_LOAD.values())   # 15,200 MW = max aggregated demand


# ─── Build and run OPF ────────────────────────────────────────────────────────

def build_network(
    system_load_mw: float = 10500.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 4.50,
    south_central_limit_mw: Optional[float] = None,
    central_north_limit_mw: Optional[float] = None,
    bc_import_mw: Optional[float] = None,
    south_wind_bonus_pct: float = 0.0,
) -> pypsa.Network:
    """
    Build a fresh 3-node Alberta network. Returns the un-optimised network.

    Args:
        system_load_mw:       Total provincial AIL (9,000–12,500 MW realistic)
        wind_cf:              Southern wind capacity factor (0.0–1.0)
        solar_cf:             Southern solar capacity factor (0.0–1.0)
        gas_price_mmbtu:      Natural gas price $/MMBtu (Alberta AECO-C spot)
        south_central_limit_mw: Override SOUTH→CENTRAL corridor limit (default 2800)
        central_north_limit_mw: Override CENTRAL→NORTH limit (default 1400)
        bc_import_mw:         Override max BC import (default 1200)
        south_wind_bonus_pct: Extra wind capacity in SOUTH zone (% boost, e.g. 0.3 = +30%)
    """
    net = pypsa.Network()
    net.set_snapshots(pd.RangeIndex(1))   # single-period DC OPF

    # ── Buses ──────────────────────────────────────────────────────────────────
    for bus, meta in BUSES.items():
        net.add("Bus", bus, x=meta["x"], y=meta["y"])

    # ── Slack generator (CENTRAL = reference bus) ─────────────────────────────
    net.add("Generator", "_slack_CENTRAL",
            bus="CENTRAL", carrier="slack",
            p_nom=25_000, marginal_cost=1_000.0)

    # ── Lines ──────────────────────────────────────────────────────────────────
    sc_limit = south_central_limit_mw if south_central_limit_mw is not None else LINES[0][2]
    cn_limit = central_north_limit_mw if central_north_limit_mw is not None else LINES[1][2]
    limits = [sc_limit, cn_limit]

    for i, (f, t, _default_lim, x) in enumerate(LINES):
        net.add("Line", f"{f}-{t}",
                bus0=f, bus1=t,
                x=x, s_nom=limits[i])

    # ── Gas marginal cost (function of AECO-C price) ──────────────────────────
    # Alberta CC gas heat rate ≈ 7.0 MMBtu/MWh (avg fleet)
    heat_rate = 7.0
    gas_mw_cost = gas_price_mmbtu * heat_rate        # $/MWh variable
    gas_mw_cost_cogen = gas_price_mmbtu * 6.2        # oil sands cogen more efficient
    gas_mw_cost_south = gas_price_mmbtu * 8.5        # SOUTH peakers less efficient

    # ── Generators ─────────────────────────────────────────────────────────────
    wind_south_nom = 6200.0 * (1.0 + south_wind_bonus_pct / 100.0)
    bc_nom = bc_import_mw if bc_import_mw is not None else 1200.0

    for (bus, name), props in GENERATORS.items():
        p_nom = props["p_nom"]
        mc = props["marginal_cost"]

        # Override capacity / costs for parametric runs
        if name == "Wind_SOUTH":
            p_nom = wind_south_nom
            p_max_pu = wind_cf
        elif name == "Solar_SOUTH":
            p_max_pu = solar_cf
        elif name == "Gas_CENTRAL":
            mc = gas_mw_cost
            p_max_pu = 1.0
        elif name == "GasCogen_NORTH":
            mc = gas_mw_cost_cogen
            p_max_pu = 1.0
        elif name == "Gas_SOUTH":
            mc = gas_mw_cost_south
            p_max_pu = 1.0
        elif name == "BC_Import":
            p_nom = bc_nom
            p_max_pu = 1.0
        else:
            p_max_pu = 1.0

        net.add("Generator", name,
                bus=bus,
                carrier=props["carrier"],
                p_nom=p_nom,
                marginal_cost=mc,
                p_max_pu=p_max_pu,
                p_min_pu=0.0)

    # ── Loads — scale proportionally to system_load_mw ────────────────────────
    scale = system_load_mw / TOTAL_BASE
    for bus, base_load in BASE_LOAD.items():
        net.add("Load", f"Load_{bus}", bus=bus, p_set=base_load * scale)

    return net


MODEL_LABEL = "Alberta 3-Bus Illustrative"
MODEL_DISCLAIMER = (
    "Illustrative planning construct, not a validated or historical AESO result. "
    "Alberta operates a single province-wide pool price today — this model does not "
    "reproduce, forecast, or back-test against any real AESO nodal price, congestion "
    "event, or REM outcome. Node boundaries are academic aggregations of AESO's actual "
    "zones, not official AESO designations."
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


def run_opf(
    system_load_mw: float = 10500.0,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 4.50,
    south_central_limit_mw: Optional[float] = None,
    central_north_limit_mw: Optional[float] = None,
    bc_import_mw: Optional[float] = None,
    south_wind_bonus_pct: float = 0.0,
) -> dict:
    """
    Run DC OPF and return LMPs, flows, dispatch, and congestion analytics.

    This is a 3-bus illustrative model (see MODEL_LABEL / MODEL_DISCLAIMER) — it is
    NOT a validated reconstruction of real AESO nodal prices or congestion events.
    """
    net = build_network(
        system_load_mw=system_load_mw,
        wind_cf=wind_cf,
        solar_cf=solar_cf,
        gas_price_mmbtu=gas_price_mmbtu,
        south_central_limit_mw=south_central_limit_mw,
        central_north_limit_mw=central_north_limit_mw,
        bc_import_mw=bc_import_mw,
        south_wind_bonus_pct=south_wind_bonus_pct,
    )

    try:
        opt_result = net.optimize(solver_name="highs")
    except Exception as e:
        return {"error": f"OPF solver failed: {e}", "model_label": MODEL_LABEL}

    # net.optimize() returns (status, termination_condition) in modern PyPSA —
    # don't just assume success; a prior version of this endpoint hardcoded
    # "status": "optimal" regardless of what the solver actually reported.
    if isinstance(opt_result, tuple) and len(opt_result) == 2:
        solver_status, termination_condition = opt_result
    else:
        solver_status, termination_condition = ("unknown", "unknown")

    solved_ok = (solver_status == "ok") and (termination_condition in ("optimal", "optimal_inaccurate"))

    if not solved_ok or net.buses_t.marginal_price.empty:
        return {
            "error": (
                f"OPF did not reach an optimal solution "
                f"(solver_status={solver_status!r}, termination_condition={termination_condition!r})"
            ),
            "solver_status": solver_status,
            "termination_condition": termination_condition,
            "model_label": MODEL_LABEL,
        }

    # ── LMPs (shadow price on nodal balance) ──────────────────────────────────
    lmps: dict[str, float] = {}
    for bus in BUSES:
        try:
            lmp_val = float(net.buses_t.marginal_price.get(bus, pd.Series([np.nan]))[0])
            lmps[bus] = round(lmp_val, 4)
        except Exception:
            lmps[bus] = 0.0

    # Bus loads for this scenario (needed for load-weighted average price and
    # for the energy-balance residual check below).
    scale = system_load_mw / TOTAL_BASE
    bus_loads = {bus: BASE_LOAD[bus] * scale for bus in BUSES}
    total_load_input = sum(bus_loads.values())

    avg_lmp_unweighted = round(float(np.mean(list(lmps.values()))), 4)
    avg_lmp_load_weighted = round(
        sum(lmps[b] * bus_loads[b] for b in BUSES) / max(total_load_input, 1e-6), 4
    )
    lmp_spread = round(max(lmps.values()) - min(lmps.values()), 4)

    # ── Line flows and congestion ─────────────────────────────────────────────
    # "congested" is reported two ways: loading_pct >= 98% (a proximity heuristic)
    # and, where the solver exposes it, whether the line's shadow price (dual) is
    # actually non-zero — the latter is the real test of a binding constraint.
    # A line can be heavily loaded without binding, or the loading heuristic can
    # mislabel a state that isn't actually shadow-priced.
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
                mu_upper = float(net.lines_t.mu_upper[line_name].iloc[0]) if "mu_upper" in dir(net.lines_t) and line_name in getattr(net.lines_t, "mu_upper", pd.DataFrame()).columns else None
                mu_lower = float(net.lines_t.mu_lower[line_name].iloc[0]) if "mu_lower" in dir(net.lines_t) and line_name in getattr(net.lines_t, "mu_lower", pd.DataFrame()).columns else None
                if mu_upper is not None or mu_lower is not None:
                    binding = abs(mu_upper or 0.0) > 1e-4 or abs(mu_lower or 0.0) > 1e-4
                    congestion_basis = "shadow_price_dual"
            except Exception:
                binding = None

            is_congested = binding if binding is not None else near_limit

            line_results.append({
                "name": line_name,
                "flow_mw": round(flow, 2),
                "limit_mw": round(limit, 2),
                "loading_pct": round(loading_pct, 2),
                "near_limit": near_limit,
                "binding": binding,
                "congestion_basis": congestion_basis,
                "congested": is_congested,
            })
            if is_congested:
                congested_lines.append(line_name)
        except Exception:
            pass

    # ── Generator dispatch (slack excluded from the carrier rollup — reported
    #    separately below as an explicit unserved-load signal, not silently) ──
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
                "bus": bus,
                "carrier": carrier,
                "p_mw": round(p, 2),
                "p_nom": round(float(net.generators.loc[gen_name, "p_nom"]), 2),
                "utilization_pct": round(p / max(float(net.generators.loc[gen_name, "p_nom"]), 1) * 100, 2),
            }
            if carrier not in ("slack", "import_bc", "import_sk"):
                total_gen_by_carrier[carrier] = total_gen_by_carrier.get(carrier, 0.0) + p
        except Exception:
            pass

    unserved_load_mw = round(slack_p, 2)
    # Threshold >1 MW to avoid flagging solver noise as "load shed"
    model_status = "load_shed" if unserved_load_mw > 1.0 else "optimal"

    # ── Curtailment analysis ──────────────────────────────────────────────────
    wind_potential = 6200.0 * (1.0 + south_wind_bonus_pct / 100.0) * wind_cf
    solar_potential = 900.0 * solar_cf
    wind_dispatch = dispatch.get("Wind_SOUTH", {}).get("p_mw", 0.0)
    solar_dispatch = dispatch.get("Solar_SOUTH", {}).get("p_mw", 0.0)
    wind_curtailed = max(0.0, wind_potential - wind_dispatch)
    solar_curtailed = max(0.0, solar_potential - solar_dispatch)
    curtailment_pct = (
        (wind_curtailed + solar_curtailed) / max(wind_potential + solar_potential, 1.0) * 100
    )

    # ── Total cost — now INCLUDES slack dispatch, so a run that quietly leans on
    #    the slack generator to serve load doesn't understate system cost. ──────
    total_cost = sum(
        dispatch[g]["p_mw"] * float(net.generators.loc[g, "marginal_cost"])
        for g in dispatch
    )
    slack_cost = slack_p * float(net.generators.loc["_slack_CENTRAL", "marginal_cost"]) if slack_p else 0.0
    total_cost += slack_cost

    # ── Energy balance residual — sanity check that dispatch (incl. slack) matches
    #    the load actually set on the network for this scenario. Should be ~0 for
    #    a lossless DC OPF; a non-trivial residual indicates a modeling bug. ──────
    total_dispatch_incl_slack = sum(float(net.generators_t.p[g][0]) for g in net.generators.index)
    energy_balance_residual_mw = round(total_dispatch_incl_slack - total_load_input, 4)

    # ── Southern Alberta LMP spread (key metric) ──────────────────────────────
    south_central_spread = lmps.get("CENTRAL", 0.0) - lmps.get("SOUTH", 0.0)
    congestion_active = any(r["congested"] for r in line_results)

    return {
        # Model identity / honesty gate — always echoed so no consumer can
        # accidentally present this as real AESO nodal data.
        "model_label": MODEL_LABEL,
        "disclaimer": MODEL_DISCLAIMER,

        # Solver diagnostics — real values from this run, not hardcoded.
        "status": "optimal" if model_status == "optimal" else model_status,
        "solver_status": solver_status,
        "termination_condition": termination_condition,
        "model_status": model_status,
        "unserved_load_mw": unserved_load_mw,
        "energy_balance_residual_mw": energy_balance_residual_mw,
        "dependency_versions": _dependency_versions(),

        # Core results
        "avg_lmp": avg_lmp_load_weighted,
        "avg_lmp_load_weighted": avg_lmp_load_weighted,
        "avg_lmp_unweighted": avg_lmp_unweighted,
        "lmp_spread": lmp_spread,
        "total_cost_cad_hr": round(total_cost, 2),
        "slack_cost_cad_hr": round(slack_cost, 2),
        "system_load_mw": system_load_mw,

        # Node LMPs
        "lmps": lmps,
        "lmp_south": lmps.get("SOUTH", 0.0),
        "lmp_central": lmps.get("CENTRAL", 0.0),
        "lmp_north": lmps.get("NORTH", 0.0),

        # Congestion analytics
        "congestion_active": congestion_active,
        "congested_lines": congested_lines,
        "south_central_spread_cad_mwh": round(south_central_spread, 4),
        "south_wind_curtailed_mw": round(wind_curtailed, 2),
        "solar_curtailed_mw": round(solar_curtailed, 2),
        "curtailment_pct": round(curtailment_pct, 2),

        # Transmission
        "lines": line_results,

        # Generation dispatch
        "dispatch": dispatch,
        "gen_by_carrier_mw": {k: round(v, 2) for k, v in total_gen_by_carrier.items()},

        # Scenario inputs (echo back for UI)
        "inputs": {
            "wind_cf": wind_cf,
            "solar_cf": solar_cf,
            "gas_price_mmbtu": gas_price_mmbtu,
            "system_load_mw": system_load_mw,
            "south_central_limit_mw": south_central_limit_mw or LINES[0][2],
            "central_north_limit_mw": central_north_limit_mw or LINES[1][2],
        },
    }


def get_topology() -> dict:
    """Return static topology for map rendering."""
    return {
        "model": MODEL_LABEL,
        "disclaimer": MODEL_DISCLAIMER,
        "buses": [
            {
                "name": name,
                "lat": meta["y"], "lon": meta["x"],
                "description": meta["description"],
            }
            for name, meta in BUSES.items()
        ],
        "lines": [
            {
                "name": f"{f}-{t}",
                "from_bus": f, "to_bus": t,
                "limit_mw": lim,
                "from_lat": BUSES[f]["y"], "from_lon": BUSES[f]["x"],
                "to_lat": BUSES[t]["y"], "to_lon": BUSES[t]["x"],
            }
            for f, t, lim, _ in LINES
        ],
        "generators_summary": {
            "SOUTH": {"wind_mw": 6200, "solar_mw": 900, "gas_mw": 600},
            "CENTRAL": {"gas_mw": 9000, "hydro_mw": 900, "bc_import_mw": 1200},
            "NORTH": {"gas_cogen_mw": 5000, "biomass_mw": 200},
        },
        "base_loads_mw": BASE_LOAD,
    }


def run_sensitivity(
    param: str = "wind_cf",
    values: Optional[list] = None,
    fixed: Optional[dict] = None,
) -> dict:
    """
    Sweep a single parameter and return LMP/congestion/curtailment
    for each value. Useful for sensitivity charts.

    param: "wind_cf" | "solar_cf" | "gas_price_mmbtu" | "system_load_mw"
           | "south_central_limit_mw"
    """
    if values is None:
        defaults = {
            "wind_cf": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
            "solar_cf": [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35],
            "gas_price_mmbtu": [2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0],
            "system_load_mw": [8000, 9000, 10000, 10500, 11000, 11500, 12000, 12500],
            "south_central_limit_mw": [1400, 1800, 2200, 2800, 3400, 4000],
        }
        values = defaults.get(param, [])

    base_kwargs: dict = {
        "system_load_mw": 10500.0, "wind_cf": 0.35,
        "solar_cf": 0.22, "gas_price_mmbtu": 4.50,
        "south_central_limit_mw": None, "central_north_limit_mw": None,
    }
    if fixed:
        base_kwargs.update(fixed)

    results = []
    for v in values:
        kwargs = dict(base_kwargs)
        kwargs[param] = v
        r = run_opf(**kwargs)
        if "error" in r:
            results.append({"param_value": v, "error": r["error"]})
        else:
            results.append({
                "param_value": v,
                "lmp_south": r["lmp_south"],
                "lmp_central": r["lmp_central"],
                "lmp_north": r["lmp_north"],
                "avg_lmp": r["avg_lmp"],
                "lmp_spread": r["lmp_spread"],
                "congestion_active": r["congestion_active"],
                "south_central_spread": r["south_central_spread_cad_mwh"],
                "wind_curtailed_mw": r["south_wind_curtailed_mw"],
                "curtailment_pct": r["curtailment_pct"],
            })
    return {"param": param, "results": results}
