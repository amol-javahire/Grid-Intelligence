---
name: Load Forecast Stress Test page
description: ERCOT/CAISO Load Forecast + Stress Test tab design — zone-to-bus mapping, CAISO reserve-margin fallback when no OPF model exists.
---

## Design decisions

- ERCOT zone → PyPSA 5-bus mapping: COAS/EAST→HOUSTON, NCEN/NRTH→NORTH, FWES/WEST→WEST, SCEN/SOUT→SOUTH (PAN has no weather-zone equivalent). Stressed zone load is divided by the bus's `LOAD_FRACTIONS` share (from `network.py` `_T1_LOAD`) to back-calculate a system-wide MW figure to feed `/pypsa/scarcity`.
- The zone-level load forecast (EIA-930 sub-BA basis) and the 5-bus reduced-order model's load fractions are not perfectly consistent in scale (e.g. NCEN's real peak alone can exceed its bus's fractional share of realistic ERCOT system peak) — this is an accepted simplification of the reduced-order model, not a bug. Expect the derived "implied system load" for a full-stress scenario (peak forecast × 100% EV/DC × 3-year-out) to run above ERCOT's real historical peak; that is the intended "stress" behavior.
- `/pypsa/scarcity` returns HTTP 422 `{detail: "..."}` when load exceeds all available capacity (fully infeasible LP) rather than a 200 with a result body. The existing `pypsa-scarcity.tsx` reference page does NOT handle this (silently falls back to a fake "NORMAL" display) — new pages should check `res.ok` and surface the 422 detail as an explicit "CRITICAL — Infeasible" state instead of copying that fallback pattern.
- CAISO has no load forecast dataset and no nodal OPF model. Approach used: real EIA-860 installed capacity (`GET /api/caiso-capacity?hub=SP15|NP15`, aggregated from `candidatesTable` where market=CAISO) × capacity-factor/derate assumptions per fuel type, compared against a user-specified load slider (no forecast to anchor it), computed reactively client-side (no backend round-trip needed) — explicitly labeled as a lower-rigor "reserve-margin estimate" vs ERCOT's full nodal OPF.
- `candidates` schema exports as `candidatesTable` (not `candidates`) from `@workspace/db/schema` — easy to get wrong when writing a new aggregation route.
