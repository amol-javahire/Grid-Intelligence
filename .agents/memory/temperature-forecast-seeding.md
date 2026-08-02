---
name: Temperature forecast seeding
description: temperature_forecasts table approach, Open-Meteo Climate API coverage issues, and climatological fallback
---

## Table
`temperature_forecasts`: iso, zone, year, month, day, temp_mean_f, temp_min_f, temp_max_f, model
Unique constraint: (iso, zone, year, month, day)

## Data
- 12,056 rows: 11 zones × 1,096 days (Jul 2026 – Jun 2029)
- COAS, NCEN (ERCOT) + SP15 (CAISO): seeded from Open-Meteo CMIP6 Climate API (MRI_AGCM3_2_S)
- 8 remaining zones: climatological projection (see below)

## Open-Meteo Climate API Coverage Issues
**Why:** `climate-api.open-meteo.com/v1/climate` returns "Could not read reference weight file" for many North American coordinates depending on the model. CMIP6 models have spatially inconsistent interpolation weight caching.
- EC_Earth3P_HR: works for some Texas/CA coords (COAS, NCEN, SP15), fails for others
- MRI_AGCM3_2_S: same pattern
- HiRAM_SIT_HR and NICAM16_8S: broader coverage (verified for NRTH, EAST, SCEN, etc.)
- API also rate-limits on repeated requests within a session (empty 200 response)

**How to apply:** If re-seeding from Climate API, test each zone with curl first. Use HiRAM_SIT_HR as default, EC_Earth3P_HR as fallback. The Python seed script retries (up to 5×) but still hits rate limits — add 2–3s sleep between zones, not just on failure.

## Climatological Projection Method
`seed-temperature-forecast.py` (climatology branch):
1. Fetch all historical daily means/mins/maxs from `iso_hourly_temps` (GROUP BY iso, zone, year, month, day)
2. Average across years for same (month, day) key
3. For each future date: add warming trend = (target_year_decimal - 2025.5) × 0.3°F/yr
4. Upsert into temperature_forecasts with model='climatology_+0.3F/yr'
Gap-fill: skips zones already having ≥ 1090 rows

## Frontend
weather.tsx has top-level Actuals|Forecast toggle. Forecast view:
- 3-year monthly overview: ComposedChart with stacked Area (min + band) + Line (mean)
- Monthly detail: daily mean/min/max for selected month
- Zone summary stats table
- Methodology note in footer
