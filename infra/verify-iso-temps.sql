-- ============================================================================
-- Verify iso_hourly_temps + iso_daily_degree_days after seeding.
--
-- The point of these checks is that each one would FAIL LOUDLY on the specific
-- mistakes that have already happened in this project, rather than confirming
-- that rows exist. Row counts have twice looked healthy while the data was
-- wrong (synthetic-vs-real, and the UTC/local mixups).
--
-- Run:  psql "$DATABASE_URL" -f infra/verify-iso-temps.sql
-- ============================================================================

\echo ''
\echo '=== 1. Coverage: 38 zones expected (ERCOT 8, CAISO 4, PJM 20, AESO 6) ==='
SELECT iso, COUNT(DISTINCT zone) AS zones, COUNT(*) AS rows,
       MIN(make_date(year, month, day)) AS first_day,
       MAX(make_date(year, month, day)) AS last_day
FROM iso_hourly_temps GROUP BY iso ORDER BY iso;

\echo ''
\echo '=== 2. Provenance is recorded (no NULLs, no surprise sources) ==='
SELECT source, method, COUNT(*) AS rows FROM iso_hourly_temps
GROUP BY source, method ORDER BY rows DESC;

\echo ''
\echo '=== 3. TIMEZONE PROOF — hour must be UTC, not local ==='
\echo 'Warmest hour of the day, July, per market. If hour is UTC the peak sits'
\echo 'at local-afternoon-plus-offset: ERCOT ~19, CAISO ~21, PJM ~18, AESO ~20.'
\echo 'A peak at hour 14 means local time leaked in and the seed is WRONG.'
SELECT t.iso, t.hour AS utc_hour, ROUND(AVG(t.temp_c)::numeric, 1) AS avg_c
FROM iso_hourly_temps t
WHERE t.month = 7
GROUP BY t.iso, t.hour
HAVING AVG(t.temp_c) = (
  SELECT MAX(x.m) FROM (
    SELECT AVG(temp_c) AS m FROM iso_hourly_temps
    WHERE month = 7 AND iso = t.iso GROUP BY hour
  ) x
)
ORDER BY t.iso;

\echo ''
\echo '=== 4. Zone codes MATCH the load tables (empty result = good) ==='
\echo 'Any row here is a temperature zone with no load zone to join to —'
\echo 'exactly the CAISO NP15/SP15/ZP26 mistake the old seeder made.'
SELECT 'ERCOT' AS iso, t.zone AS orphan_zone FROM (SELECT DISTINCT zone FROM iso_hourly_temps WHERE iso='ERCOT') t
  LEFT JOIN (SELECT DISTINCT zone FROM ercot_hourly_zonal_load) l USING (zone) WHERE l.zone IS NULL
UNION ALL
SELECT 'CAISO', t.zone FROM (SELECT DISTINCT zone FROM iso_hourly_temps WHERE iso='CAISO') t
  LEFT JOIN (SELECT DISTINCT zone FROM caiso_hourly_zonal_load) l USING (zone) WHERE l.zone IS NULL
UNION ALL
SELECT 'PJM', t.zone FROM (SELECT DISTINCT zone FROM iso_hourly_temps WHERE iso='PJM') t
  LEFT JOIN (SELECT DISTINCT zone FROM pjm_hourly_zonal_load) l USING (zone) WHERE l.zone IS NULL;

\echo ''
\echo '=== 5. THE ACTUAL TEST — does temperature explain load? ==='
\echo ''
\echo 'READ THIS BEFORE REACTING TO A NEGATIVE NUMBER.'
\echo 'Checks 5-7 pool ALL 24 hours, which is only valid where a market''s load'
\echo 'and temperature peaks are roughly in phase. ERCOT and PJM are; CAISO is'
\echo 'not. On 2026-08-03 this query returned SDGE r=-0.455 and triggered a hunt'
\echo 'for a bad centroid that did not exist — seven different San Diego'
\echo 'coordinates all returned -0.45 to -0.50.'
\echo ''
\echo 'It is Simpson''s paradox. Within any fixed hour-window temp and load'
\echo 'correlate POSITIVELY everywhere (SDGE: +0.52 evening, +0.28 midday). But'
\echo 'SDGE load peaks hours after its temperature peak, so pooling across the'
\echo 'diurnal cycle lets between-hour variance dominate and flip the sign.'
\echo ''
\echo 'CHECK 5b IS AUTHORITATIVE. Judge the data on the DAILY formulation,'
\echo 'which is what load forecasting actually uses and what the degree-day'
\echo 'table was built for. Same SDGE data scores +0.85 / +0.91 there.'
\echo ''
\echo 'Pearson r, hourly, July 2025 — diagnostic only:'
SELECT l.zone,
       ROUND(CORR(t.temp_c, l.load_mw)::numeric, 3) AS r,
       COUNT(*) AS hours
FROM ercot_hourly_zonal_load l
JOIN iso_hourly_temps t
  ON t.iso = 'ERCOT' AND t.zone = l.zone
 AND t.year = l.year AND t.month = l.month AND t.day = l.day AND t.hour = l.hour
