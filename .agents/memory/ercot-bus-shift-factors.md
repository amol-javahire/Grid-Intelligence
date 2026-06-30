---
name: ERCOT bus shift factors
description: DC PTDF shift factors for 340 ERCOT 345kV buses — methodology, zone mapping, and key caveats
---

## What was built
`ercot_bus_shift_factors` table (340 rows) with PTDF-derived participation factors.
Seed script: `scripts/src/seed-ercot-shift-factors.py` (run from pypsa-engine venv).

## Methodology
1. Load ercot_buses (340 buses, all with lat/lon) + ercot_lines (1,807 lines with x_pu reactance)
2. Assign each bus to EIA sub-BA (8 zones) via haversine nearest-centroid
3. DC PTDF via B-matrix: `PTDF = b_l × K_red @ B_bus_red^{-1}` (scipy sparse)
4. Electrical participation: `EP[bus] = Σ_l |PTDF[l,b]| × s_nom[l]`
5. Shift factor: `SF[bus] = EP[bus] / Σ_{b in EIA zone} EP[b]`

## PyPSA version caveat
PyPSA 1.x (installed: 1.2.3) does NOT have `calculate_PTDF()` — it was removed.
Use direct B-matrix decomposition with scipy.sparse instead. The `lpf` and `lpf_contingency` methods exist but don't return PTDF directly.

## EIA zone geographic centroids used
- NCEN: (32.8, -97.3) — DFW; COAS: (29.8, -95.4) — Houston; NRTH: (33.7, -98.0); EAST: (31.8, -95.0)
- SCEN: (29.5, -97.8) — San Antonio; SOUT: (27.5, -98.5); FWES: (31.2, -103.0); WEST: (32.2, -101.3)

## Current zone distribution
COAS: 44, FWES: 104, NCEN: 104, NRTH: 7, SCEN: 16, SOUT: 57, WEST: 8 = 340 total.
**EAST zone has 0 buses** — our 345kV network model has no buses in east Texas; the API returns no data for buses in EAST zone.

## API endpoints added
- `GET /api/ercot/zone-load-hourly?zone=NCEN&year=2024&month=1` → raw EIA-930 hourly [{day,hour,loadMw}]
- `GET /api/ercot/bus-shift-factors?eiaZone=NCEN` → [{busName,ercotZone,eiaZone,shiftFactor,lat,lon,method}]
- `GET /api/ercot/bus-load?bus=ALIBATES_39&year=2024&month=1` → computed hourly [{day,hour,loadMwApprox,shiftFactor}]

## Frontend
`BusLoadExplorer` component in `artifacts/grid-platform/src/pages/nodal.tsx` — bus list with SF badges,
24h average load curve (AreaChart), and 4-metric metadata row. Added to ERCOT section between SpreadSummary and NodeLocationsBrowser.

## Key formula
`bus_load_mw[bus, t] ≈ shift_factor[bus] × ercot_load_by_zone[eia_zone, t]`
No precomputed hourly table (too large: 340 × 174k = 59M rows); computed on-the-fly via SQL JOIN.

**Why:**
The `useGetErcotBusLoad` hook's options must use `{ query: { enabled: ... } as any }` because Orval-generated
hooks in TanStack Query v4 require `queryKey` in `UseQueryOptions` — `enabled` alone causes TS2741.
