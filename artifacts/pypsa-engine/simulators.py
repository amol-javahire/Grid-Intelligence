"""
Extended PyPSA Simulators
--------------------------
Four additional simulation endpoints built on the same 5-bus ERCOT network:

  run_curtailment  — vary wind/solar CF, show curtailment MW and negative-price risk
  run_tx_relief    — upgrade one line, compare before/after congestion + basis
  run_scarcity     — thermal derate + high load -> unserved energy, price spikes
  run_battery      — 24-hour multi-period OPF with StorageUnit, real hourly prices
"""

import pypsa
import pandas as pd
import numpy as np
from typing import Any

from network import (
    BUSES, LINES, GENERATORS, LOAD_FRACTIONS, HUB_MAP, HIDDEN_CARRIERS, _build_tier1,
    build_network as _build_network_real, bus_hub_map, _load_topology_from_db,
)

def build_network(system_load_mw, wind_cf, solar_cf, gas_price_mmbtu):
    """Always use the 5-bus Tier-1 network for curtailment/tx-relief simulators.
    Scarcity uses the real Tier-2 340-bus model via _build_network_real (see run_scarcity)."""
    return _build_tier1(system_load_mw, wind_cf, solar_cf, gas_price_mmbtu)


# ---------------------------------------------------------------------------
# 1. Renewable Curtailment & Negative Price Simulator
# ---------------------------------------------------------------------------

