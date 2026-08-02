-- ============================================================
-- mv_capture_monthly — generation-weighted capture price per fuel/month.
-- Sources hourly prices from ercot_nodal_da_rt_hourly (all nodes, Jan 2025→now).
--
-- Gen-weighted zone capture:  Σ(gen × zone_LMP) / Σ(gen)
-- System reference (hub_avg): Σ(gen × HB_BUSAVG)  / Σ(gen)
-- Route reads: year, month, resource_type, capture_price_rt/da, hub_avg_rt/da, total_gen_mwh.
--
-- PERF: join dispatch↔prices on a single Central-hour TIMESTAMP (h_local),
-- computed once, instead of four derived (year,month,day,HE) columns — the
-- 4-column version nested-looped and ran 20+ min. Both sides use interval-start
-- Central time so the hours line up (dispatch is UTC→Chicago; node_prices is
-- already naive-Central interval-start).
-- ============================================================

SET work_mem = '512MB';
SET statement_timeout = 0;

DROP MATERIALIZED VIEW IF EXISTS mv_capture_monthly;

CREATE MATERIALIZED VIEW mv_capture_monthly AS
WITH disp AS (
    SELECT
        date_trunc('hour', d.hour AT TIME ZONE 'America/Chicago') AS h_local,
        d.resource_type,
        CASE COALESCE(nl.load_zone, 'LZ_HOUSTON')
            WHEN 'LZ_AEN'   THEN 'LZ_SOUTH'
            WHEN 'LZ_CPS'   THEN 'LZ_SOUTH'
            WHEN 'LZ_LCRA'  THEN 'LZ_SOUTH'
            WHEN 'LZ_RAYBN' THEN 'LZ_NORTH'
            ELSE COALESCE(nl.load_zone, 'LZ_HOUSTON')
        END AS load_zone,
        SUM(d.avg_mw) AS gen
    FROM ercot_hourly_dispatch d
    LEFT JOIN ercot_node_locations nl ON nl.node_name = d.resource_name
    WHERE d.avg_mw > 0
      AND d.hour >= '2024-12-31'::timestamptz     -- ercot_nodal_da_rt_hourly starts 2025-01
    GROUP BY 1, 2, 3
),
prices AS (
    SELECT node_name,
           date_trunc('hour', hour) AS h_local,
           rt_price, da_price
    FROM ercot_nodal_da_rt_hourly
    WHERE node_name IN ('LZ_NORTH','LZ_SOUTH','LZ_WEST','LZ_HOUSTON','HB_BUSAVG')
)
SELECT
    EXTRACT(year  FROM d.h_local)::int AS year,
    EXTRACT(month FROM d.h_local)::int AS month,
    d.resource_type,
    SUM(d.gen * pz.rt_price) / NULLIF(SUM(d.gen), 0) AS capture_price_rt,
    SUM(d.gen * pz.da_price) / NULLIF(SUM(d.gen), 0) AS capture_price_da,
    SUM(d.gen * ps.rt_price) / NULLIF(SUM(d.gen), 0) AS hub_avg_rt,
    SUM(d.gen * ps.da_price) / NULLIF(SUM(d.gen), 0) AS hub_avg_da,
    SUM(d.gen)                                       AS total_gen_mwh
FROM disp d
JOIN prices pz ON pz.node_name = d.load_zone AND pz.h_local = d.h_local
JOIN prices ps ON ps.node_name = 'HB_BUSAVG'  AND ps.h_local = d.h_local
GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX ON mv_capture_monthly (year, month, resource_type);

SELECT year, resource_type,
       ROUND(capture_price_rt::numeric,2) AS cap_rt,
       ROUND(hub_avg_rt::numeric,2)       AS sys_rt,
       ROUND((capture_price_rt/NULLIF(hub_avg_rt,0))::numeric,3) AS rate_rt
FROM mv_capture_monthly WHERE month = 6 ORDER BY year, resource_type;
