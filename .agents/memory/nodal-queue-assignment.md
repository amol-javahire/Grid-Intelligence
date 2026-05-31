---
name: Queue-based nodal assignment
description: How EIA 860 candidates are assigned to precise pricing nodes using interconnection queue nearest-neighbor
---

## Rule
For ERCOT and CAISO candidates, assign `interconnection_node` using Haversine nearest-neighbor against `queue_projects` (≤200 km radius) rather than geographic bounding boxes.

**ERCOT**: 480 queue projects cover 655/787 candidates; 132 use geo fallback (`ercotGeoFallback()` in the script).
**CAISO**: 2,433 queue projects → 100% coverage, no fallback needed.

## Node pricing used (CDR 13060, real, 28 months 2024–2026)
ERCOT 11 nodes (DA $/MWh): LZ_LCRA $36.62 · HB_HOUSTON $35.42 · LZ_HOUSTON $34.49 · LZ_CPS $31.06 · LZ_AEN $30.76 · HB_SOUTH $30.58 · LZ_SOUTH $30.19 · LZ_WEST $29.59 · HB_NORTH $29.49 · HB_WEST $26.76 · HB_PAN $20.38
CAISO: NP15 $37.42 · SP15 $30.77 · ZP26 $29.56 (OASIS DA)

## Why
LZ_LCRA ($36.62) was previously grouped into LZ_SOUTH ($30.19) by the 4-zone bounding box — 20% under-valuation. Queue data gives ground-truth node assignments per-plant.

## How to apply
Run `pnpm --filter @workspace/scripts run assign-and-score-nodal` after any new queue seed. Script sets both `interconnection_node` and `pricing_hub_node` on candidates, then re-scores curtailment, congestion, and overall_score for ERCOT + CAISO.

**Script**: `scripts/src/assign-and-score-nodal.ts`
**Radius**: 200 km (panhandle HB_PAN candidates use geo fallback — no queue projects assigned there)
