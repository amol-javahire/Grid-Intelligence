-- ============================================================================
-- Rebuild iso_hourly_temps with provenance, coordinates and a KNOWN timezone.
--
-- WHY REBUILD RATHER THAN ALTER
--   The existing table cannot be trusted at all:
--     1. THREE seeders write to it — seed-temperatures.py (real Open-Meteo),
--        seed-temperatures-fast.py and seed-temperatures-completion.py. There
--        is no source column, so real and synthetic rows are indistinguishable.
--     2. The real seeder's stored timezone DEPENDS ON THE HOST THAT RAN IT.
--        It requests local time from Open-Meteo, asks for unixtime, then calls
--        datetime.fromtimestamp(ts) with no tz argument — which resolves using
--        the machine's own timezone. UTC on the Azure VM, Central on a laptop
--        in Texas. The data is not reproducible.
--     3. CAISO was seeded at NP15/SP15/ZP26 — the PRICE hubs. CAISO publishes
--        load at DLAPs (PGAE/SCE/SDGE/VEA). The temps therefore had no load
--        table to join to, which is the entire purpose of this table.
--     4. No PJM, no AESO.
--
-- CONVENTIONS FIXED HERE
--   hour is UTC, hour-beginning 0..23 — matching *_hourly_zonal_load so the
--   temperature/load regression joins directly with no conversion. Registered
--   in iso_table_metadata like every other hourly table.
--
--   Degree days are a LOCAL-CALENDAR concept, so iso_daily_degree_days rolls
--   up in market-local time, not UTC. A UTC rollup would mix the tail of one
--   local day into the next and shift every HDD/CDD figure.
--
--   source / method / latitude / longitude are NOT NULL from day one. A future
--   switch from single-centroid to load-weighted temperatures becomes an
--   UPDATE with method='load_weighted', not a migration and not a guess.
--
-- Run:  psql "$DATABASE_URL" -f infra/2026-08-03-rebuild-iso-hourly-temps.sql
-- ============================================================================

\timing on

BEGIN;

-- Keep the old rows out of the way rather than destroying them, in case some
-- consumer is silently depending on them. Drop the backup once the API is
-- confirmed reading the new table (see verification at the end).
DROP TABLE IF EXISTS iso_hourly_temps_pre_2026_08_03;
ALTER TABLE IF EXISTS iso_hourly_temps
  RENAME TO iso_hourly_temps_pre_2026_08_03;

CREATE TABLE iso_hourly_temps (
  id         BIGSERIAL PRIMARY KEY,
  iso        VARCHAR(10)  NOT NULL,
  zone       VARCHAR(20)  NOT NULL,
  year       SMALLINT     NOT NULL,
  month      SMALLINT     NOT NULL,
  day        SMALLINT     NOT NULL,
  hour       SMALLINT     NOT NULL,   -- UTC, hour-beginning 0..23
  temp_c     REAL         NOT NULL,
  temp_f     REAL         NOT NULL,
  latitude   REAL         NOT NULL,
  longitude  REAL         NOT NULL,
  source     TEXT         NOT NULL,   -- 'open_meteo_archive' | 'open_meteo_forecast' | 'synthetic'
  method     TEXT         NOT NULL,   -- 'single_centroid' | 'load_weighted'
  CONSTRAINT iso_hourly_temps_uniq UNIQUE (iso, zone, year, month, day, hour)
);

COMMENT ON TABLE iso_hourly_temps IS
  'hour: UTC HB_0_23 | source: Open-Meteo ERA5 archive | real: see source column | see iso_table_metadata';
COMMENT ON COLUMN iso_hourly_temps.hour IS
  'UTC, hour-beginning 0..23. Matches *_hourly_zonal_load exactly so the '
  'temperature/load regression joins on (year,month,day,hour) with no conversion.';
COMMENT ON COLUMN iso_hourly_temps.method IS
  'single_centroid = one representative point per zone, which is what the ISOs '
  'themselves publish. load_weighted would weight grid cells by load density — '
  'materially better only for large heterogeneous zones (ERCOT FWES/WEST, '
  'PJM AEP/DOM/AP, AESO regions) where the geographic centroid sits away from '
  'the population. Revisit if the regression R2 is poor for those zones '
  'specifically; do not switch on a hunch.';

CREATE INDEX iso_hourly_temps_zone_time_idx
  ON iso_hourly_temps (iso, zone, year, month, day, hour);
