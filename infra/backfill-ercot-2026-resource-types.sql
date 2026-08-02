-- ============================================================================
-- Repair 2026 resource_type values in ercot_hourly_dispatch.
--
-- BACKGROUND: infra/seed-sced-gap.py shipped with a RESOURCE_TYPE_MAP keyed on
-- generic words ("SOLAR", "GAS", "COAL", "NUCLEAR", "STORAGE") that ERCOT never
-- emits. ERCOT's real codes are PVGR, CCGT90, CLLIG, NUC, PWRSTR, etc. Only
-- WIND and HYDRO matched literally, so every other 2026 resource was written as
-- 'other' — 896 resources / 122,069 GWh in one bucket, vs 8 correct fuel types
-- in 2024–2025 (seeded by scripts/src/seed-ercot-dispatch.py, which has the
-- correct map). The seeder is now fixed; this repairs the rows already stored.
--
-- WHY NOT JUST RE-SEED: the raw ERCOT code is not retained in the table — it was
-- collapsed to 'other' on insert — so it cannot be recovered from what's stored.
-- Re-seeding means re-downloading ~150 days of SCED ZIPs. Instead, a generator
-- that ran in both 2025 and 2026 is the SAME physical unit with the same fuel,
-- so its 2025 resource_type can be carried forward by resource_name.
--
-- LIMITATION: resources that appear ONLY in 2026 (new units commissioned since
-- Jan 2026) have no 2025 row to learn from and will stay 'other'. Step 4 reports
-- exactly which those are and how much MW they carry, so you can decide whether
-- a targeted re-seed is worth it. Expect a modest number — genuinely new units.
--
-- Safe to re-run. Only touches rows currently marked 'other'.
--
-- Run:  psql "$DATABASE_URL" -f infra/backfill-ercot-2026-resource-types.sql
-- ============================================================================

\timing on
SET work_mem = '512MB';
SET statement_timeout = 0;

\echo ''
\echo '=== 1. BEFORE: resource_type distribution from 2026-01 onward ==='
SELECT resource_type,
       COUNT(DISTINCT resource_name) AS resources,
       ROUND(SUM(avg_mw)::numeric / 1000, 0) AS gwh
FROM ercot_hourly_dispatch
WHERE hour >= '2026-01-01'
GROUP BY resource_type
ORDER BY gwh DESC;

-- ── 2. Learn resource_name → resource_type from the KNOWN-GOOD period ───────
-- 2024-01 .. 2025-12 was seeded by seed-ercot-dispatch.py with the correct map.
-- Take each resource's most frequently recorded non-'other' type (mode), so a
-- stray mislabelled row can't outvote thousands of correct ones.

DROP TABLE IF EXISTS resource_type_lookup;
CREATE TEMP TABLE resource_type_lookup AS
WITH ranked AS (
  SELECT resource_name,
         resource_type,
         COUNT(*) AS n,
         ROW_NUMBER() OVER (PARTITION BY resource_name ORDER BY COUNT(*) DESC) AS rn
  FROM ercot_hourly_dispatch
  WHERE hour >= '2024-01-01'
    AND hour <  '2026-01-01'
    AND resource_type IS NOT NULL
    AND resource_type <> 'other'
  GROUP BY resource_name, resource_type
)
SELECT resource_name, resource_type, n AS observations
FROM ranked
WHERE rn = 1;

CREATE INDEX ON resource_type_lookup (resource_name);

\echo ''
\echo '=== 2. Lookup built from 2024-2025 (known-good period) ==='
SELECT resource_type, COUNT(*) AS resources
FROM resource_type_lookup
GROUP BY resource_type
ORDER BY resources DESC;

-- ── 3. Apply to 2026 rows currently sitting in 'other' ─────────────────────

UPDATE ercot_hourly_dispatch d
SET resource_type = l.resource_type
FROM resource_type_lookup l
WHERE d.resource_name = l.resource_name
  AND d.hour >= '2026-01-01'
  AND d.resource_type = 'other';

-- ── 4. What could NOT be repaired ───────────────────────────────────────────
-- Resources with no 2024-2025 history. Genuinely new units, or renamed ones.
-- If any single entry here carries large MW, it's worth re-seeding its dates
-- with the now-fixed seeder rather than leaving it as 'other'.

\echo ''
\echo '=== 4. Still unresolved: 2026-only resources, top 30 by MW ==='
SELECT d.resource_name,
       COUNT(*) AS hours,
       ROUND(SUM(d.avg_mw)::numeric / 1000, 1) AS gwh,
       ROUND(MAX(d.hsl)::numeric, 1) AS max_hsl_mw
FROM ercot_hourly_dispatch d
WHERE d.hour >= '2026-01-01'
  AND d.resource_type = 'other'
  AND NOT EXISTS (SELECT 1 FROM resource_type_lookup l WHERE l.resource_name = d.resource_name)
GROUP BY d.resource_name
ORDER BY gwh DESC
LIMIT 30;

\echo ''
\echo '=== 5. AFTER: 2026 distribution (compare against step 1) ==='
SELECT resource_type,
       COUNT(DISTINCT resource_name) AS resources,
       ROUND(SUM(avg_mw)::numeric / 1000, 0) AS gwh
FROM ercot_hourly_dispatch
WHERE hour >= '2026-01-01'
GROUP BY resource_type
ORDER BY gwh DESC;

\echo ''
\echo '=== 6. Cross-year consistency: fuel share by year ==='
\echo '(2026 shares should now look broadly like 2025. Solar will be seasonally'
\echo ' lower in Jan-May, and 2026 is a partial year, so expect drift not identity.)'
SELECT EXTRACT(year FROM hour AT TIME ZONE 'America/Chicago')::int AS year,
       resource_type,
       ROUND(100.0 * SUM(avg_mw) / SUM(SUM(avg_mw)) OVER (
         PARTITION BY EXTRACT(year FROM hour AT TIME ZONE 'America/Chicago')::int
       ), 1) AS pct_of_year
FROM ercot_hourly_dispatch
WHERE hour >= '2025-01-01'
GROUP BY 1, resource_type
ORDER BY 1, pct_of_year DESC;
