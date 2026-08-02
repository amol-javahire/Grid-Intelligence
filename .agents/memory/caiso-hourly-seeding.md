---
name: CAISO Hourly Seeding
description: caiso_hub_da_rt_hourly table seeding details — endpoints, format, and idempotency logic
---

## Rule
CAISO hourly DA prices use `PRC_LMP` + `market_run_id=DAM`; RT prices use `PRC_HASP_LMP` + `market_run_id=HASP` (15-min intervals averaged to hourly). NOT `PRC_LMP/RTM` — that endpoint returns 114-byte empty response.

**Why:** CAISO OASIS distinguishes the Day-Ahead Market (DAM) from the Hour-Ahead Scheduling Process (HASP) at the query name level, not just the market_run_id. Using PRC_LMP with RTM returns empty data; PRC_HASP_LMP with HASP returns 4 × 15-min intervals per hour that must be averaged.

## How to apply
- DA fetch: `queryname=PRC_LMP&market_run_id=DAM`
- RT fetch: `queryname=PRC_HASP_LMP&market_run_id=HASP`
- HASP CSV columns: `OPR_DT`, `OPR_HR`, `LMP_TYPE` (filter on `LMP`), `MW`
- Average all intervals with same `(OPR_DT, OPR_HR)` to get 1 row/hour
- Valid nodes: `TH_SP15_GEN-APND` (SP15), `TH_NP15_GEN-APND` (NP15), `TH_ZP26_GEN-APND` (ZP26)

## Idempotency
Seeder skips months where RT is already populated; re-runs DA-only months to upsert RT prices via `ON CONFLICT DO UPDATE SET rt_price = EXCLUDED.rt_price`.

## Status (as of June 2026)
63,495 rows — 3 nodes × 29 months (Jan 2024 – May 2026), all DA+RT populated.
