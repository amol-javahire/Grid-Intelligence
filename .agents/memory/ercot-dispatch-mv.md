---
name: ERCOT Dispatch Materialized View + CF Formula
description: mv_dispatch_monthly pre-aggregates 26M-row ercot_hourly_dispatch; correct CF formula; date-range WHERE clause pattern.
---

## Materialized View: mv_dispatch_monthly

Pre-aggregates `ercot_hourly_dispatch` (26M rows, ~2.6 GB) by (year, month, resource_name, resource_type):
- 38,820 rows covering Jan 2024 – May 2026
- Columns: year, month, resource_name, resource_type, total_gen, max_cap, hours, peak_mw, avg_offer
- UNIQUE INDEX on (year, month, resource_name, resource_type)

**Why:** Postgres must heap-fetch avg_mw + hsl + resource_name for every qualifying row even with (resource_type, hour) index. At 12M rows per 12-month window this takes 43 seconds. The MV eliminates heap access entirely.

**How to apply:** Route /ercot/dispatch/summary and /capacity-factors?granularity=alltime to query mv_dispatch_monthly, not ercot_hourly_dispatch. After seeding new months, run: `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dispatch_monthly;` (requires the unique index).

## Date filter on MV

The MV has year/month columns (integers), not a timestamp. Filter with arithmetic:
```sql
WHERE (year * 12 + month) >= (
  EXTRACT(year  FROM NOW() - (N || ' months')::interval)::int * 12 +
  EXTRACT(month FROM NOW() - (N || ' months')::interval)::int
)
```

## Correct CF Formula

**Wrong:** `AVG(avg_mw / hsl)` per hourly row — inflates CF because HSL follows real-time available capacity (derated in summer heat, forced outages), not nameplate.

**Correct:** `SUM(avg_mw) / (MAX(hsl) * COUNT(*))` in a per-resource subquery — true "total MWh generated / (nameplate MW × available hours)". In the MV context: `SUM(total_gen) / NULLIF(SUM(max_cap * hours::float), 0)`.

Realistic 12-month averages (2025–2026):
- Nuclear: ~91% (baseload, high utilization)
- Coal: ~53% (baseload, cycling in summer)
- Natural Gas: ~43% (load-following)
- Wind: ~37% (ERCOT typical annual)
- Solar: ~25% (seasonal, summer peak)
- Storage: ~5% (cycling, not baseload)
- Hydro: ~8% (ERCOT has almost no hydro)

## Supply Stack WHERE Clause

Base table query for supply stack (daily/range average) must use UTC-aware range to hit the idx_erd_hour btree index:
```sql
WHERE hour >= date::timestamp AT TIME ZONE 'America/Chicago'
  AND hour <  (end + 1)::timestamp AT TIME ZONE 'America/Chicago'
```
**Do not use** `DATE(hour AT TIME ZONE 'America/Chicago') = date` — forces a full-table function scan (~timeout).