def run_curtailment(
    system_load_mw: float = 45000.0,
    wind_cf: float = 0.55,
    solar_cf: float = 0.28,
    gas_price_mmbtu: float = 3.50,
    west_wind_bonus_pct: float = 0.0,
) -> dict[str, Any]:
    """
    Run OPF and compute curtailment per generator, using the real Tier-2 340-bus
    ERCOT topology (falls back to the 5-bus Tier-1 model only if the DB has no
    topology seeded).

    Curtailment is fundamentally a transmission-constraint phenomenon, so the
    real 340-bus network with 1,807 lines gives a materially better answer than
    the 5-bus reduction — local pockets of congestion that Tier-1 averages away
    show up as genuine curtailment here.

    Curtailment = available capacity (p_nom × p_max_pu) − dispatched MW for
    zero-MC generators. Results are read from the REAL network objects
    (n.generators / n.buses / n.lines), never Tier-1's fixed name constants —
    iterating the hardcoded GENERATORS list against a Tier-2 network silently
    matches nothing and reports 100% curtailment (see TECHNICAL_NOTES §5).
    Per-bus results are then rolled into the 5 ERCOT hub buckets the frontend
    expects, exactly as run_scarcity does.
    """
    adj_wind = wind_cf * (1 + west_wind_bonus_pct / 100)
    eff_wind = min(adj_wind, 0.95)

    n = _build_network_real(system_load_mw, eff_wind, solar_cf, gas_price_mmbtu)
    try:
        n.optimize(solver_name="highs")
    except Exception as e:
        return {"error": f"Optimization failed: {e}"}
    if n.objective is None:
        return {"error": "Optimization failed"}

    buses_db, _ = _load_topology_from_db()
    tier = 2 if buses_db else 1
    hub_of: dict[str, str] = (
        bus_hub_map(buses_db) if tier == 2
        else {bus_id: bus_id for bus_id in n.buses.index}
    )

    lmp: dict[str, float] = {}
    for bus_id in n.buses.index:
        try:
            val = float(n.buses_t.marginal_price.get(bus_id, pd.Series([0.0])).iloc[0])
        except Exception:
            val = 0.0
        lmp[bus_id] = round(val, 2)

    curtailment_results = []
    total_wind_avail = 0.0
    total_wind_dispatch = 0.0
    total_solar_avail = 0.0
    total_solar_dispatch = 0.0

    for name in n.generators.index:
        carrier = str(n.generators.at[name, "carrier"])
        if carrier in HIDDEN_CARRIERS or carrier not in ("wind", "solar"):
            continue
        bus_id = str(n.generators.at[name, "bus"])

        # The builder already baked the CF into p_max_pu (incl. any derates).
        available_mw = float(n.generators.at[name, "p_nom"]) * float(
            n.generators.at[name, "p_max_pu"]
        )
        try:
            dispatched_mw = float(n.generators_t.p[name].iloc[0])
        except Exception:
            dispatched_mw = 0.0

        curtailed_mw = max(0.0, available_mw - dispatched_mw)
        curtail_pct = curtailed_mw / max(available_mw, 1) * 100

        if carrier == "wind":
            total_wind_avail += available_mw
            total_wind_dispatch += dispatched_mw
        else:
            total_solar_avail += available_mw
            total_solar_dispatch += dispatched_mw

        curtailment_results.append({
            "name": name,
            "bus": bus_id,
            "hub": hub_of.get(bus_id, "SOUTH"),
            "carrier": carrier,
            "available_mw": round(available_mw, 1),
            "dispatched_mw": round(dispatched_mw, 1),
            "curtailed_mw": round(curtailed_mw, 1),
            "curtail_pct": round(curtail_pct, 1),
            "lmp": lmp.get(bus_id, 0.0),
        })

    total_curtailed = sum(r["curtailed_mw"] for r in curtailment_results)
    total_avail = sum(r["available_mw"] for r in curtailment_results)
    total_wind_curtailed = total_wind_avail - total_wind_dispatch
    total_solar_curtailed = total_solar_avail - total_solar_dispatch

    # Negative-price exposure: only loaded buses have a meaningful LMP in a
    # 340-bus network (many buses carry no load).
    loaded_buses = {str(n.loads.at[l, "bus"]) for l in n.loads.index}
    meaningful_lmp = {b: v for b, v in lmp.items() if b in loaded_buses} or lmp
    neg_price_buses = [b for b, v in meaningful_lmp.items() if v < 0]
    min_lmp = min(meaningful_lmp.values())

    # Lines: report the most-loaded first — 1,807 lines is far too many to send,
    # and the congested ones are the only interesting ones.
    lines_all = []
    for line_id in n.lines.index:
        try:
            flow = float(n.lines_t.p0[line_id].iloc[0])
        except Exception:
            flow = 0.0
        cap = float(n.lines.at[line_id, "s_nom"])
        loading_pct = abs(flow) / cap * 100 if cap > 0 else 0.0
        b0 = str(n.lines.at[line_id, "bus0"])
        b1 = str(n.lines.at[line_id, "bus1"])
        lines_all.append({
            "name": line_id,
            "bus0": b0,
            "bus1": b1,
            "hub0": hub_of.get(b0, "SOUTH"),
            "hub1": hub_of.get(b1, "SOUTH"),
            "flow_mw": round(flow, 1),
            "capacity_mw": cap,
            "loading_pct": round(loading_pct, 1),
            "is_congested": loading_pct >= 95.0,
        })
    lines_all.sort(key=lambda r: r["loading_pct"], reverse=True)
    lines_result = lines_all[:60]
    congested_count = sum(1 for r in lines_all if r["is_congested"])

    # Roll per-bus curtailment into the 5 hub buckets the frontend charts.
    hub_curt: dict[str, float] = {}
    hub_avail: dict[str, float] = {}
    hub_lmp_w: dict[str, float] = {}
    for r in curtailment_results:
        h = r["hub"]
        hub_curt[h] = hub_curt.get(h, 0.0) + r["curtailed_mw"]
        hub_avail[h] = hub_avail.get(h, 0.0) + r["available_mw"]
        hub_lmp_w[h] = hub_lmp_w.get(h, 0.0) + r["available_mw"] * r["lmp"]

    zone_summary = []
    for hub in sorted(hub_avail.keys()):
        avail = hub_avail[hub]
        avg_hub_lmp = hub_lmp_w[hub] / max(avail, 1.0)
        zone_summary.append({
            "zone": hub,
            "hub": f"HB_{hub}",
            "lmp": round(avg_hub_lmp, 2),
            "curtailed_mw": round(hub_curt.get(hub, 0.0), 1),
            "available_mw": round(avail, 1),
            "curtail_pct": round(hub_curt.get(hub, 0.0) / max(avail, 1) * 100, 1),
        })
        # Backward-compat: the legacy page reads lmp[<HUB LABEL>].
        lmp[hub] = round(avg_hub_lmp, 2)

    return {
        "status": "optimal",
        "model_version": f"tier{tier}_{'db' if tier == 2 else 'eia860'}",
        "tier": tier,
        "bus_count": len(n.buses.index),
        "line_count": len(n.lines.index),
        "system_load_mw": system_load_mw,
        "wind_cf": round(eff_wind, 3),
        "solar_cf": solar_cf,
        "total_curtailed_mw": round(total_curtailed, 1),
        "curtail_pct": round(total_curtailed / max(total_avail, 1) * 100, 1),
        "wind_curtailed_mw": round(total_wind_curtailed, 1),
        "solar_curtailed_mw": round(total_solar_curtailed, 1),
        "neg_price_buses": neg_price_buses,
        "neg_price_count": len(neg_price_buses),
        "min_lmp": round(min_lmp, 2),
        # Load-weighted over loaded buses only (hub-label aliases excluded).
        "avg_lmp": round(sum(meaningful_lmp.values()) / max(len(meaningful_lmp), 1), 2),
        "lmp": lmp,
        "curtailment": curtailment_results,
        "zone_summary": zone_summary,
        "lines": lines_result,
        "congested_lines": congested_count,
    }


