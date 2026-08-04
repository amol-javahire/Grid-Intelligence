-- ============================================================================
-- caiso_node_locations — with the provenance ercot_node_locations lacks.
--
-- WHY NOT JUST MIRROR ERCOT
--   ercot_node_locations stores a county centroid and a surveyed plant
--   coordinate in the SAME latitude column, distinguishable only by a
--   location_source string that nothing downstream reads. Of its 439 rows,
--   134 are county centroids — and Texas counties run 50-100km across. So a
--   +/-50km guess and a +/-50m fact are treated identically by the map and by
--   any "nearest node to this project" logic.
--
--   This table makes that distinction structural and unavoidable:
--     location_precision   how good is this coordinate, as an enum
--     location_method      how was it obtained
--     location_source      which dataset
--     location_confidence  0-1, for weighting or filtering
--
--   Consumers MUST check location_precision before using a coordinate for
--   distance work. 'county' and 'zone' are for display only.
--
-- SITE vs POINT OF INTERCONNECTION
--   These are two different places and the platform needs both distinctly:
--   basis risk keys off the POI (the settlement point), resource quality keys
--   off the SITE (where the panels are). Interconnection-queue coordinates are
--   POI or county-level, never parcel-level — public ISO queues do not publish
--   project-site coordinates. Conflating them is a real analytical error, so
--   poi_latitude/longitude are kept separate rather than overwritten.
--
-- Run:  psql "$DATABASE_URL" -f infra/2026-08-04-create-caiso-node-locations.sql
-- ============================================================================

\timing on

BEGIN;

CREATE TABLE IF NOT EXISTS caiso_node_locations (
  id                   BIGSERIAL PRIMARY KEY,
  node_name            TEXT NOT NULL UNIQUE,
  node_type            TEXT,

  -- Zone assignments. BOTH are approximations — see the seeder's notes.
  caiso_zone           TEXT,          -- NP15 / SP15 / ZP26  (price hub, lat bands)
  dlap                 TEXT,          -- PGAE / SCE / SDGE / VEA (load zone, nearest centroid)

  -- SITE — where the generator physically is.
  latitude             NUMERIC(9,6),
  longitude            NUMERIC(9,6),

  -- POINT OF INTERCONNECTION — the substation/settlement point. Distinct from
  -- the site and NOT interchangeable with it.
  poi_latitude         NUMERIC(9,6),
  poi_longitude        NUMERIC(9,6),

  -- Provenance. NOT NULL on precision so "we do not know" must be stated.
  location_precision   TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (location_precision IN
                         ('exact','facility','poi','city','county','zone','unknown')),
  location_method      TEXT,          -- imagery_verified | reported | name_match | centroid
  location_source      TEXT,          -- uspvdb | uswtdb | eia860_lmp | eia860_name | queue
  location_confidence  NUMERIC(3,2) CHECK (location_confidence BETWEEN 0 AND 1),
  match_score          NUMERIC(5,2),  -- fuzzy score where a name match was used

  -- Identity carried across from EIA-860.
  eia_plant_code       INTEGER,
  eia_plant_name       TEXT,
  technology           TEXT,

  -- Denormalised price summary, same as ercot_node_locations carries.
  avg_da_price         NUMERIC(10,4),
  months_available     INTEGER,

  source_date          DATE,
  created_at           TIMESTAMP NOT NULL DEFAULT now(),
  updated_at           TIMESTAMP NOT NULL DEFAULT now()
);

COMMENT ON TABLE caiso_node_locations IS
  'CAISO settlement point locations with explicit provenance. CHECK '
  'location_precision before any distance calculation: exact/facility are '
  'usable, county/zone are display-only. latitude/longitude are the SITE; '
  'poi_latitude/longitude are the interconnection point — different places.';

COMMENT ON COLUMN caiso_node_locations.location_precision IS
  'exact = imagery-verified array boundary or turbine position (USPVDB/USWTDB, ~10m). '
  'facility = EIA-860 reported plant coordinate. '
  'poi = interconnection substation, NOT the generator site. '
  'county/zone = centroid fallback, display only — never use for distance.';

COMMENT ON COLUMN caiso_node_locations.caiso_zone IS
  'APPROXIMATE. Derived from latitude bands standing in for Path 15 (~37.0N) '
  'and Path 26 (~35.0N). The real boundaries are electrical, not latitudinal.';

COMMENT ON COLUMN caiso_node_locations.dlap IS
  'APPROXIMATE. Nearest of the four DLAP load centres. CAISO does not publish '
  'DLAP boundary geometry; this is a Voronoi assignment, not a lookup.';

CREATE INDEX IF NOT EXISTS caiso_node_locations_latlon_idx
  ON caiso_node_locations (latitude, longitude);
CREATE INDEX IF NOT EXISTS caiso_node_locations_zone_idx
  ON caiso_node_locations (caiso_zone);
CREATE INDEX IF NOT EXISTS caiso_node_locations_dlap_idx
  ON caiso_node_locations (dlap);
CREATE INDEX IF NOT EXISTS caiso_node_locations_precision_idx
  ON caiso_node_locations (location_precision);

COMMIT;

\echo ''
\echo '=== Ready (0 rows until geo-locate-iso-nodes.py runs) ==='
SELECT COUNT(*) AS rows FROM caiso_node_locations;
