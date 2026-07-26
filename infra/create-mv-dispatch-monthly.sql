-- ============================================================
-- mv_dispatch_monthly — pre-aggregates ercot_hourly_dispatch by
-- (year, month, resource_name, resource_type). Feeds the ERCOT Dispatch
-- Monthly Summary + "alltime" Capacity Factors (sub-100ms vs scanning 25M rows).
-- Reconstructed from the columns the api-server route queries:
--   total_gen (SUM avg_mw), max_cap (MAX hsl), hours (COUNT), avg_offer, peak_mw.
-- Year/month in America/Chicago to match the dispatch routes.
-- ============================================================

SET work_mem = '512MB';
SET statement_timeout = 0;

DROP MATERIALIZED VIEW IF EXISTS mv_dispatch_monthly;

CREATE MATERIALIZED VIEW mv_dispatch_monthly AS
SELECT
  EXTRACT(year  FROM hour AT TIME ZONE 'America/Chicago')::int AS year,
  EXTRACT(month FROM hour AT TIME ZONE 'America/Chicago')::int AS month,
  resource_name,
  resource_type,
  SUM(avg_mw)          AS total_gen,   -- monthly MWh (hourly avg_mw summed)
  MAX(hsl)             AS max_cap,      -- nameplate proxy for CF denominator
  COUNT(*)             AS hours,        -- online hours in the month
  AVG(offer_price_min) AS avg_offer,    -- representative offer floor (may be NULL pre-offer-seed)
  MAX(avg_mw)          AS peak_mw
FROM ercot_hourly_dispatch
GROUP BY 1, 2, resource_name, resource_type;

CREATE UNIQUE INDEX ON mv_dispatch_monthly (year, month, resource_name, resource_type);

SELECT COUNT(*) AS rows, COUNT(DISTINCT resource_name) AS resources,
       MIN(year*100+month) AS first_ym, MAX(year*100+month) AS last_ym
FROM mv_dispatch_monthly;
