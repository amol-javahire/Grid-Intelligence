---
name: PyPSA Engine setup
description: Python FastAPI microservice for DC OPF and XGBoost ML; venv, routing, solver quirks, and Tier 2 real-bus model.
---

## Python venv on NixOS (Replit)

Python is at `/home/runner/workspace/.pythonlibs/bin/python3` (NOT the Nix store).
Create venv and install with `uv` (available at `/nix/store/.../uv`):

```bash
cd artifacts/pypsa-engine
uv venv .venv --python /home/runner/workspace/.pythonlibs/bin/python3
uv pip install -r requirements.txt --python .venv/bin/python
```

Workflow command: `cd artifacts/pypsa-engine && PORT=8083 .venv/bin/python main.py`

Do NOT use `installLanguagePackages` (writes to immutable Nix store → permission denied).

## Proxy routing

`verifyAndReplaceArtifactToml` requires an *existing* artifact.toml — cannot create from scratch.
To route `/pypsa` → port 8083: add a second `[[services]]` block to the **api-server** artifact.toml.

## OPF feasibility

PyPSA DC OPF with HiGHS solver becomes infeasible at high system loads (>60 GW) due to
KVL constraints on the simplified network topology.

**Fix:** Add emergency peaker generators at each bus (carrier `"peaker"`, $499/MWh marginal cost,
large p_nom). Filter them out of the displayed gen_result using a `HIDDEN_CARRIERS` set.
They ensure the LP always has a feasible solution; their dispatch signals extreme grid stress.

## PyPSA static p_set access bug

After `n.optimize()`, accessing `n.loads_t.p_set[load_name]` raises `KeyError` for static loads
(p_set stored in `n.loads["p_set"]`, not time-series).

**Fix:** Use `_get_load_mw()` helper:
1. Check `n.loads_t.p` (realised consumption post-OPF) — prefer this
2. Fall back to `n.loads_t.p_set` columns (time-varying)
3. Fall back to `n.loads.at[load_name, "p_set"]` (static)

## Tier 2 real-bus topology (340-bus ERCOT)

Tables: `ercot_buses` (340 rows) and `ercot_lines` (1807 rows) in PostgreSQL.
Created via direct SQL in `artifacts/pypsa-engine/seed_topology.py` (drizzle push is interactive).
Drizzle schema files also exist at `lib/db/src/schema/ercot_buses.ts` and `ercot_lines.ts`.

Data sources:
- Buses: CDR 10008 via gridstatus → 340 345kV buses with resource nodes
- Coordinates: 268/340 matched from `ercot_node_locations.node_name = resource_node`; 72 get jittered zone centroid
- Lines: k-NN graph K=6, max 350km; x_pu = 0.00026 × dist_km; s_nom varies by CREZ corridor (800–700 MW per circuit)

Run `seed_topology.py` in pypsa-engine venv to reseed.

OPF performance (HiGHS): 340 buses, 1807 lines, 787 EIA 860 generators → ~0.12s solve time.

## Tier 2 physics calibration (high-wind 55% CF)

Expected results at wind_cf=0.55, load=55 GW:
- WST (West Texas): LMP ≈ $0.01/MWh (CREZ wind trapping)
- HOU/NTH/STH: LMP ≈ $35/MWh (congestion premium)
- LMP spread ≈ $37/MWh
- 2 congested lines at ≥95% loading

These are physically realistic CREZ corridor congestion dynamics.

## node-series API shape

`/api/congestion-intel/node-series` returns a **flat JSON array** (not `{series: [...]}`).
Field names: `avgRt`, `avgDa`, `basis`, `volatility`, `negPricePct`, `onPeakAvg`, `offPeakAvg`.
(NOT `avgRtPrice` / `avgDaPrice` — those don't exist.)

**Why:** The CI server route was written before the hourly page; it returns camelCase directly.

## ML model

Trains on `ercot_node_stats` monthly data. Split: ≤2024 train / ≥2025 test.
Results: MAE ~$3.35/MWh, 93.1% accuracy on congestion classification.
Top features: season (38%), 3-month rolling basis (19%), volatility (17%), month (10%).
F1 is low (0.005) because congestion events are rare — class imbalance on resource nodes.
Model persists to `artifacts/pypsa-engine/models/` via joblib.