CREATE INDEX iso_hourly_temps_time_idx
  ON iso_hourly_temps (year, month, day, hour);

-- ── Derived daily degree days ───────────────────────────────────────────────
-- Populated by the seeder AFTER the hourly load, rolling up in LOCAL time.
CREATE TABLE IF NOT EXISTS iso_daily_degree_days (
  id           BIGSERIAL PRIMARY KEY,
  iso          VARCHAR(10) NOT NULL,
  zone         VARCHAR(20) NOT NULL,
  local_date   DATE        NOT NULL,   -- market-local calendar date
  time_zone    TEXT        NOT NULL,   -- zone used for the local rollup
  temp_c_avg   REAL        NOT NULL,
  temp_c_min   REAL        NOT NULL,
  temp_c_max   REAL        NOT NULL,
  hdd_c        REAL        NOT NULL,   -- max(0, 18.3 - temp_c_avg)
  cdd_c        REAL        NOT NULL,   -- max(0, temp_c_avg - 18.3)
  hdd_f        REAL        NOT NULL,   -- max(0, 65 - temp_f_avg)
  cdd_f        REAL        NOT NULL,   -- max(0, temp_f_avg - 65)
  hours_used   SMALLINT    NOT NULL,   -- 24 normally; 23 or 25 on DST days
  CONSTRAINT iso_daily_degree_days_uniq UNIQUE (iso, zone, local_date)
);

COMMENT ON TABLE iso_daily_degree_days IS
  'Degree days rolled up on the MARKET-LOCAL calendar (not UTC) because that is '
  'what a degree day means. hours_used exposes the 23/25-hour DST days rather '
  'than hiding them — an average over 23 hours is not wrong, but it is not 24.';

COMMIT;

-- ── Register the convention ─────────────────────────────────────────────────
INSERT INTO iso_table_metadata
  (table_name, market, hour_time_zone, hour_convention, time_shape,
   is_dst_aware, data_source, is_real, canonical_view, notes)
VALUES
  ('iso_hourly_temps','MULTI','UTC','HB_0_23','ymdh_int',FALSE,
   'Open-Meteo ERA5 archive',TRUE,'v_iso_temps_utc',
   'Rebuilt 2026-08-03. UTC by explicit request (timezone=UTC), parsed from ISO strings not unix epochs, so output no longer depends on the host machine. Zones match *_hourly_zonal_load exactly: ERCOT 8, CAISO 4 DLAPs, PJM 20, AESO 6 planning regions. source/method/lat/lon are NOT NULL.'),
  ('iso_daily_degree_days','MULTI','MARKET_LOCAL','DAILY','date_local',TRUE,
   'derived from iso_hourly_temps',TRUE,NULL,
   'Rolled up on the LOCAL calendar — degree days are a local concept. time_zone column records which zone was used. hours_used is 23 or 25 on DST transition days.'),
  ('iso_hourly_temps_pre_2026_08_03','MULTI','UNKNOWN','UNKNOWN','ymdh_int',TRUE,
   'mixed Open-Meteo + synthetic',FALSE,NULL,
   'ARCHIVED. Host-dependent timezone, no source column, CAISO seeded at price hubs with no matching load table. Retained only until consumers are confirmed off it, then DROP.')
ON CONFLICT (table_name) DO UPDATE SET
  hour_time_zone  = EXCLUDED.hour_time_zone,
  hour_convention = EXCLUDED.hour_convention,
  time_shape      = EXCLUDED.time_shape,
  is_dst_aware    = EXCLUDED.is_dst_aware,
  data_source     = EXCLUDED.data_source,
  is_real         = EXCLUDED.is_real,
  canonical_view  = EXCLUDED.canonical_view,
  notes           = EXCLUDED.notes,
  updated_at      = now();

CREATE OR REPLACE VIEW v_iso_temps_utc AS
SELECT make_timestamp(year, month, day, hour, 0, 0) AT TIME ZONE 'UTC' AS ts_utc,
       iso, zone, temp_c, temp_f, latitude, longitude, source, method
FROM iso_hourly_temps;

\echo ''
\echo '=== New table ready (0 rows until the seeder runs) ==='
SELECT COUNT(*) AS new_rows FROM iso_hourly_temps;
SELECT COUNT(*) AS archived_rows FROM iso_hourly_temps_pre_2026_08_03;
