---
name: AESO Real Data Seeder
description: Comprehensive TypeScript seeder for all AESO public APIs — endpoints, schema, and run instructions
---

# AESO Real Data Seeder

## Script
`scripts/src/seed-aeso-real.ts` — run with `pnpm --filter @workspace/scripts run seed-aeso-real`
Requires: `AESO_API_KEY` environment secret.

## API Gateway
Base: `https://apimgw.aeso.ca/public/`
Auth header: `API-KEY: <key>`
Register free: https://developer-apim.aeso.ca

## Endpoints covered (all confirmed with user)

| Data | Endpoint path |
|------|---------------|
| Pool price (actual + forecast + 30d rolling avg) | `poolprice-api/v1.1/price/poolPrice?startDate=&endDate=` |
| Actual/Forecast AIL + price forecasts | `actualforecast-api/v1/load/albertaInternalLoad?startDate=&endDate=` |
| AIES gen capacity & unit-level outages | `aiesgencapacity-api/v1/AIESGenCapacity?startDate=&endDate=` |
| Operating reserve (FFR, contingency, spinning) | `operatingreserveoffercontrol-api/v1/operatingReserveOfferControl?startDate=` |
| Load outage forecast | `loadoutageforecast-api/v1/loadOutageReport?startDate=&endDate=` |
| Metered volume (generator-level) | `meteredvolume-api/v1/meteredvolume/details?startDate=&endDate=&asset_ID=&pool_participant_ID=` |
| Asset list (AIES registry) | `assetlist-api/v1/assetlist?asset_ID=&pool_participant_ID=&operating_status=&asset_type=` |
| Pool participants | `PoolParticipant-api/v1/poolparticipantlist?pool_participant_ID=&pool_participant_name=` |
| Energy merit order / supply stack | `energymeritorder-api/v1/meritOrder/energy?startDate=` |
| Intertie/flowgate outages (BC/SK) | `itc/v1/outage?startDate=&endDate=&affectedIntertieOrFlowgate=` |
| Interchange actual + scheduled | `itc/v1/interchange?startDate=&endDate=&startHE=&endHE=&version=&dataType=&intertieOrFlowgate=&transferType=` |
| System marginal price (SMP) | `systemmarginalprice-api/v1.1/price/systemMarginalPrice?startDate=&endDate=` |
| Unit commitment data | `unitcommitmentdata-api/v2/unitCommitment?startDate=&endDate=` |
| Current supply & demand (snapshot) | `currentsupplydemand-api/v2/csd/summary/current` |

## DB tables written to
- `aeso_hourly_pool_price` — with columns: rolling_30d_avg, day_ahead_forecast_price, rt_forecast_price (added)
- `aeso_actual_forecast` — with columns: day_ahead_forecast_pool_price, rt_forecast_pool_price, ail_forecast_error_mw (added)
- `aeso_generation_outage` — with column: approved_outage_mw (added)
- `aeso_operating_reserve` — new table
- `aeso_supply_demand` — load_outage_mw column (added)
- `aeso_metered_volume` — new table (generator-level)
- `aeso_asset_registry` — new table
- `aeso_pool_participants` — new table
- `aeso_merit_order` — new table (offer blocks per generator per hour; cumulative_mw + is_marginal columns)
- `aeso_intertie_outage` — new table (BC/SK flowgate outages by hour; Jan 2024→today)
- `aeso_interchange` — new table (actual + scheduled BC/SK flows; version=1; unique on date+HE+intertie+data_type)
- `aeso_smp` — pre-existing table (constrained_price, unconstrained_price, spread, volume_mw); Jan 2024→today
- `aeso_unit_commitment` — new table (committed/dispatched/available MW per asset per hour; last 90 days)

## Date range
- Pool price, AIL, gen capacity, op reserve: Jan 2024 → today, by month chunks (gap-fill)
- Load outage, metered volume: last 90/30 days (large dataset)
- Asset list, pool participants: one-time pull

## AESO datetime format
Response field: `begin_datetime_mpt` — format is either "MM/DD/YYYY HE##" or "YYYY-MM-DD HE##"
The `parseAesoDatetime()` function handles both.

**Why:** All 9 endpoints confirmed real by user. Seeder is idempotent (gap-fill by month). API key registered free at developer-apim.aeso.ca; missing key was `AESO_API_KEY`.