# ---------------------------------------------------------------------------
# 2. Transmission Constraint Relief Simulator
# ---------------------------------------------------------------------------

def _run_single_opf(
    system_load_mw: float,
    wind_cf: float,
    solar_cf: float,
    gas_price_mmbtu: float,
    upgrade_line: str,
    extra_capacity_pct: float,
) -> dict:
    gas_adj = (gas_price_mmbtu - 3.5) * 10.0
    n = pypsa.Network()
    n.set_snapshots(pd.DatetimeIndex(["2025-07-15 15:00"]))

    for bus_id, meta in BUSES.items():
        n.add("Bus", bus_id, x=meta["x"], y=meta["y"])

    for line in LINES:
        s_nom = float(line["s_nom"])
        if line["name"] == upgrade_line and extra_capacity_pct > 0:
            s_nom *= (1 + extra_capacity_pct / 100)
        n.add("Line", line["name"],
              bus0=line["bus0"], bus1=line["bus1"],
              s_nom=s_nom, x=float(line["x"]))

    for bus_id, frac in LOAD_FRACTIONS.items():
        n.add("Load", f"{bus_id}-load", bus=bus_id, p_set=system_load_mw * frac)

    for gen in GENERATORS:
        carrier = gen["carrier"]
        p_max = gen["p_max_pu"]
        if carrier == "wind":    p_max = wind_cf
        elif carrier == "solar": p_max = solar_cf
        mc = float(gen["marginal_cost"])
        if carrier == "gas":    mc += gas_adj
        n.add("Generator", gen["name"], bus=gen["bus"], carrier=carrier,
              p_nom=float(gen["p_nom"]), marginal_cost=mc,
              p_max_pu=p_max, p_min_pu=0.0)

    n.optimize(solver_name="highs")
    if n.objective is None:
        return {}

    lmp: dict[str, float] = {}
    for bus_id in BUSES:
        try:
            val = float(n.buses_t.marginal_price.get(bus_id, pd.Series([0.0])).iloc[0])
        except Exception:
            val = 0.0
        lmp[bus_id] = round(val, 2)

    lines_out = []
    total_cong_rent = 0.0
    for line in LINES:
        name = line["name"]
        try:
            flow = float(n.lines_t.p0[name].iloc[0])
        except Exception:
            flow = 0.0
        s_nom = float(line["s_nom"])
        if line["name"] == upgrade_line and extra_capacity_pct > 0:
            s_nom *= (1 + extra_capacity_pct / 100)
        loading_pct = abs(flow) / s_nom * 100 if s_nom > 0 else 0.0
        cong_rent = abs(lmp.get(line["bus1"], 0) - lmp.get(line["bus0"], 0)) * abs(flow) / 1000.0
        total_cong_rent += cong_rent
        lines_out.append({
            "name": name,
            "bus0": line["bus0"],
            "bus1": line["bus1"],
            "flow_mw": round(flow, 1),
            "capacity_mw": round(s_nom, 0),
            "loading_pct": round(loading_pct, 1),
            "congestion_rent_k$": round(cong_rent, 1),
            "is_congested": loading_pct >= 95.0,
        })

    total_curtailed = 0.0
    for gen in GENERATORS:
        if gen["carrier"] not in ("wind", "solar"):
            continue
        p_nom = float(gen["p_nom"])
        cf = wind_cf if gen["carrier"] == "wind" else solar_cf
        available = p_nom * cf
        try:
            dispatched = float(n.generators_t.p[gen["name"]].iloc[0])
        except Exception:
            dispatched = 0.0
        total_curtailed += max(0.0, available - dispatched)

    lmp_spread = max(lmp.values()) - min(lmp.values())
    return {
        "lmp": lmp,
        "lmp_spread": round(lmp_spread, 2),
        "avg_lmp": round(sum(lmp.values()) / len(lmp), 2),
        "total_congestion_rent_k$": round(total_cong_rent, 1),
        "congested_lines": sum(1 for l in lines_out if l["is_congested"]),
        "total_curtailed_mw": round(total_curtailed, 1),
        "lines": lines_out,
    }


