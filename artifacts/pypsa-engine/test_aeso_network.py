"""
test_aeso_network.py — deterministic scenario checks for aeso_network.py
==========================================================================

Not a full pytest suite — a small set of hand-picked scenarios that pin down
the behavior AESO_PYPSA_VALIDATION.md's Phase 0 asked for: real solver status
reporting, explicit (not silent) load-shedding via the slack generator, and a
sane energy balance. Run directly:

    ~/grid-intelligence/artifacts/pypsa-engine/.venv/bin/python test_aeso_network.py

Exits non-zero on any failed assertion.
"""

from aeso_network import run_opf, MODEL_LABEL

FAILURES = []


def check(label: str, cond: bool, detail: str = ""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {label}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(label)


def scenario_uncongested():
    """Low wind, moderate load, default corridor limits — should solve cleanly
    with no binding constraints and no load shed."""
    r = run_opf(system_load_mw=9000.0, wind_cf=0.2, solar_cf=0.15, gas_price_mmbtu=4.5)
    check("uncongested: no error key", "error" not in r, str(r.get("error")))
    if "error" in r:
        return
    check("uncongested: solver_status ok", r["solver_status"] == "ok", r["solver_status"])
    check("uncongested: termination optimal", r["termination_condition"] in ("optimal", "optimal_inaccurate"), r["termination_condition"])
    check("uncongested: model_status optimal", r["model_status"] == "optimal", r["model_status"])
    check("uncongested: no unserved load", r["unserved_load_mw"] <= 1.0, r["unserved_load_mw"])
    check("uncongested: no binding lines", r["congestion_active"] is False, r["congested_lines"])
    check("uncongested: energy balance residual ~0", abs(r["energy_balance_residual_mw"]) < 1.0, r["energy_balance_residual_mw"])
    check("uncongested: model_label present", r["model_label"] == MODEL_LABEL, r["model_label"])


def scenario_binding_corridor():
    """High wind + a tight SOUTH-CENTRAL limit should force the corridor to
    bind, collapse SOUTH's LMP relative to CENTRAL, and curtail wind."""
    r = run_opf(system_load_mw=10500.0, wind_cf=0.9, solar_cf=0.5,
                gas_price_mmbtu=4.5, south_central_limit_mw=1000.0)
    check("binding: no error key", "error" not in r, str(r.get("error")))
    if "error" in r:
        return
    check("binding: model_status optimal (not infeasible)", r["model_status"] == "optimal", r["model_status"])
    sc = next((l for l in r["lines"] if l["name"] == "SOUTH-CENTRAL"), None)
    check("binding: SOUTH-CENTRAL line present", sc is not None)
    if sc:
        check("binding: SOUTH-CENTRAL near limit", sc["loading_pct"] >= 95.0, sc["loading_pct"])
        check("binding: SOUTH-CENTRAL flagged congested", sc["congested"] is True, sc)
    check("binding: SOUTH LMP below CENTRAL LMP", r["lmp_south"] < r["lmp_central"],
          f"south={r['lmp_south']} central={r['lmp_central']}")
    check("binding: some wind curtailed", r["south_wind_curtailed_mw"] > 0, r["south_wind_curtailed_mw"])
    check("binding: congestion_active True", r["congestion_active"] is True)


def scenario_load_shed():
    """Demand set well above the fleet's effective capacity at this wind/solar
    CF (default corridor limits, so it's a capacity shortfall, not a corridor
    bottleneck) — the slack generator should have to cover the gap, and that
    must show up explicitly as unserved_load_mw / model_status, not be
    silently absorbed into a clean 'optimal' result."""
    r = run_opf(system_load_mw=25000.0, wind_cf=0.3, solar_cf=0.2, gas_price_mmbtu=4.5)
    check("load_shed: no error key (solver should still solve, just lean on slack)", "error" not in r, str(r.get("error")))
    if "error" in r:
        return
    check("load_shed: unserved_load_mw > 0", r["unserved_load_mw"] > 0, r["unserved_load_mw"])
    check("load_shed: model_status flags load_shed", r["model_status"] == "load_shed", r["model_status"])
    check("load_shed: slack_cost_cad_hr > 0", r["slack_cost_cad_hr"] > 0, r["slack_cost_cad_hr"])
    check("load_shed: total_cost includes slack cost", r["total_cost_cad_hr"] >= r["slack_cost_cad_hr"], r)


def scenario_infeasible_isolated_bus():
    """Sever CENTRAL-NORTH (limit=0) and push enough load onto NORTH (via the
    proportional system-wide scale factor) that NORTH's own local fleet can't
    cover it. NORTH has no other tie to the slack generator, so this must be
    genuinely infeasible — the endpoint should report solver failure, not a
    fabricated optimal result."""
    r = run_opf(system_load_mw=30000.0, wind_cf=0.5, solar_cf=0.3,
                gas_price_mmbtu=4.5, central_north_limit_mw=0.0)
    check("infeasible: reports an error / non-optimal outcome",
          ("error" in r) or (r.get("model_status") not in ("optimal",)),
          r)


if __name__ == "__main__":
    scenario_uncongested()
    scenario_binding_corridor()
    scenario_load_shed()
    scenario_infeasible_isolated_bus()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
        raise SystemExit(1)
    else:
        print("All scenario checks passed.")
