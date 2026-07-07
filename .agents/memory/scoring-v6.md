---
name: Scoring engine v6/v7
description: assign-and-score-nodal.ts — real capture ratios, shape risk, geo-zone fix, zone-specific capture prices, gas net margin; critical run instructions.
---

# Scoring Engine v7 (supersedes v6)

## Root cause of v6 clustering — fixed in v7

ERCOT queue_projects.interconnection_node stores long tap-point descriptions
("Tap 138kV 40171 Baytown - 40015Cedar Bayou Plant"), NOT clean zone codes.
So `ercotSignalStats(queueZone)` always fell through to the system-average fallback
for all 787 ERCOT candidates → identical curtailment/congestion/basis within tech types.

**Fix:** derive `signalZone = ercotGeoFallback(lat, lon)` for every ERCOT plant
and use that for signal lookup + hub hourly capture price. Keep raw `queueZone`
string only for `interconnectRiskScore` queue depth.

`ercotGeoFallback` returns "HB_WEST", "LZ_HOUSTON", "HB_NORTH", "LZ_WEST", "HB_PAN", etc.
These match keys in both `hubZoneNodes` (CDR hub/zone stats) and `ercotZoneCapturePrice`
(hub hourly profiles), so real data is applied for all plants with lat/lon.

## v7 New Data Sources

### Zone-specific capture prices (Step 0b-new)
```sql
SELECT node, hour, AVG(da_price) FROM ercot_hub_hourly GROUP BY node, hour
```
Computes weighted capture price per hub per tech type using GEN_PROFILES shape.
Real duck-curve differentiation: HB_PAN solar $17.03, HB_WEST solar $20.44,
HB_HOUSTON solar $26.52, LZ_WEST wind $40.91.

### Gas price net margin (Step 0c-new)
```sql
SELECT AVG(price) FROM gas_prices WHERE date >= CURRENT_DATE - INTERVAL '12 months'
```
12-month avg ~$1.12/MMBtu → CCGT fuel cost $7.83/MWh (7 MMBtu/MWh heat rate).
Gas plants: capture price = DA price − fuel cost (net margin pricing).

### EIA-geolocated resource nodes (Step 0d-new)
```sql
SELECT enl.node_name, enl.latitude, enl.longitude, AVG(ens.avg_da_price)...
FROM ercot_node_locations enl JOIN ercot_node_stats ens
WHERE enl.location_source = 'eia_plant' AND enl.latitude IS NOT NULL
```
Currently returns 0 rows (location_source='eia_plant' not yet populated for resource nodes).
Per-plant haversine matching is wired but disabled until this data is seeded.

## v7 Score Distribution (3,875 candidates)

- CAISO avg 57.2, range [44.1–76.3]
- ERCOT avg 66.3, range [46.7–79.5]  ← widened from v6 [55.9–76.3]
- PJM avg 60.7, range [53.1–75.4]

### ERCOT regional differentiation (v7):
| Region | Solar curt | Solar overall | Wind curt | Wind overall |
|---|---|---|---|---|
| Panhandle/W | 63.0 | 50.2 | — | — |
| West TX | 73.3 | 57.1 | 79.9 | 65.9 |
| Central TX | 96.1 | 65.9 | 95.8 | 73.0 |
| East/Coast TX | 96.4 | 69.1 | — | — |

## v6 Features Still Active

### Real capture ratios
- Solar ≈ 0.747, Wind ≈ 1.010, Storage ≈ 1.762 (from hub hourly weighted avg)
- CAISO uses CAISO_CAPTURE lookup; PJM uses PJM_CAPTURE

### Shape Risk (grid_stability_score)
- ERCOT variable-output: Pearson correlation GEN_PROFILES × ercot_load_by_zone
- ERCOT flat-output: domain lookup ERCOT_FLAT (gas=72, nuclear=62, etc.)
- CAISO/PJM: tech lookup tables

### Basis Risk (location_score)
- Uses actual (node_da - sys_avg_da) spread + node volatility

## Zone / Load Zone Mappings

### QUEUE_ZONE_TO_HUB (for hub hourly capture price lookup)
LZ_HOUSTON→HB_HOUSTON, LZ_NORTH→HB_NORTH, LZ_SOUTH→HB_SOUTH,
LZ_WEST→LZ_WEST (direct key), HB_PAN→HB_PAN, LZ_AEN/LZ_CPS→HB_SOUTH

### QUEUE_ZONE_TO_LOAD_ZONE (for shape risk)
LZ_HOUSTON→COAS, LZ_NORTH→NCEN, LZ_WEST→WEST, LZ_SOUTH/LZ_AEN→SOUT,
LZ_LCRA/LZ_CPS→SCEN, HB_PAN→FWES

## Critical: Run Instructions

**Always run synchronously — never pipe to `head`:**
```
pnpm --filter @workspace/scripts run assign-and-score-nodal
```

**Why:** Piping to `head -N` causes SIGPIPE which kills the Node.js process before
DB updates execute. All DB writes happen in a single batch at the end (Step 6).

## DB Columns Written
`interconnection_node, pricing_hub_node, curtailment_score, interconnection_score,
location_score, price_score, financial_score, development_risk_score,
environmental_score, demand_proximity_score, grid_stability_score, updated_at, overall_score`