def run_tx_relief(
    system_load_mw: float = 55000.0,
    wind_cf: float = 0.55,   # high-wind default to show meaningful CREZ congestion
    solar_cf: float = 0.25,
    gas_price_mmbtu: float = 3.50,
    upgrade_line: str = "NORTH-WEST",
    upgrade_pct: float = 50.0,
) -> dict[str, Any]:
    """
    Run OPF twice (baseline + upgraded line) and return before/after comparison.
    """
    baseline = _run_single_opf(system_load_mw, wind_cf, solar_cf, gas_price_mmbtu, upgrade_line, 0.0)
    upgraded = _run_single_opf(system_load_mw, wind_cf, solar_cf, gas_price_mmbtu, upgrade_line, upgrade_pct)

    if not baseline or not upgraded:
        return {"error": "Optimization failed"}

    lmp_delta = {
        bus: round(upgraded["lmp"].get(bus, 0) - baseline["lmp"].get(bus, 0), 2)
        for bus in BUSES
    }

    return {
        "status": "optimal",
        "upgrade_line": upgrade_line,
        "upgrade_pct": upgrade_pct,
        "baseline": baseline,
        "upgraded": upgraded,
        "lmp_delta": lmp_delta,
        "spread_reduction": round(baseline["lmp_spread"] - upgraded["lmp_spread"], 2),
        "cong_rent_reduction_k$": round(
            baseline["total_congestion_rent_k$"] - upgraded["total_congestion_rent_k$"], 1),
        "curtailment_reduction_mw": round(
            baseline["total_curtailed_mw"] - upgraded["total_curtailed_mw"], 1),
    }


# ---------------------------------------------------------------------------
# 3. Scarcity / Load Shedding Simulator
# ---------------------------------------------------------------------------

