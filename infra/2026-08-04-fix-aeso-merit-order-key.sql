-- ============================================================================
-- aeso_merit_order: add the unique key its upsert has always assumed.
--
-- THE BUG
--   seed-aeso-real.ts does:
--     ON CONFLICT (date, hour_ending, asset_id, merit_order_rank) DO UPDATE
--   but the table only ever had a PK on id and a plain btree on
--   (date, hour_ending). Postgres rejects that with
--     42P10  there is no unique or exclusion constraint matching the
--            ON CONFLICT specification
--   so EVERY insert failed. A 365-day run fetched 37 MB successfully, failed
--   every write, and reported "MeritOrder total: 0 blocks / complete!" — the
--   failure was invisible because Drizzle's error message is "Failed query:"
--   followed by the whole SQL, burying the Postgres cause.
--
--   Identical to the caiso_node_stats problem found earlier the same day: an
--   upsert naming a key that was never created. Worth checking any other table
--   whose seeder uses ON CONFLICT with a composite target.
--
-- KEY CHOICE
--   (date, hour_ending, asset_id, merit_order_rank) — merit_order_rank holds
--   AESO's block_number, so this is "one row per block per asset per hour",
--   which is exactly the grain of the source data.
--
--   NULLS NOT DISTINCT matters here. Postgres treats NULLs as distinct in a
--   unique index by default, so a NULL rank would let unlimited duplicate rows
--   through for the same asset-hour and silently inflate the supply curve. The
--   seeder had a bug producing exactly that (`parseInt(...) || null` turns a
--   legitimate block_number of 0 into NULL), fixed alongside this, but the
--   constraint should not depend on the seeder being correct.
--
-- Run:  psql "$DATABASE_URL" -f infra/2026-08-04-fix-aeso-merit-order-key.sql
-- ============================================================================

\timing on

BEGIN;

-- Defensive: the table has never had a uniqueness guarantee, so assume nothing.
-- Keeps the most recently inserted row per key.
DELETE FROM aeso_merit_order a
USING aeso_merit_order b
WHERE a.date = b.date
  AND a.hour_ending = b.hour_ending
  AND a.asset_id IS NOT DISTINCT FROM b.asset_id
  AND a.merit_order_rank IS NOT DISTINCT FROM b.merit_order_rank
  AND a.id < b.id;

ALTER TABLE aeso_merit_order
  DROP CONSTRAINT IF EXISTS aeso_merit_order_block_uq;

ALTER TABLE aeso_merit_order
  ADD CONSTRAINT aeso_merit_order_block_uq
  UNIQUE NULLS NOT DISTINCT (date, hour_ending, asset_id, merit_order_rank);

-- aeso_generators.py groups by asset_id over a trailing date window; without
-- this it seq-scans what will become a ~2.5M row table on every OPF solve.
CREATE INDEX IF NOT EXISTS aeso_merit_order_asset_date_idx
  ON aeso_merit_order (asset_id, date);

-- The supply-curve query filters on price being present.
CREATE INDEX IF NOT EXISTS aeso_merit_order_price_idx
  ON aeso_merit_order (date, offer_price)
  WHERE offer_price IS NOT NULL;

COMMIT;

\echo ''
\echo '=== Constraints now present ==='
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid = 'aeso_merit_order'::regclass
ORDER BY conname;

\echo ''
\echo '=== Row count (0 expected until the seeder is re-run) ==='
SELECT COUNT(*) AS blocks FROM aeso_merit_order;
