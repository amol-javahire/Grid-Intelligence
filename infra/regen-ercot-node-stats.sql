-- ============================================================
-- Regenerate ercot_node_stats FROM hourly ercot_nodal_da_rt_hourly.
--
-- ercot_node_stats is the shared monthly table read by: the scoring engine
-- (candidates curtailment/congestion/basis dims), all 6 CI pages, ERCOT
-- Historical, Nodal, Gas/Spark, Heat-Rate. Regenerating it here upgrades every
-- one of those to real-hourly-derived stats in a single pass, and fills the
-- ~950 resource nodes that were previously missing on Azure (only 360 hub/zone
-- rows existed).
--
-- node_type: HB_* → hub, LZ_* → load_zone, else resource_node (matches app code).
-- neg_price_percent: from RT (rt_price < 0) — the curtailment signal.
-- on/off-peak, volatility, min/max: from DA (the primary settlement price).
-- On-peak = HE07–HE22 Mon–Fri → interval-start hour 6..21, weekday.
--
-- Only touches 2025-01 onward (ercot_nodal_da_rt_hourly coverage). Any pre-2025 rows
-- already in ercot_node_stats (hub/zone from the prior seed) are preserved.
-- Idempotent: DELETE + re-INSERT the 2025+ window.
-- ============================================================

SET work_mem = '512MB';

DELETE FROM ercot_node_stats WHERE year >= 2025;

INSERT INTO ercot_node_stats
  (node, node_type, year, month,
   avg_da_price, avg_rt_price, volatility, neg_price_percent,
   on_peak_avg, off_peak_avg, min_price, max_price)
SELECT
  node_name AS node,
  CASE
    WHEN node_name LIKE 'HB\_%' THEN 'hub'
    WHEN node_name LIKE 'LZ\_%' THEN 'load_zone'
    ELSE 'resource_node'
  END AS node_type,
  EXTRACT(year  FROM hour)::int  AS year,
  EXTRACT(month FROM hour)::int  AS month,
  ROUND(AVG(da_price)::numeric, 4)                                   AS avg_da_price,
  ROUND(AVG(rt_price)::numeric, 4)                                   AS avg_rt_price,
  ROUND(STDDEV_SAMP(da_price)::numeric, 4)                           AS volatility,
  ROUND(100.0 * COUNT(*) FILTER (WHERE rt_price < 0)
        / NULLIF(COUNT(rt_price), 0), 3)                             AS neg_price_percent,
  ROUND(AVG(da_price) FILTER (
        WHERE EXTRACT(dow  FROM hour) BETWEEN 1 AND 5
          AND EXTRACT(hour FROM hour) BETWEEN 6 AND 21)::numeric, 4) AS on_peak_avg,
  ROUND(AVG(da_price) FILTER (
        WHERE NOT (EXTRACT(dow  FROM hour) BETWEEN 1 AND 5
               AND EXTRACT(hour FROM hour) BETWEEN 6 AND 21))::numeric, 4) AS off_peak_avg,
  ROUND(MIN(da_price)::numeric, 4)                                   AS min_price,
  ROUND(MAX(da_price)::numeric, 4)                                   AS max_price
FROM ercot_nodal_da_rt_hourly
WHERE da_price IS NOT NULL
GROUP BY node_name, EXTRACT(year FROM hour), EXTRACT(month FROM hour);

-- Spot checks — compare against project reference values:
--   West Texas wind nodes ~7-8% neg-price; HB_PAN ~22%; fleet resource avg ~6.4%.
SELECT node_type, COUNT(*) AS rows, COUNT(DISTINCT node) AS nodes,
       ROUND(AVG(neg_price_percent),2) AS avg_neg_pct
FROM ercot_node_stats WHERE year >= 2025
GROUP BY node_type ORDER BY node_type;

SELECT node, ROUND(AVG(neg_price_percent),1) AS neg_pct, ROUND(AVG(avg_da_price),2) AS da
FROM ercot_node_stats
WHERE node IN ('HB_PAN','HB_NORTH','HB_WEST','HB_HOUSTON') AND year >= 2025
GROUP BY node ORDER BY node;
