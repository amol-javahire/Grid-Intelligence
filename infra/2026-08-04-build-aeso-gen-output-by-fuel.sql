-- ============================================================================
-- aeso_hourly_gen_output_by_fuel_agg — AESO's by-fuel hourly series, built from
-- aeso_metered_volume so it matches the other three markets.
--
-- WHY
--   ERCOT/CAISO/PJM each have {market}_hourly_gen_output_by_fuel_agg in LONG
--   form (fuel_type, gen_mw) from EIA-930. AESO had no equivalent: the table
--   aeso_hourly_gen_output exists but is WIDE (gas_mw, wind_mw, ...), has NO
--   WRITER anywhere in the repo, has never held a row, and was documented in
--   CLAUDE.md as "live, Jan 2024+". Any code that loops over markets breaks on
--   both the shape difference and the emptiness.
--
--   aeso_metered_volume already carries fuel_type per asset per hour, so this
--   is a GROUP BY — no API call, no new data.
--
-- LEVEL DIFFERENCE, deliberate and worth knowing
--   ERCOT/CAISO/PJM by-fuel tables come from EIA-930, which reports SYSTEM
--   generation including some behind-the-meter. AESO's comes from METERED
--   VOLUME, which is net-to-grid per settled asset. Cogeneration in particular
--   reads LOW here because most of its output is consumed behind the fence.
--   These are not the same measurement and should not be compared across
--   markets without saying so. Recorded in iso_table_metadata.
--
-- SIZE: ~8,700 hours x ~8 fuels = ~70k rows. Negligible.
--
-- Run:  psql "$DATABASE_URL" -f infra/2026-08-04-build-aeso-gen-output-by-fuel.sql
-- ============================================================================

\timing on

\echo ''
\echo '=== STEP 0a: aeso_metered_volume.fuel_type is NULL — verify ==='
\echo 'The column exists and is even indexed, but AESO meteredvolume does not'
\echo 'return fuel type, so every row inserts NULL. A first attempt at this'
\echo 'aggregation put all 7,487 hours into "unknown" for exactly that reason.'
\echo 'Column existence is not column contents — check before joining on it.'
SELECT COUNT(*) AS rows,
       COUNT(fuel_type) AS with_fuel_type,
       COUNT(asset_class) AS with_asset_class
FROM aeso_metered_volume;

\echo ''
\echo '=== STEP 0b: the registry is the fuel source — what does it emit? ==='
\echo 'Any value here NOT in the CASE below is kept verbatim as UNMAPPED:, not'
\echo 'folded into "other". ERCOT shipped a resource_type map keyed on words'
\echo 'ERCOT never emits and everything silently became "other" for a year.'
SELECT fuel_type, sub_fuel_type,
       COUNT(*) assets,
       ROUND(SUM(max_capability_mw)::numeric) total_mw
FROM aeso_asset_registry
GROUP BY fuel_type, sub_fuel_type
ORDER BY total_mw DESC NULLS LAST;

BEGIN;

CREATE TABLE IF NOT EXISTS aeso_hourly_gen_output_by_fuel_agg (
  id          BIGSERIAL PRIMARY KEY,
  date        DATE     NOT NULL,
  hour_ending SMALLINT NOT NULL,
  fuel_type   TEXT     NOT NULL,
  gen_mw      NUMERIC(12,2) NOT NULL,
  assets      SMALLINT,
  source      TEXT     NOT NULL DEFAULT 'aeso_metered_volume',
  CONSTRAINT aeso_gen_by_fuel_uniq UNIQUE (date, hour_ending, fuel_type)
);

COMMENT ON TABLE aeso_hourly_gen_output_by_fuel_agg IS
  'hour: America/Edmonton HE_1_24 | source: aggregated from aeso_metered_volume '
  '(net-to-grid per settled asset, NOT system generation like the EIA-930 '
  'tables for ERCOT/CAISO/PJM) | cogeneration reads low: most output is '
  'consumed behind the fence | see iso_table_metadata';

CREATE INDEX IF NOT EXISTS aeso_gen_by_fuel_time_idx
  ON aeso_hourly_gen_output_by_fuel_agg (date, hour_ending);
CREATE INDEX IF NOT EXISTS aeso_gen_by_fuel_fuel_idx
  ON aeso_hourly_gen_output_by_fuel_agg (fuel_type);

-- Normalise AESO's fuel labels onto the same vocabulary the other three
-- markets use, so a cross-market query is a filter and not a translation.
-- Unmapped values are kept VERBATIM with an 'UNMAPPED:' prefix rather than
-- folded into 'other' — the whole point is that they show up in the
-- verification query below instead of disappearing.
-- FULL REBUILD — clear first, inside this transaction.
--
-- Without this, re-running accumulates stale buckets: an earlier pass wrote
-- UNMAPPED:COMBINED CYCLE / UNMAPPED:COGENERATION, the next pass wrote the same
-- MWh as natural_gas, and ON CONFLICT only touches matching keys — so both
-- survived and gas was counted twice (+38.6M MWh, rows 67,383 -> 89,844).
--
-- DELETE and INSERT are in ONE transaction deliberately. infra/rebuild-ercot-
-- gen-output-from-sced.sql ran them as separate autocommitting statements, was
-- interrupted between the two, and destroyed 2024-01 through 2026-05. An
-- interrupted run here rolls back to a no-op instead.
DELETE FROM aeso_hourly_gen_output_by_fuel_agg;

