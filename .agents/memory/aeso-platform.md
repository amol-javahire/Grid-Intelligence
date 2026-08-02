---
name: AESO Platform
description: Standalone Alberta power market analytics artifact at /aeso/; architecture, data model, and key gotchas.
---

## Setup
- Artifact: `artifacts/aeso-platform`, previewPath `/aeso/`, port 22537
- Backend routes: `artifacts/api-server/src/routes/aeso_stats.ts` (wired in routes/index.ts)
- 9 DB tables all prefixed `aeso_*` — defined in `lib/db/src/schema/aeso.ts`, exported in schema index

## Data Model
- `aeso_hourly_pool_price` — unique(date, hour_ending); ~21k hourly rows Jan2024–May2026
- `aeso_hourly_gen_output` — unique(date, hour_ending); same date range
- `aeso_supply_demand` — unique(date, hour_ending)
- `aeso_actual_forecast` — unique(date, hour_ending)
- `aeso_outages`, `aeso_queue_projects`, `aeso_7day_capability`, `aeso_constraint_events`, `aeso_transmission_corridors` — no unique constraint (seed with truncate, not upsert)
- Seed script: `scripts/src/seed-aeso-data.ts`, command `seed-aeso-data`

## Key Calibration (Alberta)
- Pool price avg ~$32-35/MWh; spikes to $999.99 cap; negative prices possible off-peak high-wind
- Generation: gas ~60%, wind ~30%, solar ~5%, hydro ~5%; coal = 0 (phased out 2023)
- AIL load: 9,000–13,000 MW (weekday/weekend, seasonal)
- HE1–HE24 hour convention (Mountain Time)

## Critical Gotcha
- `db.execute()` returns `{ rows: [...], rowCount: ... }` — NOT an iterable array.
- Destructuring `const [row] = await db.execute(...)` throws "not iterable".
- **Correct pattern**: `const result = await db.execute(...); const row = result.rows[0];`
- All 16 routes in aeso_stats.ts use `.rows[0]` / `.rows.map()` correctly.

## 16 API Endpoints
All under `/api/aeso/*`: dashboard, pool-price, pool-price/stats, pool-price/spikes,
generation, generation/monthly, supply-demand, supply-demand/stats, outages,
outages/upcoming, 7day-capability, queue, queue/stats, constraints,
actual-forecast, transmission-corridors
