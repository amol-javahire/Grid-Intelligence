-- ============================================================================
-- 2026-08-03 — Price-table rename + timezone/hour-convention reconciliation
--
-- THREE problems, all of which must land together or the app breaks.
--
-- (1) RENAME. The code sweep to *_da_rt_hourly was done in the repo but the
--     ALTER TABLEs never ran. \dt on 2026-08-03 still showed ercot_hub_hourly,
--     caiso_hub_hourly, ercot_node_prices, caiso_node_prices. Deployed code
--     and DB disagree; deploying the swept code breaks /nodal and /congestion.
--
-- (2) TIMEZONE. EIA-930 tables store UTC in a column named `hour`; ISO price
--     tables store market-local. Proven, not assumed — ERCOT solar peaks at
--     hour 19 and July load at hour 22 in the EIA tables (= 14:00 and 17:00
--     CDT), while HB_NORTH DA price peaks at hour 21 and SP15 at hour 20,
--     which are only coherent as local evening ramps. Under a UTC reading
--     SP15 would peak at 13:00 PDT, the bottom of the duck curve.
--
-- (3) HOUR CONVENTION — the part that a timezone column alone would have
--     missed. Measured 2026-08-03:
--
--       ercot_hub_hourly / caiso_hub_hourly ....... hour 1..24  HOUR-ENDING
--       ercot_node_prices / caiso_node_prices ..... hour 0..23  HOUR-BEGINNING
--       EIA-930 gen + load ........................ hour 0..23  HOUR-BEGINNING
--       aeso_hourly_pool_price .................... 1..24       HOUR-ENDING
--
--     The two ERCOT price tables are therefore OFF BY ONE FROM EACH OTHER.
--     Proof: for HB_NORTH July 2025 the hub table's top DA prices are
--     91/87/67/49 at hours 21/20/22/19; the nodal table returns the SAME four
--     values at hours 20/19/21/18. Identical data, labels one hour apart.
--     /ercot reads the hub table, /nodal and /congestion read the nodal table.
--
-- WHY CANONICAL VIEWS AND NOT JUST A REGISTRY
--   A registry documents the hazard but leaves every query to redo the
--   arithmetic — local-vs-UTC, plus HE-vs-HB, plus DST. That is three chances
--   to get it wrong at every call site. The views below expose a single
--   `ts_utc timestamptz` per table so joins happen on an unambiguous instant
--   and the conversion is written exactly once. Views cost no storage, which
--   also settles the "per-row time_zone column" question: that would have
--   stored the same string 32.6M times in ercot_nodal_da_rt_hourly alone.
--
-- Run:  psql "$DATABASE_URL" -f infra/2026-08-03-rename-price-tables-and-timezone.sql
-- ============================================================================

\timing on

BEGIN;

-- ── Part 1: renames (idempotent) ────────────────────────────────────────────
-- NOTE the hub and nodal tables have DIFFERENT SHAPES and are not
-- interchangeable despite the parallel names:
--   hub   = (node, year, month, day, hour int) + numeric prices
--   nodal = (node_name, hour timestamp)        + double precision prices
-- The canonical views in Part 3 are what makes them queryable alike.

ALTER TABLE IF EXISTS ercot_hub_hourly   RENAME TO ercot_hub_da_rt_hourly;
ALTER TABLE IF EXISTS caiso_hub_hourly   RENAME TO caiso_hub_da_rt_hourly;
ALTER TABLE IF EXISTS ercot_node_prices  RENAME TO ercot_nodal_da_rt_hourly;
ALTER TABLE IF EXISTS caiso_node_prices  RENAME TO caiso_nodal_da_rt_hourly;

-- Postgres does NOT rename indexes with the table. Leaving ercot_hub_hourly_pkey
-- attached to ercot_hub_da_rt_hourly is a trap for whoever reads \d next.
DO $$
DECLARE r RECORD; new_name TEXT;
BEGIN
  FOR r IN
    SELECT c.relname AS idx, t.relname AS tbl
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname IN ('ercot_hub_da_rt_hourly','caiso_hub_da_rt_hourly',
                        'ercot_nodal_da_rt_hourly','caiso_nodal_da_rt_hourly')
      AND (c.relname LIKE '%hub_hourly%' OR c.relname LIKE '%node_prices%')
  LOOP
    new_name := replace(replace(r.idx, 'hub_hourly', 'hub_da_rt_hourly'),
                        'node_prices', 'nodal_da_rt_hourly');
    IF new_name <> r.idx THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.idx, new_name);
    END IF;
  END LOOP;
