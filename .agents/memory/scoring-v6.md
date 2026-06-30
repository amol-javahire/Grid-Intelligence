---
name: Scoring engine v6
description: v6 assign-and-score-nodal.ts — real capture ratios, shape risk, basis fix, flat-output handling; critical run instructions.
---

# Scoring Engine v6

## Key Changes from v5

### Real capture ratios (from ercot_hub_hourly)
- Loaded at runtime from DB: `SELECT node_type, AVG(da_price) weighted by gen_profile_hour`
- Solar ≈ 0.724 (severe duck-curve cannibalization), Wind ≈ 1.010, Storage ≈ 1.797
- CAISO uses own CAISO_CAPTURE lookup; PJM uses PJM_CAPTURE

### Shape Risk (grid_stability_score)
- ERCOT variable-output (solar/wind/storage/hydro): Pearson correlation of 24-hr gen profile (GEN_PROFILES constant) vs actual zone load profile from `ercot_load_by_zone` (avg by hour)
- ERCOT flat-output (gas/nuclear/biomass/geothermal/coal): domain lookup in ERCOT_FLAT (72/62/65/65/58) — Pearson is undefined for constant series
- CAISO: tech lookup table (solar=26, storage=88, wind=62, gas=72, hydro=75)
- PJM: tech lookup table (solar=52, storage=78, wind=58)
- Result scores: ERCOT solar ~18, ERCOT wind ~78, CAISO solar=26, CAISO storage=88

### Basis Risk (location_score) — v6 fix
- Now uses actual (node_da - sys_avg_da) spread plus node volatility
- Previously used vol-only proxy (didn't capture directional basis)

### Zone load profiles query (Step 0a)
```sql
SELECT zone, hour, AVG(load_mw)::float AS avg_load
FROM ercot_load_by_zone
GROUP BY zone, hour ORDER BY zone, hour
```
- Returns 8 zones × 24 hours = 192 rows
- Zone keys: COAS, EAST, FWES, NCEN, NRTH, SCEN, SOUT, WEST (EIA codes)

### QUEUE_ZONE_TO_LOAD_ZONE mapping
LZ_HOUSTON→COAS, LZ_NORTH→NCEN, LZ_WEST→WEST, LZ_SOUTH/LZ_AEN→SOUT, LZ_LCRA/LZ_CPS→SCEN, HB_PAN→FWES

## Critical: Run Instructions

**Always run synchronously — never pipe to `head`:**
```
pnpm --filter @workspace/scripts run assign-and-score-nodal
```

**Why:** Piping to `head -N` causes SIGPIPE when `head` closes after N lines, which kills the Node.js process before any DB updates execute (the setup/loading phase produces most early output). The DB will show stale scores (all 50.0 for grid_stability_score) if the process is killed mid-run.

## DB Columns Written
`interconnection_node, pricing_hub_node, curtailment_score, interconnection_score, location_score, price_score, financial_score, development_risk_score, environmental_score, demand_proximity_score, grid_stability_score, updated_at, overall_score`

## Score Distribution (3,875 candidates)
- CAISO avg 57.4, ERCOT avg 64.7, PJM avg 60.9
- ERCOT solar shape=18, ERCOT wind shape=78, CAISO solar shape=26, CAISO storage=88