def run_scarcity(
    system_load_mw: float = 70000.0,
    wind_cf: float = 0.12,
    solar_cf: float = 0.05,
    gas_price_mmbtu: float = 5.00,
    gas_derate_pct: float = 15.0,
    nuclear_derate_pct: float = 0.0,
    voll: float = 5000.0,
) -> dict[str, Any]:
    """
    Simulate a stressed grid with thermal derates and potential load shedding,
    using the real Tier-2 340-bus ERCOT topology (falls back to the 5-bus
    Tier-1 model only if the DB has no topology seeded).

    Emergency "peaker" / last-resort generators (priced at `voll`) act as the
    load-shedding proxy — their dispatch is unserved energy. Results are
    aggregated from the real bus/generator set (never Tier-1's fixed 5-name
    constants) then rolled up into 5 ERCOT hub buckets for the frontend chart.
    """
    n = _build_network_real(
        system_load_mw, wind_cf, solar_cf, gas_price_mmbtu,
        gas_derate_pct=gas_derate_pct, nuclear_derate_pct=nuclear_derate_pct, voll=voll,
    )

    try:
        n.optimize(solver_name="highs")
    except Exception as e:
        return {"error": f"Optimization failed: {e}"}
    if n.objective is None:
        return {"error": "Optimization failed — load exceeds all available capacity"}

    buses_db, _ = _load_topology_from_db()
    tier = 2 if buses_db else 1
    hub_of: dict[str, str] = (
        bus_hub_map(buses_db) if tier == 2
        else {bus_id: bus_id for bus_id in n.buses.index}
    )

    lmp: dict[str, float] = {}
    for bus_id in n.buses.index:
        try:
            val = float(n.buses_t.marginal_price.get(bus_id, pd.Series([0.0])).iloc[0])
        except Exception:
            val = 0.0
        lmp[bus_id] = round(val, 2)

    all_dispatch: dict[str, float] = {}
    for g in n.generators.index:
        try:
            all_dispatch[g] = float(n.generators_t.p[g].iloc[0])
        except Exception:
            all_dispatch[g] = 0.0

    carrier_dispatch: dict[str, float] = {}
    total_shed_mw = 0.0
    total_avail = 0.0
    for g in n.generators.index:
        carrier = str(n.generators.at[g, "carrier"])
        dispatch = all_dispatch.get(g, 0.0)
        if carrier == "peaker":
            total_shed_mw += dispatch
            continue
        carrier_dispatch[carrier] = carrier_dispatch.get(carrier, 0.0) + dispatch
        p_nom = float(n.generators.at[g, "p_nom"])
        p_max_pu = float(n.generators.at[g, "p_max_pu"])
        total_avail += p_nom * p_max_pu

    reserve_margin = (total_avail - system_load_mw) / system_load_mw * 100

    def _load_mw(load_name: str) -> float:
        return float(n.loads.at[load_name, "p_set"]) if load_name in n.loads.index else 0.0

    hub_load: dict[str, float] = {}
    hub_lmp_weighted: dict[str, float] = {}
    for load_name in n.loads.index:
        bus_id = str(n.loads.at[load_name, "bus"])
        load_mw = _load_mw(load_name)
        hub = hub_of.get(bus_id, "SOUTH")
        hub_load[hub] = hub_load.get(hub, 0.0) + load_mw
        hub_lmp_weighted[hub] = hub_lmp_weighted.get(hub, 0.0) + load_mw * lmp.get(bus_id, 0.0)

    hub_shed: dict[str, float] = {}
    for g in n.generators.index:
        if str(n.generators.at[g, "carrier"]) != "peaker":
            continue
        bus_id = str(n.generators.at[g, "bus"])
        hub = hub_of.get(bus_id, "SOUTH")
        hub_shed[hub] = hub_shed.get(hub, 0.0) + all_dispatch.get(g, 0.0)

    zone_risk = []
    for hub in sorted(hub_load.keys()):
        hub_load_mw = hub_load[hub]
        shed = hub_shed.get(hub, 0.0)
        avg_hub_lmp = hub_lmp_weighted[hub] / max(hub_load_mw, 1.0)
        zone_risk.append({
            "zone": hub,
            "hub": f"HB_{hub}",
            "lmp": round(avg_hub_lmp, 2),
            "load_mw": round(hub_load_mw, 0),
            "load_shed_mw": round(shed, 1),
            "shed_pct": round(shed / max(hub_load_mw, 1) * 100, 1),
        })
        # Backward-compat: legacy pypsa-scarcity.tsx page reads lmp[busId]
        # keyed by hub label (NORTH/WEST/PAN/SOUTH/HOUSTON), not real bus
        # names. Merge the hub-level weighted LMP under that key too.
        lmp[hub] = round(avg_hub_lmp, 2)

    # System-wide LMP stats: load-weighted, restricted to loaded buses (a
    # 340-bus network has many unloaded buses whose LMP is not meaningful).
    loaded_buses = {str(n.loads.at[l, "bus"]) for l in n.loads.index}
    loaded_lmps = [lmp[b] for b in loaded_buses if b in lmp]
    avg_lmp = sum(loaded_lmps) / len(loaded_lmps) if loaded_lmps else 0.0
    max_lmp = max(loaded_lmps) if loaded_lmps else 0.0
    min_lmp_v = min(loaded_lmps) if loaded_lmps else 0.0

    if max_lmp >= voll * 0.9:
        scarcity_level = "CRITICAL"
    elif max_lmp >= 300:
        scarcity_level = "SEVERE"
    elif max_lmp >= 100:
        scarcity_level = "ELEVATED"
    else:
        scarcity_level = "NORMAL"

    lines_result = []
    for line_id in n.lines.index:
        try:
            flow = float(n.lines_t.p0[line_id].iloc[0])
        except Exception:
            flow = 0.0
        cap = float(n.lines.at[line_id, "s_nom"])
        loading_pct = abs(flow) / cap * 100 if cap > 0 else 0.0
        lines_result.append({
            "name": line_id,
            "bus0": n.lines.at[line_id, "bus0"],
            "bus1": n.lines.at[line_id, "bus1"],
            "flow_mw": round(flow, 1),
            "loading_pct": round(loading_pct, 1),
            "is_congested": loading_pct >= 95.0,
        })
    lines_result.sort(key=lambda l: l["loading_pct"], reverse=True)

    return {
        "status": "optimal",
        "tier": tier,
        "scarcity_level": scarcity_level,
        "system_load_mw": system_load_mw,
        "total_available_mw": round(total_avail, 0),
        "reserve_margin_pct": round(reserve_margin, 1),
        "total_load_shed_mw": round(total_shed_mw, 1),
        "avg_lmp": round(avg_lmp, 2),
        "max_lmp": round(max_lmp, 2),
        "lmp_spread": round(max_lmp - min_lmp_v, 2),
        "lmp": lmp,
        "carrier_dispatch": {k: round(v, 1) for k, v in carrier_dispatch.items()},
        "zone_risk": zone_risk,
        "lines": lines_result[:20],
        "voll": voll,
    }


