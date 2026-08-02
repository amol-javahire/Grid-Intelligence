-- ============================================================================
-- Rebuild ercot_hourly_gen_output from REAL SCED data.
--
-- WHY: ercot_hourly_gen_output (formerly ercot_fuel_mix) was seeded by
-- scripts/src/seed-ercot-load-fuelmix.ts with CALIBRATED SYNTHETIC profiles —
-- its own header says "Replace this seed with ERCOT CDR ... when doclookupIds
-- are available". Meanwhile ercot_hourly_dispatch now holds real ERCOT 60-day
-- SCED disclosure data (per-resource, per-hour, ~4.7GB) with resource_type
-- already normalised to wind/solar/gas/coal/nuclear/hydro/storage/other.
-- Aggregating SCED by resource_type gives a genuinely real gen stack, so the
-- synthetic table no longer needs to exist for the covered period.
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

-- Drop synthetic rows only for (year, month) pairs SCED actually covers
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
