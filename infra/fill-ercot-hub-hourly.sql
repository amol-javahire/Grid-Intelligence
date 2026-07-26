-- ============================================================
-- Populate ercot_hub_hourly from the hourly ercot_node_prices seed.
--
-- ercot_hub_hourly was empty on Azure, which broke:
--   • PyPSA Battery Revenue sim  ("No hourly data for HB_PAN 2025-06")
--   • ERCOT Historical → Hourly Shape tab
--   • (originally the capture MV, now repointed to ercot_node_prices)
--
-- Only the 15 hub/zone nodes are stored here (HB_* / LZ_*), matching the
-- table's original scope. hour = HourEnding 1-24 (interval-start hour + 1),
-- consistent with the CDR convention the app's queries assume.
--
-- Idempotent: DELETE + re-INSERT the 2025+ window that ercot_node_prices covers.
-- ============================================================

SET work_mem = '512MB';
SET statement_timeout = 0;

-- The table existed on Azure without its Drizzle-defined indexes; create them
-- (needed for ON CONFLICT below, and for the app's node/time lookups).
CREATE UNIQUE INDEX IF NOT EXISTS ercot_hub_hourly_uq
  ON ercot_hub_hourly (node, year, month, day, hour);
CREATE INDEX IF NOT EXISTS ercot_hub_hourly_node_idx ON ercot_hub_hourly (node);
CREATE INDEX IF NOT EXISTS ercot_hub_hourly_time_idx ON ercot_hub_hourly (year, month, day, hour);

DELETE FROM ercot_hub_hourly WHERE year >= 2025;

INSERT INTO ercot_hub_hourly (node, node_type, year, month, day, hour, da_price, rt_price)
SELECT
  node_name                                    AS node,
  CASE WHEN node_name LIKE 'HB\_%' THEN 'hub' ELSE 'load_zone' END AS node_type,
  EXTRACT(year  FROM hour)::int                AS year,
  EXTRACT(month FROM hour)::int                AS month,
  EXTRACT(day   FROM hour)::int                AS day,
  EXTRACT(hour  FROM hour)::int + 1            AS hour,   -- interval-start → HourEnding 1-24
  ROUND(da_price::numeric, 4)                  AS da_price,
  ROUND(rt_price::numeric, 4)                  AS rt_price
FROM ercot_node_prices
WHERE (node_name LIKE 'HB\_%' OR node_name LIKE 'LZ\_%')
ON CONFLICT (node, year, month, day, hour) DO UPDATE
  SET da_price = EXCLUDED.da_price,
      rt_price = EXCLUDED.rt_price;

-- Verify: node coverage + the exact slice the battery sim asked for.
SELECT COUNT(*) AS rows, COUNT(DISTINCT node) AS nodes,
       MIN(year*100+month) AS first_ym, MAX(year*100+month) AS last_ym
FROM ercot_hub_hourly;

SELECT node, COUNT(*) AS hours,
       ROUND(AVG(da_price),2) AS avg_da, ROUND(AVG(rt_price),2) AS avg_rt
FROM ercot_hub_hourly
WHERE node = 'HB_PAN' AND year = 2025 AND month = 6
GROUP BY node;