# ---------------------------------------------------------------------------
# 4. Battery Revenue Simulator — 5-bus zonal OPF + 24-hour DA arbitrage
# ---------------------------------------------------------------------------

# Solar diurnal profile (0–1 multiplier by hour-of-day, peaks at solar noon)
_SOLAR_DIURNAL = [
    0.00, 0.00, 0.00, 0.00, 0.00, 0.04,
    0.15, 0.35, 0.58, 0.78, 0.92, 0.99,
    1.00, 0.98, 0.90, 0.78, 0.60, 0.38,
    0.16, 0.05, 0.00, 0.00, 0.00, 0.00,
]
# Load diurnal relative to daily avg = 1.0 (ERCOT-calibrated shape)
_LOAD_DIURNAL = [
    0.76, 0.72, 0.70, 0.70, 0.73, 0.82,
    0.93, 0.98, 1.01, 1.04, 1.07, 1.10,
    1.12, 1.14, 1.16, 1.13, 1.08, 1.11,
    1.15, 1.11, 1.03, 0.95, 0.88, 0.82,
]
# Seasonal base system load by calendar month (MW, ERCOT historical avg)
_SEASONAL_BASE = {
    1: 42000,  2: 44000,  3: 39000,  4: 38000,
    5: 45000,  6: 55000,  7: 62000,  8: 61000,
    9: 52000, 10: 43000, 11: 41000, 12: 43000,
}