-- Fuel comes from the REGISTRY, joined on asset_id — mv.fuel_type is NULL for
-- every row (AESO's meteredvolume endpoint does not return it, and the
-- seeder's ON CONFLICT only refreshes metered_mw, so a re-seed would not fix
-- it either). Assets present in metered volume but absent from the registry
-- become 'unregistered' rather than silently vanishing from the totals.
INSERT INTO aeso_hourly_gen_output_by_fuel_agg
  (date, hour_ending, fuel_type, gen_mw, assets)
SELECT mv.date, mv.hour_ending,
       -- The registry's fuel_type is finer than the cross-market vocabulary:
       -- it names the GAS TECHNOLOGY (COMBINED CYCLE / COGENERATION / SIMPLE
       -- CYCLE / GAS FIRED STEAM) rather than the fuel. All four collapse to
       -- natural_gas here so this table matches ERCOT/CAISO/PJM. The technology
       -- distinction is NOT lost — aeso_generators.py reads the registry
       -- directly and maps them to ccgt / cogen / scgt carriers for the OPF.
       CASE UPPER(TRIM(COALESCE(ar.fuel_type, '')))
         WHEN 'GAS'              THEN 'natural_gas'
         WHEN 'NATURAL GAS'      THEN 'natural_gas'
         WHEN 'COMBINED CYCLE'   THEN 'natural_gas'
         WHEN 'COGENERATION'     THEN 'natural_gas'
         WHEN 'SIMPLE CYCLE'     THEN 'natural_gas'
         WHEN 'GAS FIRED STEAM'  THEN 'natural_gas'
         WHEN 'COAL'             THEN 'coal'
         WHEN 'WIND'             THEN 'wind'
         WHEN 'SOLAR'            THEN 'solar'
         WHEN 'HYDRO'            THEN 'hydro'
         WHEN 'ENERGY STORAGE'   THEN 'storage'
         WHEN 'STORAGE'          THEN 'storage'
         WHEN 'DUAL FUEL'        THEN 'dual_fuel'
         WHEN 'BIOMASS AND OTHER' THEN 'biomass'
         WHEN 'OTHER'            THEN 'other'
         -- No fuel_type. Split by sub_fuel_type, which is AESO's own
         -- SOURCE/SINK discriminator (verified 2026-08-04: 2,331 SINK assets
         -- with zero fuel types, 1,397 SOURCE of which only 230 are classified
         -- — those 230 total 23,393 MW, matching Alberta's installed fleet).
         --
         -- Metered volume covers LOAD as well as generation, so most of the
         -- 2,068 metered assets are demand. Bucketing them explicitly is what
         -- makes the totals reconcile; an earlier version deleted them as
         -- "unknown" and silently dropped 62.5M MWh.
         WHEN ''                 THEN
           CASE WHEN ar.asset_id IS NULL                    THEN 'unregistered'
                WHEN UPPER(TRIM(ar.sub_fuel_type)) = 'SINK' THEN 'load'
                WHEN UPPER(TRIM(ar.sub_fuel_type)) = 'SOURCE'
                                                            THEN 'generation_unclassified'
                ELSE 'non_generation' END
         ELSE 'UNMAPPED:' || UPPER(TRIM(ar.fuel_type))
       END,
       ROUND(SUM(mv.metered_mw)::numeric, 2),
       COUNT(DISTINCT mv.asset_id)
FROM aeso_metered_volume mv
LEFT JOIN aeso_asset_registry ar ON ar.asset_id = mv.asset_id
WHERE mv.metered_mw IS NOT NULL
GROUP BY mv.date, mv.hour_ending, 3
ON CONFLICT (date, hour_ending, fuel_type) DO UPDATE SET
  gen_mw = EXCLUDED.gen_mw,
  assets = EXCLUDED.assets;

-- Refuse to commit an empty or short table. Guards against a source table that
-- has been truncated upstream turning this rebuild into a silent wipe.
DO $$
DECLARE n bigint; src bigint;
BEGIN
  SELECT COUNT(*) INTO n   FROM aeso_hourly_gen_output_by_fuel_agg;
  SELECT COUNT(*) INTO src FROM aeso_metered_volume WHERE metered_mw IS NOT NULL;
  IF n = 0 AND src > 0 THEN
    RAISE EXCEPTION 'Rebuild produced 0 rows from % source rows — aborting', src;
  END IF;
END $$;

COMMIT;

-- Register the convention alongside every other hourly table.
INSERT INTO iso_table_metadata
  (table_name, market, hour_time_zone, hour_convention, time_shape,
   is_dst_aware, data_source, is_real, canonical_view, notes)
VALUES
  ('aeso_hourly_gen_output_by_fuel_agg','AESO','America/Edmonton','HE_1_24',
   'date_he',TRUE,'aggregated from aeso_metered_volume',TRUE,NULL,
   'Built 2026-08-04 by GROUP BY on aeso_metered_volume, which already carries fuel_type. NOT equivalent to the EIA-930 by-fuel tables for ERCOT/CAISO/PJM: this is NET-TO-GRID metered volume per settled asset, those are SYSTEM generation. Cogeneration reads low because most of its output never reaches the grid. Do not compare levels across markets without stating this.'),
  ('aeso_hourly_gen_output','AESO','UNKNOWN','UNKNOWN','date_he',TRUE,
   'none — orphan table',FALSE,NULL,
   'ORPHAN. Wide shape (gas_mw/wind_mw/...), NO WRITER anywhere in the repo, never held a row, and was wrongly documented as live in CLAUDE.md. Superseded by aeso_hourly_gen_output_by_fuel_agg. DROP once nothing references it.')
ON CONFLICT (table_name) DO UPDATE SET
  hour_time_zone = EXCLUDED.hour_time_zone, hour_convention = EXCLUDED.hour_convention,
  time_shape = EXCLUDED.time_shape, data_source = EXCLUDED.data_source,
  is_real = EXCLUDED.is_real, notes = EXCLUDED.notes, updated_at = now();

-- ── Verification ────────────────────────────────────────────────────────────

\echo ''
\echo '=== 1. UNMAPPED / unregistered fuel — must return ZERO rows ==='
\echo 'UNMAPPED: = a registry fuel label the CASE does not know, add it.'
\echo 'unregistered = assets metering volume with no registry entry, which'
\echo 'means the asset list is stale or incomplete — worth chasing, not hiding.'
SELECT fuel_type, COUNT(*) rows, ROUND(AVG(gen_mw),1) avg_mw,
       ROUND(AVG(assets)) avg_assets
FROM aeso_hourly_gen_output_by_fuel_agg
WHERE fuel_type LIKE 'UNMAPPED:%' OR fuel_type IN ('unregistered','unknown')
GROUP BY 1 ORDER BY rows DESC;

\echo ''
\echo '=== 2. Coverage and average output by fuel ==='
SELECT fuel_type, COUNT(*) hours, ROUND(AVG(gen_mw)) avg_mw,
       ROUND(MAX(gen_mw)) peak_mw, ROUND(AVG(assets)) avg_assets
FROM aeso_hourly_gen_output_by_fuel_agg
GROUP BY fuel_type ORDER BY avg_mw DESC;

\echo ''
\echo '=== 3. Diurnal sanity — solar must peak midday LOCAL, wind flatter ==='
\echo 'hour_ending is Mountain time here (NOT UTC like the EIA-930 tables),'
\echo 'so solar should peak around HE 13-15, not HE 19-21.'
SELECT hour_ending,
       ROUND(AVG(gen_mw) FILTER (WHERE fuel_type='solar')) solar,
       ROUND(AVG(gen_mw) FILTER (WHERE fuel_type='wind'))  wind,
       ROUND(AVG(gen_mw) FILTER (WHERE fuel_type='natural_gas')) gas
FROM aeso_hourly_gen_output_by_fuel_agg
GROUP BY hour_ending ORDER BY hour_ending;

\echo ''
\echo '=== 4. Totals reconcile against the source? (difference must be 0) ==='
\echo 'ALL metered volume is kept — generation fuels PLUS load PLUS'
\echo 'unclassified. Nothing is filtered out, so these must match exactly.'
SELECT ROUND(SUM(a.gen_mw)) AS agg_total,
       (SELECT ROUND(SUM(metered_mw)) FROM aeso_metered_volume WHERE metered_mw IS NOT NULL) AS source_total,
       ROUND(SUM(a.gen_mw)) -
       (SELECT ROUND(SUM(metered_mw)) FROM aeso_metered_volume WHERE metered_mw IS NOT NULL) AS difference
FROM aeso_hourly_gen_output_by_fuel_agg a;

\echo ''
\echo '=== 4b. Generation only — what a fuel-mix chart should show ==='
\echo 'Excludes load / unclassified / unregistered. This is the number to'
\echo 'compare against AESO published generation, NOT the reconciliation above.'
SELECT fuel_type, ROUND(AVG(gen_mw)) avg_mw,
       ROUND(100.0 * SUM(gen_mw) / SUM(SUM(gen_mw)) OVER (), 1) AS pct_of_gen
FROM aeso_hourly_gen_output_by_fuel_agg
WHERE fuel_type NOT IN ('load','generation_unclassified','unregistered','non_generation')
  AND fuel_type NOT LIKE 'UNMAPPED:%'
GROUP BY fuel_type ORDER BY avg_mw DESC;

\echo ''
\echo '=== 5. Size ==='
SELECT pg_size_pretty(pg_total_relation_size('aeso_hourly_gen_output_by_fuel_agg')) AS size,
       COUNT(*) AS rows FROM aeso_hourly_gen_output_by_fuel_agg;
