-- ============================================================================
-- ############################  DO NOT RUN  ##################################
--
-- SUPERSEDED 2026-08-03. ercot_hourly_gen_output already holds REAL EIA-930
-- fuel-type data (seeded by scripts/src/seed-ercot-real-data.py). The premise
-- below — that the table was synthetic — was WRONG: it was based on reading a
-- deprecated seeder's header instead of querying the table. Verified real:
-- gas 21.9 GW, wind 13.7 GW, solar 8.1 GW, nuclear 4.7 GW, hydro 54 MW.
--
-- Running this script DESTROYS that data and replaces it with a SCED
-- aggregation that EXCLUDES behind-the-meter distributed solar — a strict
-- regression for a generation-mix view. It did exactly that once already:
-- the DELETE committed, the run was interrupted before the INSERT, and every
-- row from 2024-01 to 2026-05 was lost. Recovery was a full EIA-930 re-seed.
--
-- Two faults, both fixed below but recorded because they generalise:
--   1. DELETE and INSERT ran as separate autocommitting statements. They are
--      now wrapped in BEGIN/COMMIT so an interrupted run rolls back instead of
--      leaving the table empty.
--   2. The script trusted a seeder comment over the actual table contents.
--
-- Only useful for a DISPATCH-ONLY view, and only into a separate table.
-- If you genuinely want that, change the target table name first.
-- ############################################################################
--
-- Rebuild ercot_hourly_gen_output from REAL SCED data.
--
-- Aggregates ercot_hourly_dispatch (real ERCOT 60-day SCED disclosure,
-- per-resource, per-hour, ~4.7GB) by resource_type.
--
-- IMPORTANT CAVEAT — SCED is not the same population as ERCOT's published
-- fuel mix. SCED covers resources that participate in Security Constrained
-- Economic Dispatch. It excludes non-modelled distributed generation (notably
-- behind-the-meter rooftop solar) and any resource not dispatched by SCED.
-- Totals here will therefore run BELOW ERCOT's published system-wide fuel mix,
-- especially for solar. That is expected and correct for dispatch analysis —
-- do not "fix" it by scaling to match published totals without saying so.
--
-- Timezone: year/month/day/hour are derived in America/Chicago to match
-- mv_dispatch_monthly and the ERCOT dispatch routes.
--
-- Run:  psql "$DATABASE_URL" -f infra/rebuild-ercot-gen-output-from-sced.sql
-- ============================================================================

\timing on
SET work_mem = '512MB';
SET statement_timeout = 0;

-- ── Step 1: COVERAGE REPORT — read this before trusting the rebuild ─────────
-- SCED gap-fill was still in progress as of 2026-08. If real coverage does not
-- span the period you care about (Jan 2025 onward), the rebuild below will
-- leave holes where the synthetic data used to be. Check this output first.

\echo ''
\echo '=== SCED coverage by month (source for the rebuild) ==='
SELECT
  EXTRACT(year  FROM hour AT TIME ZONE 'America/Chicago')::int AS year,
  EXTRACT(month FROM hour AT TIME ZONE 'America/Chicago')::int AS month,
  COUNT(DISTINCT DATE(hour AT TIME ZONE 'America/Chicago'))    AS days_covered,
  COUNT(DISTINCT resource_name)                                 AS resources,
  COUNT(DISTINCT resource_type)                                 AS fuel_types,
  ROUND(SUM(avg_mw)::numeric / 1000, 1)                         AS total_gwh
FROM ercot_hourly_dispatch
GROUP BY 1, 2
ORDER BY 1, 2;

\echo ''
\echo '=== Existing (synthetic) gen output coverage, for comparison ==='
SELECT year, month,
       COUNT(DISTINCT day)       AS days_covered,
       COUNT(DISTINCT fuel_type) AS fuel_types,
       ROUND(SUM(gen_mw)/1000, 1) AS total_gwh
FROM ercot_hourly_gen_output
GROUP BY year, month
ORDER BY year, month;

-- ── Step 2: add a source column so real vs synthetic is never ambiguous ─────
-- The whole reason this rebuild was needed is that synthetic data sat in a
-- table whose name gave no hint it was fake. Never again: every row is now
-- explicitly labelled.

ALTER TABLE ercot_hourly_gen_output
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'synthetic';

COMMENT ON COLUMN ercot_hourly_gen_output.source IS
  'sced_real = aggregated from real ERCOT 60-day SCED disclosure (ercot_hourly_dispatch). '
  'synthetic = calibrated model profile from seed-ercot-load-fuelmix.ts. '
  'sced_real EXCLUDES behind-the-meter distributed generation.';

