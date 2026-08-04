-- ============================================================================
-- Build caiso_node_stats properly — CAISO has been scored off 3 nodes.
--
-- WHAT WAS WRONG
--   caiso_node_stats held 81 rows covering THREE distinct nodes (NP15, SP15,
--   ZP26 — the trading hubs), while ercot_node_stats carries per-resource-node
--   statistics. Meanwhile caiso_nodal_da_rt_hourly holds real DA/RT history for
--   ~2,800 nodes. The raw data was always there; the monthly aggregation was
--   simply never run for CAISO.
--
--   Consequence: all 2,311 CAISO candidates get Basis Risk, Congestion and
--   Curtailment from three hub-level numbers, while ERCOT candidates get
--   node-level resolution. CAISO and ERCOT scores were therefore not
--   comparable, despite being ranked against each other in the same table.
--
--   It also explains why the caiso_node_locations join in assign-and-score-nodal
--   was dead code beyond the missing table: it required
--   HAVING COUNT(DISTINCT cns.node) >= 3 PER ZONE, which three nodes spread
--   across three zones can never satisfy.
--
-- SCHEMA PARITY WITH ERCOT
--   Adds node_type, min_price, max_price, and — importantly — the UNIQUE
--   (node, year, month) constraint that ERCOT has and CAISO did not. Without
--   it a re-run INSERTs duplicates instead of upserting, and every downstream
--   AVG() silently over-weights whatever was inserted twice.
--
-- TIMEZONE
--   caiso_nodal_da_rt_hourly stores a NAIVE timestamp in Pacific local,
--   hour-beginning (verified 2026-08-03: identical DA values appear one hour
--   earlier here than in caiso_hub_da_rt_hourly, which is hour-ending). On-peak
--   windows below are therefore computed directly on that column with no
--   conversion. See iso_table_metadata.
--
-- Run:  psql "$DATABASE_URL" -f infra/2026-08-04-build-caiso-node-stats.sql
-- ============================================================================

\timing on
SET work_mem = '512MB';
SET statement_timeout = 0;

-- ── Step 1: schema parity ───────────────────────────────────────────────────
BEGIN;

ALTER TABLE caiso_node_stats ADD COLUMN IF NOT EXISTS node_type  TEXT;
ALTER TABLE caiso_node_stats ADD COLUMN IF NOT EXISTS min_price  NUMERIC(10,4);
ALTER TABLE caiso_node_stats ADD COLUMN IF NOT EXISTS max_price  NUMERIC(10,4);

-- Label the three pre-existing hub rows before the constraint goes on, so the
-- upsert below does not collide with unlabelled duplicates.
UPDATE caiso_node_stats SET node_type = 'hub' WHERE node_type IS NULL;

-- De-duplicate defensively: the table has never had a uniqueness guarantee, so
-- assume nothing. Keeps the most recently created row per (node, year, month).
DELETE FROM caiso_node_stats a
USING caiso_node_stats b
WHERE a.node = b.node AND a.year = b.year AND a.month = b.month
  AND a.id < b.id;

ALTER TABLE caiso_node_stats
  DROP CONSTRAINT IF EXISTS caiso_node_stats_node_year_month_key;
ALTER TABLE caiso_node_stats
  ADD CONSTRAINT caiso_node_stats_node_year_month_key UNIQUE (node, year, month);

CREATE INDEX IF NOT EXISTS caiso_node_stats_node_idx ON caiso_node_stats (node);
CREATE INDEX IF NOT EXISTS caiso_node_stats_type_idx ON caiso_node_stats (node_type);

COMMIT;

-- ── Step 2: aggregate every node, monthly ───────────────────────────────────
-- node_type is inferred from CAISO's naming convention:
--   TH_*      trading hub          (TH_SP15_GEN-APND)
--   DLAP_*    load aggregation pt  (DLAP_PGAE-APND)
--   *_7_*     etc. are PNodes; the digit is a voltage-level code
-- This is a HEURISTIC on names, not an authoritative registry. It is recorded
-- so the scorer can filter to genuine resource nodes rather than accidentally
-- averaging hubs and load points into a "node average".

BEGIN;

CREATE TEMP TABLE caiso_stats_stage AS
SELECT
  node_name AS node,
  CASE
    WHEN node_name LIKE 'TH\_%'      THEN 'hub'
    WHEN node_name LIKE 'DLAP\_%'    THEN 'load_zone'
    WHEN node_name IN ('NP15','SP15','ZP26') THEN 'hub'
    WHEN node_name ~ '_[0-9]_'       THEN 'resource_node'
    ELSE 'other'
  END AS node_type,
  EXTRACT(year  FROM hour)::int  AS year,
  EXTRACT(month FROM hour)::int  AS month,
  AVG(da_price)                                                   AS avg_da_price,
  AVG(rt_price)                                                   AS avg_rt_price,
  STDDEV_SAMP(da_price)                                           AS volatility,
  100.0 * COUNT(*) FILTER (WHERE da_price < 0) / NULLIF(COUNT(da_price), 0) AS neg_price_percent,
  -- CAISO on-peak: HE 7-22 Mon-Sat. Stored hour is hour-BEGINNING, so HE7..HE22
  -- is hour 6..21. EXTRACT(dow) 0=Sunday.
  AVG(da_price) FILTER (
    WHERE EXTRACT(hour FROM hour) BETWEEN 6 AND 21
      AND EXTRACT(dow  FROM hour) BETWEEN 1 AND 6
  ) AS on_peak_avg,
  AVG(da_price) FILTER (
    WHERE EXTRACT(hour FROM hour) NOT BETWEEN 6 AND 21
       OR EXTRACT(dow  FROM hour) = 0
  ) AS off_peak_avg,
  MIN(da_price) AS min_price,
  MAX(da_price) AS max_price,
  COUNT(da_price) AS hours_with_da