END $$;

-- ercot_nodal had ONLY its composite pkey (node_name, hour). caiso_nodal has
-- separate hour and node indexes. Any ERCOT query filtering by time alone was
-- sequentially scanning 32.6M rows — the likely cause of /congestion latency.
CREATE INDEX IF NOT EXISTS ercot_nodal_da_rt_hourly_hour_idx
  ON ercot_nodal_da_rt_hourly (hour);
CREATE INDEX IF NOT EXISTS ercot_nodal_da_rt_hourly_node_idx
  ON ercot_nodal_da_rt_hourly (node_name);

COMMIT;


-- ── Part 2: registry ────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS iso_table_metadata (
  table_name       TEXT PRIMARY KEY,
  market           TEXT NOT NULL,
  hour_time_zone   TEXT NOT NULL,   -- zone the hour column is expressed in
  hour_convention  TEXT NOT NULL,   -- HE_1_24 | HB_0_23 | TIMESTAMPTZ
  time_shape       TEXT NOT NULL,   -- ymdh_int | naive_timestamp | date_he | timestamptz
  is_dst_aware     BOOLEAN NOT NULL,
  data_source      TEXT NOT NULL,
  is_real          BOOLEAN NOT NULL,
  canonical_view   TEXT,            -- view exposing ts_utc; USE THIS TO JOIN
  notes            TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE iso_table_metadata IS
  'Timezone / hour-convention / provenance registry for hourly market tables. '
  'NEVER join two hourly tables on (year,month,day,hour) or on a naive timestamp '
  'without checking here first: the tables use three different conventions and '
  'the two ERCOT price tables are off by one hour from each other. Prefer the '
  'canonical_view, which exposes ts_utc timestamptz.';

INSERT INTO iso_table_metadata
  (table_name, market, hour_time_zone, hour_convention, time_shape,
   is_dst_aware, data_source, is_real, canonical_view, notes)
VALUES
  -- EIA-930: UTC, hour-beginning 0..23. Confirmed by diurnal signature.
  ('ercot_hourly_gen_output_by_fuel_agg','ERCOT','UTC','HB_0_23','ymdh_int',FALSE,
   'EIA-930 fuel-type',TRUE,'v_ercot_gen_utc',
   'UTC confirmed: solar peaks hour 19 = 14:00 CDT. Only US market with a clean BAT->storage series.'),
  ('caiso_hourly_gen_output_by_fuel_agg','CAISO','UTC','HB_0_23','ymdh_int',FALSE,
   'EIA-930 fuel-type',TRUE,'v_caiso_gen_utc',
   'No BAT series for CISO; battery fleet falls in `other`, which is NET NEGATIVE (-221 MW avg). Will plot below axis on a stacked area chart.'),
  ('pjm_hourly_gen_output_by_fuel_agg','PJM','UTC','HB_0_23','ymdh_int',FALSE,
   'EIA-930 fuel-type',TRUE,'v_pjm_gen_utc',
   'No PS series; pumped storage sits in `other` (1,754 MW avg) mixed with genuine other.'),
  ('ercot_hourly_zonal_load','ERCOT','UTC','HB_0_23','ymdh_int',FALSE,
   'EIA-930 sub-BA',TRUE,'v_ercot_load_utc',
   '8 weather zones. UTC confirmed: July load peaks hour 22 = 17:00 CDT.'),
  ('caiso_hourly_zonal_load','CAISO','UTC','HB_0_23','ymdh_int',FALSE,
   'EIA-930 sub-BA',TRUE,'v_caiso_load_utc',
   '4 DLAPs PGAE/SCE/SDGE/VEA. These are NOT the price hubs NP15/SP15/ZP26 — different partitions by market design. Do not join on zone.'),
  ('pjm_hourly_zonal_load','PJM','UTC','HB_0_23','ymdh_int',FALSE,
   'EIA-930 sub-BA',TRUE,'v_pjm_load_utc',
   '20 zones using EIA codes, NOT PJM Data Miner codes. AE=AECO BC=BGE CE=COMED JC=JCPL ME=METED PE=PECO PEP=PEPCO PL=PPL PN=PENELEC PS=PSEG AP=APS.'),

  -- ISO hub price tables: market-local, HOUR-ENDING 1..24.
  ('ercot_hub_da_rt_hourly','ERCOT','America/Chicago','HE_1_24','ymdh_int',TRUE,
   'ERCOT CDR',TRUE,'v_ercot_hub_price_utc',
   'HOUR-ENDING 1..24 (measured). HE 21 = the 20:00-21:00 local interval. Off by one from ercot_nodal_da_rt_hourly.'),
  ('caiso_hub_da_rt_hourly','CAISO','America/Los_Angeles','HE_1_24','ymdh_int',TRUE,
   'CAISO OASIS',TRUE,'v_caiso_hub_price_utc',
   'HOUR-ENDING 1..24 (measured). Local confirmed: peak hour 20 = 20:00 PDT evening ramp; as UTC it would be 13:00 PDT, the duck-curve trough.'),

  -- ISO nodal price tables: market-local, HOUR-BEGINNING, naive timestamp.
  ('ercot_nodal_da_rt_hourly','ERCOT','America/Chicago','HB_0_23','naive_timestamp',TRUE,
   'ERCOT CDR',TRUE,'v_ercot_nodal_price_utc',
   'HOUR-BEGINNING as a NAIVE timestamp — carries no zone despite looking precise. Proven one hour behind the hub table: identical DA values 91/87/67/49 appear at hours 20/19/21/18 here vs 21/20/22/19 in the hub table.'),
  ('caiso_nodal_da_rt_hourly','CAISO','America/Los_Angeles','HB_0_23','naive_timestamp',TRUE,
   'CAISO OASIS',TRUE,'v_caiso_nodal_price_utc',
   'VERIFIED 2026-08-03: hour-beginning Pacific, one hour behind caiso_hub_da_rt_hourly. Identical DA values 54/53/49/47 appear at hours 19/20/21/18 here vs 20/21/22/19 in the hub table. '
   'NODE NAMING TRAP: stores full OASIS identifiers (TH_SP15_GEN-APND) while the hub table stores plain SP15 — joining the two on node name returns ZERO rows. '
   'Worse, ILIKE ''%SP15%'' also matches TH_SP15_GEN_ONPEAK-APND and TH_SP15_GEN_OFFPEAK-APND, which are SEPARATE products; a LIKE match triple-counts. Match exactly.'),

  -- Already unambiguous.
  ('ercot_hourly_dispatch','ERCOT','UTC','TIMESTAMPTZ','timestamptz',FALSE,
   'ERCOT 60-day SCED disclosure',TRUE,NULL,
   'hour is timestamptz — no ambiguity. Consumers convert AT TIME ZONE America/Chicago. 4.7GB; do not rename (touches mv_dispatch_monthly + PyPSA).'),

  -- AESO
  ('aeso_hourly_pool_price','AESO','America/Edmonton','HE_1_24','date_he',TRUE,
   'apimgw.aeso.ca',TRUE,'v_aeso_pool_price_utc',
   'date + hour_ending 1..24, explicitly named. ail_mw duplicated with aeso_supply_demand — consolidate.'),
  ('aeso_hourly_gen_output','AESO','America/Edmonton','HE_1_24','date_he',TRUE,
   'apimgw.aeso.ca',TRUE,NULL,
   'VERIFY shape before adding a canonical view.'),

  -- Known-bad
  ('iso_hourly_temps','MULTI','UNKNOWN','UNKNOWN','ymdh_int',TRUE,
   'Open-Meteo + synthetic fallbacks',FALSE,NULL,
   'MIXED real/synthetic with no source column AND unconfirmed timezone. Open-Meteo returns LOCAL time by default. Do not trust until rebuilt — task #24.')
ON CONFLICT (table_name) DO UPDATE SET
  market          = EXCLUDED.market,
  hour_time_zone  = EXCLUDED.hour_time_zone,
  hour_convention = EXCLUDED.hour_convention,
  time_shape      = EXCLUDED.time_shape,
  is_dst_aware    = EXCLUDED.is_dst_aware,
  data_source     = EXCLUDED.data_source,
  is_real         = EXCLUDED.is_real,
  canonical_view  = EXCLUDED.canonical_view,
  notes           = EXCLUDED.notes,
  updated_at      = now();

-- Mirror onto the tables so \d+ shows it at a psql prompt.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM iso_table_metadata LOOP
    IF to_regclass(r.table_name) IS NOT NULL THEN
      EXECUTE format('COMMENT ON TABLE %I IS %L', r.table_name,
        format('hour: %s %s | source: %s | real: %s | JOIN VIA: %s | see iso_table_metadata',
               r.hour_time_zone, r.hour_convention, r.data_source, r.is_real,
               COALESCE(r.canonical_view, 'n/a')));
    END IF;
  END LOOP;
END $$;

COMMIT;


-- ── Part 3: canonical views — ts_utc timestamptz ────────────────────────────
-- Every view exposes ts_utc, the true instant the row's interval BEGINS.
-- Join on ts_utc and the timezone, HE/HB and DST questions all disappear.
--
-- HE -> HB: hour-ending h covers the interval BEGINNING at h-1.
-- AT TIME ZONE on a naive timestamp interprets it IN that zone, yielding
-- timestamptz. On the autumn DST repeat Postgres resolves the ambiguous local
-- hour to the FIRST occurrence; ISO tables that publish an explicit 02*/DST
-- flag would need special handling, which none of ours currently carry.

CREATE OR REPLACE VIEW v_ercot_gen_utc AS
SELECT make_timestamp(year, month, day, hour, 0, 0) AT TIME ZONE 'UTC' AS ts_utc,
       fuel_type, gen_mw
FROM ercot_hourly_gen_output_by_fuel_agg;

CREATE OR REPLACE VIEW v_caiso_gen_utc AS
SELECT make_timestamp(year, month, day, hour, 0, 0) AT TIME ZONE 'UTC' AS ts_utc,
       fuel_type, gen_mw
FROM caiso_hourly_gen_output_by_fuel_agg;

CREATE OR REPLACE VIEW v_pjm_gen_utc AS
SELECT make_timestamp(year, month, day, hour, 0, 0) AT TIME ZONE 'UTC' AS ts_utc,
       fuel_type, gen_mw
FROM pjm_hourly_gen_output_by_fuel_agg;

CREATE OR REPLACE VIEW v_ercot_load_utc AS
SELECT make_timestamp(year, month, day, hour, 0, 0) AT TIME ZONE 'UTC' AS ts_utc,
       zone, load_mw
FROM ercot_hourly_zonal_load;

CREATE OR REPLACE VIEW v_caiso_load_utc AS
SELECT make_timestamp(year, month, day, hour, 0, 0) AT TIME ZONE 'UTC' AS ts_utc,
       zone, load_mw
FROM caiso_hourly_zonal_load;

CREATE OR REPLACE VIEW v_pjm_load_utc AS
SELECT make_timestamp(year, month, day, hour, 0, 0) AT TIME ZONE 'UTC' AS ts_utc,
       zone, load_mw
FROM pjm_hourly_zonal_load;

-- Hub tables: HOUR-ENDING 1..24 in market-local time. hour-1 gives the
-- interval start; hour 24 correctly becomes 23:00 on the same day.
CREATE OR REPLACE VIEW v_ercot_hub_price_utc AS
SELECT (make_timestamp(year, month, day, 0, 0, 0) + ((hour - 1) * INTERVAL '1 hour'))
         AT TIME ZONE 'America/Chicago' AS ts_utc,
       node, node_type, da_price, rt_price
FROM ercot_hub_da_rt_hourly;

CREATE OR REPLACE VIEW v_caiso_hub_price_utc AS
SELECT (make_timestamp(year, month, day, 0, 0, 0) + ((hour - 1) * INTERVAL '1 hour'))
         AT TIME ZONE 'America/Los_Angeles' AS ts_utc,
       node, node_type, da_price, rt_price
FROM caiso_hub_da_rt_hourly;

-- Nodal tables: naive local timestamp, already hour-beginning.
CREATE OR REPLACE VIEW v_ercot_nodal_price_utc AS
SELECT hour AT TIME ZONE 'America/Chicago' AS ts_utc,
       node_name, da_price, rt_price
FROM ercot_nodal_da_rt_hourly;

CREATE OR REPLACE VIEW v_caiso_nodal_price_utc AS
SELECT hour AT TIME ZONE 'America/Los_Angeles' AS ts_utc,
       node_name, da_price, rt_price
FROM caiso_nodal_da_rt_hourly;

-- AESO: date + hour_ending 1..24, Mountain.
CREATE OR REPLACE VIEW v_aeso_pool_price_utc AS
SELECT ((date::timestamp) + ((hour_ending - 1) * INTERVAL '1 hour'))
         AT TIME ZONE 'America/Edmonton' AS ts_utc,
       pool_price, forecast_pool_price, ail_mw, net_gen_mw
FROM aeso_hourly_pool_price;


-- ── Part 4: verification ────────────────────────────────────────────────────

\echo ''
\echo '=== Renamed tables present? (expect 4) ==='
SELECT tablename FROM pg_tables WHERE tablename LIKE '%_da_rt_hourly' ORDER BY 1;

\echo ''
\echo '=== Old names gone? (expect 0 rows) ==='
SELECT tablename FROM pg_tables
WHERE tablename IN ('ercot_hub_hourly','caiso_hub_hourly','ercot_node_prices','caiso_node_prices');

\echo ''
\echo '=== Registry ==='
SELECT market, table_name, hour_time_zone, hour_convention, canonical_view
FROM iso_table_metadata ORDER BY market, table_name;

\echo ''
\echo '=== PROOF 1: the two ERCOT price tables now AGREE ==='
\echo 'Same ts_utc must give the same DA price. Expect diff = 0 on every row.'
SELECT h.ts_utc,
       ROUND(h.da_price, 2)          AS hub_da,
       ROUND(n.da_price::numeric, 2) AS nodal_da,
       ROUND(h.da_price - n.da_price::numeric, 4) AS diff
FROM v_ercot_hub_price_utc h
JOIN v_ercot_nodal_price_utc n USING (ts_utc)
WHERE h.node = 'HB_NORTH' AND n.node_name = 'HB_NORTH'
  AND h.ts_utc >= '2025-07-01 06:00+00' AND h.ts_utc < '2025-07-02 06:00+00'
ORDER BY h.ts_utc;

\echo ''
\echo '=== PROOF 2: price vs generation align across the UTC boundary ==='
\echo 'Expect solar max ~13-14 local against cheap prices, price peak ~20-21'
\echo 'local on collapsed solar — same shape as the manual check, now via views.'
SELECT EXTRACT(hour FROM p.ts_utc AT TIME ZONE 'America/Chicago')::int AS local_hour,
       ROUND(AVG(p.da_price), 0)            AS da_price,
       ROUND(AVG(g.gen_mw)::numeric, 0)     AS solar_mw
FROM v_ercot_hub_price_utc p
JOIN v_ercot_gen_utc g ON g.ts_utc = p.ts_utc AND g.fuel_type = 'solar'
WHERE p.node = 'HB_NORTH'
  AND p.ts_utc >= '2025-07-01 05:00+00' AND p.ts_utc < '2025-08-01 05:00+00'
GROUP BY 1 ORDER BY 1;

\echo ''
\echo '=== PROOF 3: no hours lost (expect 24 distinct local hours, 744 rows) ==='
SELECT COUNT(*) AS joined_rows,
       COUNT(DISTINCT EXTRACT(hour FROM p.ts_utc AT TIME ZONE 'America/Chicago')) AS distinct_hours
FROM v_ercot_hub_price_utc p
JOIN v_ercot_gen_utc g ON g.ts_utc = p.ts_utc AND g.fuel_type = 'solar'
WHERE p.node = 'HB_NORTH'
  AND p.ts_utc >= '2025-07-01 05:00+00' AND p.ts_utc < '2025-08-01 05:00+00';

\echo ''
\echo '=== TODO: verify CAISO nodal vs hub the same way as PROOF 1 ==='
SELECT h.ts_utc, ROUND(h.da_price,2) AS hub_da, ROUND(n.da_price::numeric,2) AS nodal_da
FROM v_caiso_hub_price_utc h
JOIN v_caiso_nodal_price_utc n USING (ts_utc)
WHERE h.node = 'SP15' AND n.node_name = 'SP15'
  AND h.ts_utc >= '2025-07-01 07:00+00' AND h.ts_utc < '2025-07-02 07:00+00'
ORDER BY h.ts_utc LIMIT 24;