def run_battery(
    storage_bus: str = "WEST",
    storage_mw: float = 500.0,
    storage_mwh: float = 2000.0,
    storage_efficiency: float = 0.90,
    node: str = "HB_WEST",
    year: int = 2025,
    month: int = 7,
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
    gas_price_mmbtu: float = 3.50,
) -> dict[str, Any]:
    """
    24-hour DA price arbitrage — upgraded to 5-bus zonal OPF price signals.

    Phase 1 — Zone LMP derivation (24 × Tier-1 single-snapshot OPFs):
      For each hour-of-day, run the 5-bus ERCOT network with a diurnal solar
      profile and load shape.  Extract the zone LMP at the storage bus.  This
      captures curtailment pressure (solar/wind surplus → negative LMPs at the
      generation-heavy WEST/PAN buses) and inter-zonal congestion (WEST → NORTH
      line saturation).

    Phase 2 — Multi-period battery LP:
      Use a blended signal (50% real DA hub price + 50% zone LMP) as the
      marginal cost for the single-bus battery optimisation.  Revenue is always
      settled at the real DA hub price so the reported $/day figure is directly
      comparable to merchant battery proformas.
    """
    from db import fetch_all

    # ── Fetch real hourly DA + RT prices ──────────────────────────────────────
    rows = fetch_all(
        """SELECT hour, da_price, rt_price
           FROM ercot_hub_hourly
           WHERE node = %s AND year = %s AND month = %s
           ORDER BY hour""",
        (node, year, month),
    )
    if not rows:
        return {"error": f"No hourly data for {node} {year}-{month:02d}. Seed ercot_hub_hourly first."}

    hourly: dict[int, dict] = {}
    for r in rows:
        h = int(r["hour"])
        if h not in hourly:
            hourly[h] = {"da": [], "rt": []}
        hourly[h]["da"].append(float(r["da_price"]))
        hourly[h]["rt"].append(float(r["rt_price"]))

    hours_sorted = sorted(hourly.keys())
    da_prices = [float(np.mean(hourly[h]["da"])) for h in hours_sorted]
    rt_prices = [float(np.mean(hourly[h]["rt"])) for h in hours_sorted]
    n_hours   = len(hours_sorted)

    # ── Phase 1: REAL hourly zone prices + REAL SCED curtailment ─────────────
    # Previously this ran 24 single-snapshot Tier-1 OPFs to *model* a zone LMP.
    # Battery Revenue is a historical backtest ("what would this battery have
    # earned in June 2025?"), so per TECHNICAL_NOTES §5a it must use actual
    # settled prices, not modelled ones. Two real sources replace the model:
    #   • zone price  ← ercot_node_prices RT at the storage zone's load zone
    #                   (RT embeds the congestion + curtailment signal the
    #                    modelled LMP was only approximating; negative RT hours
    #                    ARE curtailment events)
    #   • curtailment ← ercot_hourly_dispatch (HSL − actual output) for wind and
    #                   solar resources in that zone, from SCED 60-day disclosure
    # Also ~100× faster: two indexed queries instead of 24 LP solves.
    _HUB_TO_LZ: dict[str, tuple[str, ...]] = {
        "HOUSTON": ("LZ_HOUSTON",),
        "NORTH":   ("LZ_NORTH",),
        "WEST":    ("LZ_WEST",),
        "PAN":     ("LZ_WEST",),   # Panhandle settles into the West load zone
        "SOUTH":   ("LZ_SOUTH", "LZ_AEN", "LZ_CPS", "LZ_LCRA"),
    }
    zone_nodes = _HUB_TO_LZ.get(str(storage_bus).upper(), ("LZ_WEST",))

    zone_rows = fetch_all(
        """SELECT EXTRACT(hour FROM hour)::int + 1 AS he,
                  AVG(rt_price) AS rt, AVG(da_price) AS da
             FROM ercot_node_prices
            WHERE node_name = ANY(%s)
              AND EXTRACT(year  FROM hour) = %s
              AND EXTRACT(month FROM hour) = %s
            GROUP BY 1 ORDER BY 1""",
        (list(zone_nodes), year, month),
    )
    zone_by_he = {int(r["he"]): float(r["rt"] or 0.0) for r in zone_rows}

    # Real curtailment: SUM(HSL − output) over wind+solar in the zone, by hour.
    curt_rows = fetch_all(
        """SELECT EXTRACT(hour FROM d.hour AT TIME ZONE 'America/Chicago')::int + 1 AS he,
                  AVG(GREATEST(d.hsl - d.avg_mw, 0)) * COUNT(DISTINCT d.resource_name) AS curt
             FROM ercot_hourly_dispatch d
             JOIN ercot_node_locations nl ON nl.node_name = d.resource_name
            WHERE nl.load_zone = ANY(%s)
              AND d.resource_type IN ('wind','solar')
              AND EXTRACT(year  FROM d.hour AT TIME ZONE 'America/Chicago') = %s
              AND EXTRACT(month FROM d.hour AT TIME ZONE 'America/Chicago') = %s
            GROUP BY 1 ORDER BY 1""",
        (list(zone_nodes), year, month),
    )
    curt_by_he = {int(r["he"]): float(r["curt"] or 0.0) for r in curt_rows}

    zone_lmps: list[float] = []
    curtailment_mw: list[float] = []
    for i, h in enumerate(hours_sorted):
        # Fall back to the hub DA price only if that hour has no zone data.
        zone_lmps.append(zone_by_he.get(int(h), da_prices[i]))
        curtailment_mw.append(round(curt_by_he.get(int(h), 0.0), 1))

    # Blended signal: real zone RT brings the local congestion/curtailment
    # signal, real hub DA anchors to market outturn. Revenue below is always
    # settled at DA so the $/day stays comparable to merchant proformas.
    effective_prices = [
        round(0.5 * da_prices[i] + 0.5 * zone_lmps[i], 4)
        for i in range(n_hours)
    ]

    # ── Phase 2: Multi-period single-bus battery LP ───────────────────────────
    snapshots = pd.date_range("2025-07-01", periods=n_hours, freq="h")
    net_bat   = pypsa.Network()
    net_bat.set_snapshots(snapshots)
    net_bat.add("Bus", "MARKET")
    net_bat.add("Load", "demand", bus="MARKET", p_set=storage_mw)

    eff_series = pd.Series([max(p, 0.0) for p in effective_prices], index=snapshots)
    net_bat.add("Generator", "MARKET-GEN", bus="MARKET", carrier="market",
                p_nom=storage_mw * 10, marginal_cost=eff_series, p_max_pu=1.0, p_min_pu=0.0)
    net_bat.add("StorageUnit", "BATTERY", bus="MARKET", carrier="battery",
                p_nom=storage_mw,
                max_hours=storage_mwh / storage_mw,
                efficiency_store=float(np.sqrt(storage_efficiency)),
                efficiency_dispatch=float(np.sqrt(storage_efficiency)),
                cyclic_state_of_charge=True,
                marginal_cost=0.0)

    net_bat.optimize(solver_name="highs")
    if net_bat.objective is None:
        return {"error": "Battery OPF failed — check feasibility"}

    try:
        bat_p_series   = net_bat.storage_units_t.p["BATTERY"]
        bat_soc_series = net_bat.storage_units_t.state_of_charge["BATTERY"]
    except Exception:
        return {"error": "Battery dispatch results unavailable after OPF"}

    hourly_schedule: list[dict] = []
    total_charge_mwh    = 0.0
    total_discharge_mwh = 0.0
    arbitrage_revenue   = 0.0

    for i, h in enumerate(hours_sorted):
        p    = float(bat_p_series.iloc[i])
        soc  = float(bat_soc_series.iloc[i])
        da   = da_prices[i]
        rt   = rt_prices[i]
        zlmp = zone_lmps[i]
        eff  = effective_prices[i]

        if p > 0:
            total_discharge_mwh += p
            arbitrage_revenue   += p * da
        else:
            total_charge_mwh    += abs(p)
            arbitrage_revenue   -= abs(p) * da

        hourly_schedule.append({
            "hour":            h,
            "label":           f"{h}:00",
            "charge_mw":       round(abs(p) if p < 0 else 0.0, 1),
            "discharge_mw":    round(p if p > 0 else 0.0, 1),
            "soc_mwh":         round(soc, 1),
            "da_price":        round(da, 2),
            "rt_price":        round(rt, 2),
            "lmp":             round(zlmp, 2),
            "effective_price": round(eff, 2),
            "curtailment_mw":  curtailment_mw[i],
        })

    avg_zone_lmp   = float(np.mean(zone_lmps))
    avg_da         = float(np.mean(da_prices))
    lmp_volatility = float(np.std(zone_lmps))
    neg_price_hours = int(sum(1 for v in zone_lmps if v < 0))
    total_curt_mwh  = round(sum(curtailment_mw), 0)

    return {
        "status":                 "optimal",
        "storage_bus":            storage_bus,
        "storage_mw":             storage_mw,
        "storage_mwh":            storage_mwh,
        "node":                   node,
        "year":                   year,
        "month":                  month,
        "n_hours":                n_hours,
        "total_charge_mwh":       round(total_charge_mwh, 1),
        "total_discharge_mwh":    round(total_discharge_mwh, 1),
        "arbitrage_revenue_$":    round(arbitrage_revenue, 0),
        "daily_revenue_$":        round(arbitrage_revenue, 0),
        "avg_lmp_at_bus":         round(avg_zone_lmp, 2),
        "avg_da_hub":             round(avg_da, 2),
        "zone_basis_mwh":         round(avg_zone_lmp - avg_da, 2),
        "lmp_volatility":         round(lmp_volatility, 2),
        "neg_price_hours":        neg_price_hours,
        "total_curtailment_mwh":  total_curt_mwh,
        "da_price_range":         [round(min(da_prices), 2), round(max(da_prices), 2)],
        "hourly_schedule":        hourly_schedule,
    }