CREATE INDEX IF NOT EXISTS ercot_hourly_gen_output_source_idx
  ON ercot_hourly_gen_output (source);

-- ── Step 3: replace synthetic rows ONLY where real SCED data exists ─────────
-- Deliberately scoped: any month SCED does not cover keeps its synthetic rows
-- (still labelled 'synthetic') rather than becoming an empty hole. This makes
-- the rebuild safe to run repeatedly as SCED gap-filling progresses.

CREATE TEMP TABLE sced_gen_stack AS
SELECT
  EXTRACT(year  FROM hour AT TIME ZONE 'America/Chicago')::int AS year,
  EXTRACT(month FROM hour AT TIME ZONE 'America/Chicago')::int AS month,
  EXTRACT(day   FROM hour AT TIME ZONE 'America/Chicago')::int AS day,
  EXTRACT(hour  FROM hour AT TIME ZONE 'America/Chicago')::int AS hour,
  resource_type                                                 AS fuel_type,
  SUM(avg_mw)                                                   AS gen_mw
FROM ercot_hourly_dispatch
WHERE resource_type IS NOT NULL
  AND avg_mw IS NOT NULL
GROUP BY 1, 2, 3, 4, 5;

\echo ''
\echo '=== Rows staged from SCED ==='
SELECT COUNT(*) AS staged_rows,
       COUNT(DISTINCT (year, month)) AS months,
       MIN(year * 100 + month) AS first_ym,
       MAX(year * 100 + month) AS last_ym
FROM sced_gen_stack;

-- DELETE + INSERT MUST be atomic. Run separately, an interruption between
-- them leaves the table empty — which is exactly what happened on 2026-08-03,
-- destroying 2024-01 through 2026-05. BEGIN/COMMIT makes an interrupted run a
-- no-op instead of data loss.
BEGIN;

-- Drop existing rows only for (year, month) pairs SCED actually covers
DELETE FROM ercot_hourly_gen_output g
WHERE EXISTS (
  SELECT 1 FROM sced_gen_stack s
  WHERE s.year = g.year AND s.month = g.month
);

INSERT INTO ercot_hourly_gen_output (year, month, day, hour, fuel_type, gen_mw, source)
SELECT year, month, day, hour, fuel_type, ROUND(gen_mw::numeric, 2), 'sced_real'
FROM sced_gen_stack
ON CONFLICT (year, month, day, hour, fuel_type) DO UPDATE SET
  gen_mw = EXCLUDED.gen_mw,
  source = EXCLUDED.source;

-- Refuse to commit an empty table — a guard against the exact failure above.
DO $$
DECLARE n bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM ercot_hourly_gen_output;
  IF n = 0 THEN
    RAISE EXCEPTION 'ercot_hourly_gen_output would be left EMPTY — aborting';
  END IF;
END $$;

COMMIT;

-- ── Step 4: verify ──────────────────────────────────────────────────────────

\echo ''
\echo '=== Post-rebuild: rows by source ==='
SELECT source, COUNT(*) AS rows,
       MIN(year * 100 + month) AS first_ym,
       MAX(year * 100 + month) AS last_ym
FROM ercot_hourly_gen_output
GROUP BY source;

\echo ''
\echo '=== Fuel mix sanity, real rows only (share of total generation) ==='
\echo '(Expect gas largest, then wind. Solar will read LOW vs published ERCOT'
\echo ' figures because SCED excludes behind-the-meter rooftop.)'
SELECT fuel_type,
       ROUND(SUM(gen_mw)::numeric / 1000, 0) AS total_gwh,
       ROUND(100.0 * SUM(gen_mw) / SUM(SUM(gen_mw)) OVER (), 1) AS pct_of_total
FROM ercot_hourly_gen_output
WHERE source = 'sced_real'
GROUP BY fuel_type
ORDER BY total_gwh DESC;

\echo ''
\echo '=== Diurnal sanity: solar must peak midday, near zero overnight ==='
SELECT hour,
       ROUND(AVG(CASE WHEN fuel_type = 'solar' THEN gen_mw END)::numeric, 0) AS solar_avg_mw,
       ROUND(AVG(CASE WHEN fuel_type = 'wind'  THEN gen_mw END)::numeric, 0) AS wind_avg_mw,
       ROUND(AVG(CASE WHEN fuel_type = 'gas'   THEN gen_mw END)::numeric, 0) AS gas_avg_mw
FROM ercot_hourly_gen_output
WHERE source = 'sced_real'
GROUP BY hour
ORDER BY hour;
