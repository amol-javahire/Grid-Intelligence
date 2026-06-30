---
name: EIA-930 ERCOT load and fuel mix seeding
description: How to seed ercot_load_by_zone and ercot_fuel_mix with real EIA-930 data; zone names; auth notes
---

## Rule
Use EIA-930 API v2 for real ERCOT hourly load (by zone) and generation (by fuel). ERCOT NP6-345-CD is NOT accessible via the ERCOT public reports API even with valid Bearer token.

**Why:** The NP6-345-CD endpoint returns 404 regardless of auth. EIA-930 sub-BA data is the only public hourly zone-level load source available.

## EIA-930 Endpoints

| Data | Endpoint | Key Params |
|------|----------|------------|
| Zone load | `/v2/electricity/rto/region-sub-ba-data/data/` | `facets[parent][]=ERCO` |
| Fuel mix | `/v2/electricity/rto/fuel-type-data/data/` | `facets[respondent][]=ERCO` |
| Total demand | `/v2/electricity/rto/region-data/data/` | `facets[respondent][]=ERCO`, `facets[type][]=D` |

## Zone Mapping (DB zone column values)
EIA sub-BA codes stored directly as zone names:
- COAS = Coast, EAST = East, FWES = Far West, NCEN = North Central
- NRTH = North, SCEN = South Central, SOUT = South, WEST = West

**Do NOT use old LZ_* names** — frontend was updated to ZONE_LABELS mapping these codes to display names.

## Fuel Type Mapping
EIA code → DB fuel_type: COL→coal, NG→natural_gas, NUC→nuclear, OTH→other, SUN→solar, WAT→hydro, WND→wind, BAT→storage

## Real Data Characteristics (Jan 2024–Jun 2026)
- Natural gas: ~22 GW avg (dominant fuel)
- Wind: ~13 GW avg
- Solar: ~7 GW avg (growing fast)
- Nuclear: ~4.6 GW (constant)
- Hydro: ~52 MW avg — ERCOT has almost NO hydro (synthetic model had 700 MW, completely wrong)
- NCEN (North Central) is the largest zone at ~20 GW peak in summer

## ERCOT OAuth (for other endpoints)
- Token URL: `https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token`
- Grant: ROPC password flow, `response_type=id_token`
- Credentials: ERCOT_CLIENT_ID, ERCOT_USERNAME, ERCOT_PASSWORD, ERCOT_SUBSCRIPTION_KEY

## Seeder
`scripts/src/seed-ercot-real-data.py` — run with `cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-ercot-real-data.py`. Truncates and re-seeds from START_YEAR/MONTH. If it times out, re-run with updated START_YEAR/MONTH to continue (uses ON CONFLICT DO NOTHING).
