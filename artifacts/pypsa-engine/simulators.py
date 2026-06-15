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
    BUSES, LINES, GENERATORS, LOAD_FRACTIONS, HUB_MAP, HIDDEN_CARRIERS, build_network
)


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
    Run OPF and compute curtailment per generator.
    Curtailment = available capacity - dispatched MW for zero-MC generators.
    Negative price exposure from buses where LMP < 0.
    """
    adj_wind = wind_cf * (1 + west_wind_bonus_pct / 100)

    n = build_network(system_load_mw, min(adj_wind, 0.95), solar_cf, gas_price_mmbtu)
    n.optimize(solver_name="highs")

    if n.objective is None:
        return {"error": "Optimization failed"}

    lmp: dict[str, float] = {}
    for bus_id in BUSES:
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

    for gen in GENERATORS:
        if gen["carrier"] in HIDDEN_CARRIERS:
            continue
        carrier = gen["carrier"]
        name = gen["name"]
        p_nom = float(gen["p_nom"])

        if carrier == "wind":
            cf = min(adj_wind, 0.95)
        elif carrier == "solar":
            cf = solar_cf
        else:
            continue

        available_mw = p_nom * cf
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
            "bus": gen["bus"],
            "carrier": carrier,
            "available_mw": round(available_mw, 1),
            "dispatched_mw": round(dispatched_mw, 1),
            "curtailed_mw": round(curtailed_mw, 1),
            "curtail_pct": round(curtail_pct, 1),
            "lmp": lmp.get(gen["bus"], 0.0),
        })

    total_curtailed = sum(r["curtailed_mw"] for r in curtailment_results)
    total_avail = sum(r["available_mw"] for r in curtailment_results)
    total_wind_curtailed = total_wind_avail - total_wind_dispatch
    total_solar_curtailed = total_solar_avail - total_solar_dispatch

    neg_price_buses = [b for b, v in lmp.items() if v < 0]
    min_lmp = min(lmp.values())

    lines_result = []
    for line in LINES:
        name = line["name"]
        try:
            flow = float(n.lines_t.p0[name].iloc[0])
        except Exception:
            flow = 0.0
        cap = float(line["s_nom"])
        loading_pct = abs(flow) / cap * 100 if cap > 0 else 0.0
        lines_result.append({
            "name": name,
            "bus0": line["bus0"],
            "bus1": line["bus1"],
            "flow_mw": round(flow, 1),
            "capacity_mw": cap,
            "loading_pct": round(loading_pct, 1),
            "is_congested": loading_pct >= 95.0,
        })

    zone_summary = []
    for bus_id in BUSES:
        zone_gens = [r for r in curtailment_results if r["bus"] == bus_id]
        zone_curtailed = sum(r["curtailed_mw"] for r in zone_gens)
        zone_avail = sum(r["available_mw"] for r in zone_gens)
        zone_summary.append({
            "zone": bus_id,
            "hub": HUB_MAP[bus_id],
            "lmp": lmp.get(bus_id, 0.0),
            "curtailed_mw": round(zone_curtailed, 1),
            "available_mw": round(zone_avail, 1),
            "curtail_pct": round(zone_curtailed / max(zone_avail, 1) * 100, 1),
        })

    return {
        "status": "optimal",
        "system_load_mw": system_load_mw,
        "wind_cf": round(min(adj_wind, 0.95), 3),
        "solar_cf": solar_cf,
        "total_curtailed_mw": round(total_curtailed, 1),
        "curtail_pct": round(total_curtailed / max(total_avail, 1) * 100, 1),
        "wind_curtailed_mw": round(total_wind_curtailed, 1),
        "solar_curtailed_mw": round(total_solar_curtailed, 1),
        "neg_price_buses": neg_price_buses,
        "neg_price_count": len(neg_price_buses),
        "min_lmp": round(min_lmp, 2),
        "avg_lmp": round(sum(lmp.values()) / len(lmp), 2),
        "lmp": lmp,
        "curtailment": curtailment_results,
        "zone_summary": zone_summary,
        "lines": lines_result,
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
    wind_cf: float = 0.35,
    solar_cf: float = 0.22,
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
    Simulate a stressed grid with thermal derates and potential load shedding.
    Peaker generators act as VOLL-priced load-shedding proxy.
    """
    gas_adj = (gas_price_mmbtu - 3.5) * 10.0
    n = pypsa.Network()
    n.set_snapshots(pd.DatetimeIndex(["2025-07-15 16:00"]))

    for bus_id, meta in BUSES.items():
        n.add("Bus", bus_id, x=meta["x"], y=meta["y"])

    for line in LINES:
        n.add("Line", line["name"],
              bus0=line["bus0"], bus1=line["bus1"],
              s_nom=float(line["s_nom"]), x=float(line["x"]))

    for bus_id, frac in LOAD_FRACTIONS.items():
        n.add("Load", f"{bus_id}-load", bus=bus_id, p_set=system_load_mw * frac)

    for gen in GENERATORS:
        carrier = gen["carrier"]
        p_max = gen["p_max_pu"]
        p_nom = float(gen["p_nom"])

        if carrier == "wind":      p_max = wind_cf
        elif carrier == "solar":   p_max = solar_cf
        elif carrier == "gas":     p_max = gen["p_max_pu"] * (1 - gas_derate_pct / 100)
        elif carrier == "nuclear": p_max = gen["p_max_pu"] * (1 - nuclear_derate_pct / 100)

        mc = float(gen["marginal_cost"])
        if carrier == "gas":    mc += gas_adj
        if carrier == "peaker": mc = voll

        n.add("Generator", gen["name"], bus=gen["bus"], carrier=carrier,
              p_nom=p_nom, marginal_cost=mc, p_max_pu=max(0.0, p_max), p_min_pu=0.0)

    n.optimize(solver_name="highs")
    if n.objective is None:
        return {"error": "Optimization failed — load exceeds all available capacity"}

    lmp: dict[str, float] = {}
    for bus_id in BUSES:
        try:
            val = float(n.buses_t.marginal_price.get(bus_id, pd.Series([0.0])).iloc[0])
        except Exception:
            val = 0.0
        lmp[bus_id] = round(val, 2)

    load_shed: dict[str, float] = {}
    total_shed_mw = 0.0
    for gen in GENERATORS:
        if gen["carrier"] != "peaker":
            continue
        bus = gen["bus"]
        try:
            dispatch = float(n.generators_t.p[gen["name"]].iloc[0])
        except Exception:
            dispatch = 0.0
        load_shed[bus] = round(dispatch, 1)
        total_shed_mw += dispatch

    carrier_dispatch: dict[str, float] = {}
    for gen in GENERATORS:
        c = gen["carrier"]
        if c in HIDDEN_CARRIERS:
            continue
        try:
            d = float(n.generators_t.p[gen["name"]].iloc[0])
        except Exception:
            d = 0.0
        carrier_dispatch[c] = carrier_dispatch.get(c, 0.0) + d

    total_gas_cap = sum(
        g["p_nom"] * g["p_max_pu"] * (1 - gas_derate_pct / 100)
        for g in GENERATORS if g["carrier"] == "gas"
    )
    total_nuke_cap = sum(
        g["p_nom"] * g["p_max_pu"] * (1 - nuclear_derate_pct / 100)
        for g in GENERATORS if g["carrier"] == "nuclear"
    )
    total_wind_cap = sum(g["p_nom"] * wind_cf for g in GENERATORS if g["carrier"] == "wind")
    total_solar_cap = sum(g["p_nom"] * solar_cf for g in GENERATORS if g["carrier"] == "solar")
    total_avail = total_gas_cap + total_nuke_cap + total_wind_cap + total_solar_cap
    reserve_margin = (total_avail - system_load_mw) / system_load_mw * 100

    lines_result = []
    for line in LINES:
        name = line["name"]
        try:
            flow = float(n.lines_t.p0[name].iloc[0])
        except Exception:
            flow = 0.0
        cap = float(line["s_nom"])
        loading_pct = abs(flow) / cap * 100 if cap > 0 else 0.0
        lines_result.append({
            "name": name,
            "bus0": line["bus0"],
            "bus1": line["bus1"],
            "flow_mw": round(flow, 1),
            "loading_pct": round(loading_pct, 1),
            "is_congested": loading_pct >= 95.0,
        })

    max_lmp = max(lmp.values())
    if max_lmp >= voll * 0.9:
        scarcity_level = "CRITICAL"
    elif max_lmp >= 300:
        scarcity_level = "SEVERE"
    elif max_lmp >= 100:
        scarcity_level = "ELEVATED"
    else:
        scarcity_level = "NORMAL"

    zone_risk = []
    for bus_id in BUSES:
        shed = load_shed.get(bus_id, 0.0)
        zone_load = system_load_mw * LOAD_FRACTIONS[bus_id]
        zone_risk.append({
            "zone": bus_id,
            "hub": HUB_MAP[bus_id],
            "lmp": lmp.get(bus_id, 0.0),
            "load_mw": round(zone_load, 0),
            "load_shed_mw": shed,
            "shed_pct": round(shed / max(zone_load, 1) * 100, 1),
        })

    return {
        "status": "optimal",
        "scarcity_level": scarcity_level,
        "system_load_mw": system_load_mw,
        "total_available_mw": round(total_avail, 0),
        "reserve_margin_pct": round(reserve_margin, 1),
        "total_load_shed_mw": round(total_shed_mw, 1),
        "avg_lmp": round(sum(lmp.values()) / len(lmp), 2),
        "max_lmp": round(max_lmp, 2),
        "lmp_spread": round(max(lmp.values()) - min(lmp.values()), 2),
        "lmp": lmp,
        "carrier_dispatch": {k: round(v, 1) for k, v in carrier_dispatch.items()},
        "zone_risk": zone_risk,
        "lines": lines_result,
        "voll": voll,
    }