WHERE l.year = 2025 AND l.month = 7
GROUP BY l.zone ORDER BY r DESC;

\echo ''
\echo '=== 6. Same for CAISO — proves the DLAP switch was right ==='
SELECT l.zone,
       ROUND(CORR(t.temp_c, l.load_mw)::numeric, 3) AS r,
       COUNT(*) AS hours
FROM caiso_hourly_zonal_load l
JOIN iso_hourly_temps t
  ON t.iso = 'CAISO' AND t.zone = l.zone
 AND t.year = l.year AND t.month = l.month AND t.day = l.day AND t.hour = l.hour
WHERE l.year = 2025 AND l.month = 7
GROUP BY l.zone ORDER BY r DESC;

\echo ''
\echo '=== 7. PJM — winter-peaking zones may show NEGATIVE r in January ==='
SELECT l.zone,
       ROUND(CORR(t.temp_c, l.load_mw)::numeric, 3) AS r_july,
       COUNT(*) AS hours
FROM pjm_hourly_zonal_load l
JOIN iso_hourly_temps t
  ON t.iso = 'PJM' AND t.zone = l.zone
 AND t.year = l.year AND t.month = l.month AND t.day = l.day AND t.hour = l.hour
WHERE l.year = 2025 AND l.month = 7
GROUP BY l.zone ORDER BY r_july DESC;

\echo ''
\echo '=== 5b. AUTHORITATIVE — daily peak load vs daily max temp ==='
\echo 'Removes the diurnal phase lag that makes checks 5-7 unreliable for'
\echo 'CAISO. This is the formulation load forecasting uses. Every zone in'
\echo 'every market should be strongly positive in summer; anything below ~0.5'
\echo 'here is a genuine problem worth investigating.'
\echo ''
\echo 'Known exception: ERCOT FWES. Far West is the Permian Basin and its load'
\echo 'is oilfield electrification — pumping, compression, drilling — which runs'
\echo 'flat and does not respond to air temperature. Weak r there is CORRECT.'
WITH daily AS (
  SELECT 'ERCOT' AS iso, zone,
         ((make_timestamp(year,month,day,hour,0,0) AT TIME ZONE 'UTC')
            AT TIME ZONE 'America/Chicago')::date AS ld,
         MAX(load_mw) AS peak_mw, AVG(load_mw) AS avg_mw
  FROM ercot_hourly_zonal_load WHERE year=2025 AND month BETWEEN 5 AND 9
  GROUP BY 1,2,3
  UNION ALL
  SELECT 'CAISO', zone,
         ((make_timestamp(year,month,day,hour,0,0) AT TIME ZONE 'UTC')
            AT TIME ZONE 'America/Los_Angeles')::date,
         MAX(load_mw), AVG(load_mw)
  FROM caiso_hourly_zonal_load WHERE year=2025 AND month BETWEEN 5 AND 9
  GROUP BY 1,2,3
  UNION ALL
  SELECT 'PJM', zone,
         ((make_timestamp(year,month,day,hour,0,0) AT TIME ZONE 'UTC')
            AT TIME ZONE 'America/New_York')::date,
         MAX(load_mw), AVG(load_mw)
  FROM pjm_hourly_zonal_load WHERE year=2025 AND month BETWEEN 5 AND 9
  GROUP BY 1,2,3
)
SELECT d.iso, d.zone,
       ROUND(CORR(t.temp_c_max, d.peak_mw)::numeric, 3) AS r_peak_vs_tmax,
       ROUND(CORR(t.cdd_f,      d.avg_mw )::numeric, 3) AS r_avg_vs_cdd,
       COUNT(*) AS days
FROM daily d
JOIN iso_daily_degree_days t
  ON t.iso = d.iso AND t.zone = d.zone AND t.local_date = d.ld
GROUP BY d.iso, d.zone
ORDER BY d.iso, r_peak_vs_tmax DESC;

\echo ''
\echo '=== 8. Degree days: local rollup, DST days visible ==='
\echo 'hours_used should be 24 almost everywhere, with a handful of 23/25 on'
\echo 'DST transition days. All-24 would mean the rollup ran in UTC by mistake.'
SELECT iso, hours_used, COUNT(*) AS zone_days
FROM iso_daily_degree_days GROUP BY iso, hours_used ORDER BY iso, hours_used;

\echo ''
\echo '=== 9. Degree-day sanity — CDD peaks in summer, HDD in winter ==='
SELECT iso, EXTRACT(month FROM local_date)::int AS month,
       ROUND(AVG(cdd_f)::numeric, 1) AS avg_cdd_f,
       ROUND(AVG(hdd_f)::numeric, 1) AS avg_hdd_f
FROM iso_daily_degree_days
WHERE EXTRACT(year FROM local_date) = 2025 AND EXTRACT(month FROM local_date) IN (1, 7)
GROUP BY iso, 2 ORDER BY iso, 2;

\echo ''
\echo '=== 10. Registry reflects reality ==='
SELECT table_name, hour_time_zone, hour_convention, is_real, data_source
FROM iso_table_metadata
WHERE table_name LIKE '%temp%' OR table_name LIKE '%degree%'
ORDER BY table_name;
