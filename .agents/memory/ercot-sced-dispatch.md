---
name: ERCOT SCED Hourly Dispatch
description: Real dispatch data from NP3-965-ER SCED 60-day disclosure — seeding pattern, schema, and API endpoints.
---

## What it is
Real ERCOT SCED (Security Constrained Economic Dispatch) data from the NP3-965-ER 60-day public disclosure.
Covers all ~1,215 generation resources in ERCOT with 5-minute dispatch intervals aggregated to hourly.

## Source & auth
- Report: ERCOT Public API — `np3-965-er` archive endpoint
- Auth: `ErcotAPI(username=ERCOT_USERNAME, password=ERCOT_PASSWORD, public_subscription_key=ERCOT_SUBSCRIPTION_KEY)`
- gridstatus method: `api.get_60_day_sced_disclosure(date="YYYY-MM-DD", end="YYYY-MM-DD+1")`
- 60-day posting offset handled internally — pass operational date directly
- ~17 seconds per day; 852 days total = ~4 hours for full Jan 2024–May 2026 history

## Key data in each row
- `sced_gen_resource`: 5-min dispatch per resource with `SCED1 Offer Curve` = `[[mw, price], ...]` segments (the real merit order bid)
- Offer curve boundary markers: -250 and 5000 are ERCOT sentinels (filter out for real prices)
- Resource types: WIND, PVGR (solar), PWRSTR (storage), CCGT90/SCGT90/SCLE90 (gas), CLLIG (coal), NUC, HYDRO

## DB tables
- `ercot_hourly_dispatch` — PRIMARY KEY (resource_name, hour); stores avg/max MW, HSL, LSL, base_point, online_intervals, offer_price_min/max, offer_mw_total, startup_cold/hot
- `ercot_dispatch_seed_log` — one row per operational date; use for gap-fill (skip already-seeded days)

## Seeder
- Python script: `scripts/src/seed-ercot-dispatch.py`
- npm script: `pnpm --filter @workspace/scripts run seed-ercot-dispatch`
- Admin endpoint: `POST /pypsa/admin/seed-dispatch?key=<ERCOT_PASSWORD>`
- Status: `GET /pypsa/admin/seed-dispatch-status`
- Module: `artifacts/pypsa-engine/dispatch_seeder.py`

## API endpoints (api-server)
- `GET /api/ercot/dispatch/seed-status` — row counts, resources, date range
- `GET /api/ercot/dispatch/dates` — list of seeded operational dates
- `GET /api/ercot/dispatch/supply-stack?date=YYYY-MM-DD` — merit order for one day (1,095 rows)
- `GET /api/ercot/dispatch/summary?months=N` — monthly generation by fuel type
- `GET /api/ercot/dispatch/capacity-factors?granularity=alltime|monthly` — CF by fuel type

## Frontend
- Page: `artifacts/grid-platform/src/pages/ercot-dispatch.tsx`
- Route: `/ercot-dispatch`
- Nav: "ERCOT Dispatch / SCED" in sidebar

## Observed reality (Jan 2024 baseline)
- Nuclear: 99% CF, -$211 avg offer (must-run self-schedule)
- Wind: 95% CF, -$15 avg offer (negative pricing, Jan high-wind)
- Coal: 64% CF, +$1 avg offer (low-cost baseload)
- Gas: 29% CF, +$241 avg offer (peakers at marginal)
- Solar: 85% CF (avg when online — winter daytime)
- Storage: 4% CF (arbitrage/ancillary only)

**Why:** Real offer curves confirm the actual ERCOT merit order — gas peakers set the marginal price, nuclear/wind are must-run, storage is pure arbitrage. Invaluable for spark spread, PPA pricing, and supply stack visualization.