# ---------------------------------------------------------------------------
# 4. Battery Revenue Simulator (24-hour DA price arbitrage via PyPSA)
# ---------------------------------------------------------------------------

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
    24-hour DA price arbitrage using PyPSA single-bus model.
    Real hourly DA prices from ercot_hub_hourly act as the market signal:
    - A price-taking "market" generator is priced at the real DA price each hour
    - A fixed load of 1 MW per hour represents demand
    - The StorageUnit arbitrages by charging at cheap hours, discharging at expensive ones
    This directly computes optimal DA price arbitrage revenue without interference
    from the full multi-zonal network (which suppresses battery dispatch via surplus capacity).
    """
    from db import fetch_all

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
    n_hours = len(hours_sorted)

    # Single-bus PyPSA model for DA price arbitrage
    # The market generator has time-varying marginal cost = real DA price
    # Battery arbitrages against this price signal
    snapshots = pd.date_range("2025-07-01", periods=n_hours, freq="h")
    n = pypsa.Network()
    n.set_snapshots(snapshots)

    n.add("Bus", "MARKET")

    # Fixed load of storage_mw so the system must meet demand each hour
    n.add("Load", "demand", bus="MARKET", p_set=storage_mw)

    # Market generator: price-taker at real DA prices (sets the LMP signal)
    # Use DA price as marginal cost so LMP = DA price at each snapshot
    da_series = pd.Series(da_prices, index=snapshots)
    # Clamp at 0 for feasibility (battery charges, market gen meets remainder)
    mc_series = da_series.clip(lower=0.0)

    n.add("Generator", "MARKET-GEN",
          bus="MARKET",
          carrier="market",
          p_nom=storage_mw * 10,     # effectively unconstrained
          marginal_cost=mc_series,
          p_max_pu=1.0,
          p_min_pu=0.0)

    # Battery StorageUnit
    n.add("StorageUnit", "BATTERY",
          bus="MARKET",
          carrier="battery",
          p_nom=storage_mw,
          max_hours=storage_mwh / storage_mw,
          efficiency_store=float(np.sqrt(storage_efficiency)),
          efficiency_dispatch=float(np.sqrt(storage_efficiency)),
          cyclic_state_of_charge=True,
          marginal_cost=0.0)

    n.optimize(solver_name="highs")
    if n.objective is None:
        return {"error": "Battery OPF failed — check feasibility"}

    # Extract results
    try:
        bat_p_series = n.storage_units_t.p["BATTERY"]
        bat_soc_series = n.storage_units_t.state_of_charge["BATTERY"]
    except Exception:
        return {"error": "Battery dispatch results unavailable after OPF"}

    try:
        bus_lmps_series = n.buses_t.marginal_price["MARKET"]
        bus_lmps = [float(bus_lmps_series.iloc[i]) for i in range(n_hours)]
    except Exception:
        bus_lmps = da_prices[:]

    hourly_schedule = []
    total_charge_mwh = 0.0
    total_discharge_mwh = 0.0
    arbitrage_revenue = 0.0

    for i, h in enumerate(hours_sorted):
        # In PyPSA StorageUnit: p > 0 = discharging, p < 0 = charging
        p = float(bat_p_series.iloc[i])
        soc = float(bat_soc_series.iloc[i])
        da = da_prices[i]
        rt = rt_prices[i]
        lmp = bus_lmps[i]

        if p > 0:
            total_discharge_mwh += p
            arbitrage_revenue += p * da
        else:
            total_charge_mwh += abs(p)
            arbitrage_revenue -= abs(p) * da

        hourly_schedule.append({
            "hour": h,
            "label": f"{h}:00",
            "charge_mw": round(abs(p) if p < 0 else 0.0, 1),
            "discharge_mw": round(p if p > 0 else 0.0, 1),
            "soc_mwh": round(soc, 1),
            "da_price": round(da, 2),
            "rt_price": round(rt, 2),
            "lmp": round(lmp, 2),
        })

    avg_lmp = float(np.mean(bus_lmps))
    lmp_volatility = float(np.std(bus_lmps))
    neg_price_hours = int(sum(1 for v in da_prices if v < 0))

    return {
        "status": "optimal",
        "storage_bus": storage_bus,
        "storage_mw": storage_mw,
        "storage_mwh": storage_mwh,
        "node": node,
        "year": year,
        "month": month,
        "n_hours": n_hours,
        "total_charge_mwh": round(total_charge_mwh, 1),
        "total_discharge_mwh": round(total_discharge_mwh, 1),
        "arbitrage_revenue_$": round(arbitrage_revenue, 0),
        "daily_revenue_$": round(arbitrage_revenue, 0),
        "avg_lmp_at_bus": round(avg_lmp, 2),
        "lmp_volatility": round(lmp_volatility, 2),
        "neg_price_hours": neg_price_hours,
        "da_price_range": [round(min(da_prices), 2), round(max(da_prices), 2)],
        "hourly_schedule": hourly_schedule,
    }
