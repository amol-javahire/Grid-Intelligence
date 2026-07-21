---
name: ERCOT Capture Price Materialized View
description: mv_capture_monthly — generation-weighted hub capture price per fuel type per month; join pattern and hub table quirks.
---

## Materialized View: mv_capture_monthly

**179 rows** covering Jan 2024 – Dec 2025 (limited by ercot_hub_hourly coverage).

Columns: year, month, resource_type, capture_price_rt, capture_price_da, hub_avg_rt, hub_avg_da, total_gen_mwh.
Derived columns in query: capture_rate_rt = capture_price_rt / hub_avg_rt, capture_rate_da = capture_price_da / hub_avg_da.

UNIQUE INDEX on (year, month, resource_type).

## Critical join pattern — pre-aggregate first

**Do NOT** join ercot_hourly_dispatch (26M rows) directly with ercot_hub_hourly (21K rows):
- code_execution sandbox times out
- Even psql takes 3–5 minutes

**Correct approach**: pre-aggregate dispatch to (year, month, day, chi_hour, resource_type) → sum_gen first, giving ~170K rows, then join the small result with hub prices. Postgres can hash-join 170K × 21K in seconds.

```sql
WITH dispatch_hourly_agg AS (
  SELECT
    EXTRACT(year  FROM hour AT TIME ZONE 'America/Chicago')::int      AS year,
    EXTRACT(month FROM hour AT TIME ZONE 'America/Chicago')::int      AS month,
    EXTRACT(day   FROM hour AT TIME ZONE 'America/Chicago')::int      AS day,
    (EXTRACT(hour FROM hour AT TIME ZONE 'America/Chicago')::int + 1) AS chi_hour,
    resource_type, SUM(avg_mw) AS sum_gen
  FROM ercot_hourly_dispatch WHERE avg_mw > 0
  GROUP BY 1, 2, 3, 4, 5
), hub AS (
  SELECT year, month, day, hour, rt_price, da_price
  FROM ercot_hub_hourly WHERE node = 'HB_BUSAVG'
)
SELECT d.year, d.month, d.resource_type,
  SUM(d.sum_gen * h.rt_price) / SUM(d.sum_gen) AS capture_price_rt,
  ...
FROM dispatch_hourly_agg d
JOIN hub h ON h.year=d.year AND h.month=d.month AND h.day=d.day AND h.hour=d.chi_hour
GROUP BY d.year, d.month, d.resource_type
```

## ercot_hub_hourly hour column

- CDR format: hour is INTEGER 1–24 (not 0-23)
- EXTRACT(hour FROM timestamp AT TIME ZONE 'America/Chicago') → 0–23
- Mapping: chi_hour = EXTRACT(hour...)::int + 1
- Node to use for market-wide avg: 'HB_BUSAVG'
- Table columns: id, node, node_type, year, month, day, hour (int), da_price, rt_price, created_at
- Coverage: Jan 2024 – Dec 2025 (263,130 rows, 15 nodes, 17,542 hrs/node)

## Typical capture rates (2-year ERCOT avg)

- Storage: 1.44–2.73× (buys low, sells high — best timing)
- Nuclear: ~1.00× (flat baseload = average by definition)
- Coal: 1.09–1.27× (dispatches at high-load hours)
- Natural Gas: 0.92–1.05× (load-following, near par)
- Wind: 0.72–0.85× (off-peak + nighttime generation)
- Solar: 0.59–0.93× (midday prices suppressed by solar penetration)

**Why:** These rates are crucial for PPA valuation — a solar PPA priced at hub average overpays if the actual capture rate is 0.65.

## API endpoint

GET /api/ercot/dispatch/capture?months=N → from mv_capture_monthly, response time ~3–20ms.
Frontend: /ercot-dispatch page, "Capture Prices" and "Capture Rates" tabs.