FROM caiso_nodal_da_rt_hourly
WHERE da_price IS NOT NULL
GROUP BY 1, 2, 3, 4;

\echo ''
\echo '=== Staged from caiso_nodal_da_rt_hourly ==='
SELECT node_type, COUNT(DISTINCT node) AS nodes, COUNT(*) AS node_months
FROM caiso_stats_stage GROUP BY node_type ORDER BY nodes DESC;

-- Drop node-months with too little data to be meaningful. A node with 40 hours
-- in a month produces a volatility figure that looks like every other one and
-- is not comparable — better absent than misleadingly present.
DELETE FROM caiso_stats_stage WHERE hours_with_da < 200;

INSERT INTO caiso_node_stats
  (node, node_type, year, month, avg_da_price, avg_rt_price, volatility,
   neg_price_percent, on_peak_avg, off_peak_avg, min_price, max_price)
SELECT node, node_type, year, month,
       ROUND(avg_da_price::numeric, 4),
       ROUND(avg_rt_price::numeric, 4),
       ROUND(volatility::numeric, 4),
       ROUND(neg_price_percent::numeric, 3),
       ROUND(on_peak_avg::numeric, 4),
       ROUND(off_peak_avg::numeric, 4),
       ROUND(min_price::numeric, 4),
       ROUND(max_price::numeric, 4)
FROM caiso_stats_stage
ON CONFLICT (node, year, month) DO UPDATE SET
  node_type         = EXCLUDED.node_type,
  avg_da_price      = EXCLUDED.avg_da_price,
  avg_rt_price      = EXCLUDED.avg_rt_price,
  volatility        = EXCLUDED.volatility,
  neg_price_percent = EXCLUDED.neg_price_percent,
  on_peak_avg       = EXCLUDED.on_peak_avg,
  off_peak_avg      = EXCLUDED.off_peak_avg,
  min_price         = EXCLUDED.min_price,
  max_price         = EXCLUDED.max_price;

COMMIT;

-- ── Step 3: verify ──────────────────────────────────────────────────────────

\echo ''
\echo '=== Coverage after build (was 3 nodes / 81 rows) ==='
SELECT node_type, COUNT(DISTINCT node) AS nodes, COUNT(*) AS node_months,
       MIN(year * 100 + month) AS first_ym, MAX(year * 100 + month) AS last_ym
FROM caiso_node_stats GROUP BY node_type ORDER BY nodes DESC;

\echo ''
\echo '=== SANITY: hub rows must still agree with the hub price table ==='
\echo 'Same node, same month, computed from two different tables. Small'
\echo 'differences are expected (nodal vs hub feed); large ones are not.'
SELECT s.node, s.year, s.month,
       ROUND(s.avg_da_price, 2) AS from_nodal,
       ROUND(AVG(h.da_price), 2) AS from_hub,
       ROUND(s.avg_da_price - AVG(h.da_price), 2) AS diff
FROM caiso_node_stats s
JOIN caiso_hub_da_rt_hourly h
  ON h.node = s.node AND h.year = s.year AND h.month = s.month
WHERE s.year = 2025 AND s.month = 7
GROUP BY s.node, s.year, s.month, s.avg_da_price
ORDER BY s.node;

\echo ''
\echo '=== Negative-price leaders — the Curtailment signal ==='
\echo 'Solar-heavy CAISO nodes should show materially higher neg_price_percent'
\echo 'than the hubs. If every node looks like the hub average, the aggregation'
\echo 'has collapsed and node-level scoring is still not real.'
SELECT node, node_type,
       ROUND(AVG(neg_price_percent), 2) AS avg_neg_pct,
       ROUND(AVG(avg_da_price), 2)      AS avg_da,
       COUNT(*) AS months
FROM caiso_node_stats
WHERE node_type = 'resource_node'
GROUP BY node, node_type
HAVING COUNT(*) >= 12
ORDER BY avg_neg_pct DESC LIMIT 15;

\echo ''
\echo '=== Spread across nodes — proof this is not 3 numbers repeated ==='
SELECT node_type,
       COUNT(DISTINCT node)                        AS nodes,
       ROUND(MIN(avg_da_price), 2)                 AS min_da,
       ROUND(AVG(avg_da_price), 2)                 AS mean_da,
       ROUND(MAX(avg_da_price), 2)                 AS max_da,
       ROUND(STDDEV_SAMP(avg_da_price), 2)         AS sd_da
FROM caiso_node_stats WHERE year = 2025
GROUP BY node_type ORDER BY nodes DESC;
