-- ============================================================
-- mv_capture_monthly — generation-weighted capture price
-- REPOINTED: sources hourly prices from ercot_node_prices (all nodes,
--            Jan 2025 → present) instead of ercot_hub_hourly (15 nodes,
--            ended Dec 2025). Same gen-weighting + zone logic as the
--            original Replit view; only the price join changed.
--
-- Coverage: Jan 2025 → latest seeded hour in ercot_node_prices.
--   DA is fully seeded; RT columns are only correct once RT seeding
--   completes — REFRESH this view again after RT finishes.
--
-- Join keys (unchanged from original):
--   ercot_hourly_dispatch.resource_name = ercot_node_locations.node_name
--   → load_zone (minor zones collapsed) = price node in ercot_node_prices
--   system reference node = HB_BUSAVG
--
-- Time alignment:
--   dispatch.hour is timestamptz (UTC) → converted to America/Chicago,
--     hour-of-day + 1 = CDR HourEnding (1-24).
--   ercot_node_prices.hour is naive Central interval-start (HE-1),
--     so EXTRACT(hour)+1 = the same CDR HourEnding. Dates/HE line up.
-- ============================================================

-- Keep the big aggregation in RAM (avoids disk spill / BufFileRead thrash).
SET work_mem = '512MB';
SET statement_timeout = 0;

DROP MATERIALIZED VIEW IF EXISTS mv_capture_monthly;

CREATE MATERIALIZED VIEW mv_capture_monthly AS
WITH
-- Steps 1-3 fused: join dispatch → zone mapping, then aggregate straight to
-- (year, month, day, CDR-hour, resource_type, load_zone) in a single GROUP BY.
-- This avoids dragging a ~15M-row per-resource intermediate through memory.
dispatch_zone_hourly AS (
    SELECT
        EXTRACT(year  FROM (d.hour AT TIME ZONE 'America/Chicago'))::int      AS yr,
        EXTRACT(month FROM (d.hour AT TIME ZONE 'America/Chicago'))::int      AS mo,
        EXTRACT(day   FROM (d.hour AT TIME ZONE 'America/Chicago'))::int      AS dy,
        EXTRACT(hour  FROM (d.hour AT TIME ZONE 'America/Chicago'))::int + 1  AS chi_hr,
        d.resource_type,
        CASE COALESCE(nl.load_zone, 'LZ_HOUSTON')
            WHEN 'LZ_AEN'   THEN 'LZ_SOUTH'
            WHEN 'LZ_CPS'   THEN 'LZ_SOUTH'
            WHEN 'LZ_LCRA'  THEN 'LZ_SOUTH'
            WHEN 'LZ_RAYBN' THEN 'LZ_NORTH'
            ELSE COALESCE(nl.load_zone, 'LZ_HOUSTON')
        END AS load_zone,
        SUM(d.avg_mw) AS sum_gen
    FROM ercot_hourly_dispatch d
    LEFT JOIN ercot_node_locations nl ON nl.node_name = d.resource_name
    WHERE d.avg_mw > 0
      AND d.hour >= '2024-12-31'::timestamptz   -- ercot_node_prices starts 2025-01
    GROUP BY yr, mo, dy, chi_hr, d.resource_type, load_zone
),

-- Price source: ercot_node_prices reduced to the 5 nodes capture needs,
-- with CDR-style (year, month, day, HE 1-24) keys derived from the timestamp.
node_price_cdr AS (
    SELECT
        node_name                             AS node,
        EXTRACT(year  FROM hour)::int         AS yr,
        EXTRACT(month FROM hour)::int         AS mo,
        EXTRACT(day   FROM hour)::int         AS dy,
        EXTRACT(hour  FROM hour)::int + 1     AS hr,   -- interval-start → HE
        rt_price,
        da_price
    FROM ercot_node_prices
    WHERE node_name IN ('LZ_NORTH','LZ_SOUTH','LZ_WEST','LZ_HOUSTON','HB_BUSAVG')
)

-- Step 4: generation-weighted capture price per (year, month, resource_type).
SELECT
    d.yr AS year,
    d.mo AS month,
    d.resource_type,
    SUM(d.sum_gen * h_zone.rt_price) / NULLIF(SUM(d.sum_gen), 0) AS capture_price_rt,
    SUM(d.sum_gen * h_zone.da_price) / NULLIF(SUM(d.sum_gen), 0) AS capture_price_da,
    SUM(d.sum_gen * h_sys.rt_price)  / NULLIF(SUM(d.sum_gen), 0) AS hub_avg_rt,
    SUM(d.sum_gen * h_sys.da_price)  / NULLIF(SUM(d.sum_gen), 0) AS hub_avg_da,
    SUM(d.sum_gen)                                               AS total_gen_mwh
FROM dispatch_zone_hourly d
JOIN node_price_cdr h_zone
  ON h_zone.node = d.load_zone
 AND h_zone.yr = d.yr AND h_zone.mo = d.mo AND h_zone.dy = d.dy AND h_zone.hr = d.chi_hr
JOIN node_price_cdr h_sys
  ON h_sys.node = 'HB_BUSAVG'
 AND h_sys.yr = d.yr AND h_sys.mo = d.mo AND h_sys.dy = d.dy AND h_sys.hr = d.chi_hr
GROUP BY d.yr, d.mo, d.resource_type;

CREATE UNIQUE INDEX ON mv_capture_monthly (year, month, resource_type);
