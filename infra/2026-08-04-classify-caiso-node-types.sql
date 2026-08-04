-- ============================================================================
-- Reclassify the 681 caiso_node_stats nodes that fell into 'other'.
--
-- They are not unrecognised resource nodes. They are CAISO's BORDER and
-- AGGREGATION points:
--
--   INTERTIE  — scheduling points to neighbouring balancing authorities.
--               WALC (Western Area Lower Colorado), TEPC (Tucson Electric),
--               AZPS (Arizona Public Service), PACE/PACW (PacifiCorp),
--               IPCO (Idaho Power), BPAT (Bonneville), PSEI (Puget Sound),
--               TPWR (Tacoma), SRP (Salt River), NWMT (NorthWestern Montana),
--               NEVP (NV Energy), LDWP (LADWP), BANC (Balancing Authority of
--               Northern California), IID (Imperial Irrigation), PNM,
--               MIDC (Mid-Columbia trading hub), plus CISO_* on CAISO's side.
--
--   AGGREGATION — CLAP_ (Custom Load Aggregation Point), DLAP_ (Default LAP),
--               ELAP_ (Extended LAP), DGAP_ (generation aggregation).
--
-- WHY THIS MATTERS RATHER THAN BEING COSMETIC
--   You cannot site a generation project at an intertie. If the scorer treats
--   these as resource nodes it will (a) offer candidates a settlement point
--   that does not physically exist for them, and (b) pollute zone-level
--   averages. Their statistics are visibly a different population: mean DA
--   $13.19 with a $0.00 minimum, against $36.78 for genuine resource nodes —
--   several are dormant scheduling points carrying no real price signal.
--
--   Excluding them is therefore a correctness fix, not tidying.
--
-- Run:  psql "$DATABASE_URL" -f infra/2026-08-04-classify-caiso-node-types.sql
-- ============================================================================

\timing on

BEGIN;

-- External balancing authorities that appear as the FIRST underscore-delimited
-- token of an intertie scheduling point. Anchored to the start so a resource
-- node that merely contains these letters is not caught.
WITH external_ba(code) AS (
  VALUES ('WALC'),('WACM'),('TEPC'),('AZPS'),('PACE'),('PACW'),('IPCO'),
         ('BPAT'),('PSEI'),('TPWR'),('SRP'),('NWMT'),('NEVP'),('LDWP'),
         ('BANC'),('IID'),('PNM'),('PSCO'),('CHPD'),('DOPD'),('GCPD'),
         ('SCL'),('TIDC'),('AVRN'),('PGE'),('MIDC'),('SUMMIT'),('CISO'),
         -- second pass 2026-08-04
         ('AVA'),('BCHA'),('BHBA'),('DC'),('WAUW'),('GRIF'),('EPE'),
         ('APS'),('SCE'),('SDGE'),('TH'),('OASIS')
)
UPDATE caiso_node_stats s
SET node_type = 'intertie'
WHERE s.node_type = 'other'
  AND split_part(s.node, '_', 1) IN (SELECT code FROM external_ba);

UPDATE caiso_node_stats
SET node_type = 'aggregation'
WHERE node_type = 'other'
  AND (node LIKE 'CLAP\_%' OR node LIKE 'DLAP\_%' OR node LIKE 'ELAP\_%'
    OR node LIKE 'DGAP\_%' OR node LIKE 'CGAP\_%' OR node LIKE 'TGAP\_%');

-- CATCH-ALL, deliberately conservative.
--
-- Enumerating balancing-authority codes one round at a time is a losing game —
-- two passes turned up AVA, BCHA, BHBA, CGAP_ and DC_ that the first missed.
-- So invert the test: a genuine CAISO INTERNAL resource node carries a voltage
-- segment, e.g. VOLTA2_7_N002, BALCH1_7_B2, ALAMIT_2_PL1X3. That pattern is
-- what identified all 2,032 resource nodes.
--
-- Anything left that has NO voltage segment and ends in -APND is an aggregate
-- pricing node of some kind — intertie, border point, or aggregation. Which
-- kind matters for documentation, but NOT for the scorer, which only asks
-- "is this siteable?". So label it honestly as external_or_aggregate rather
-- than guessing at a specific subtype we have not verified.
UPDATE caiso_node_stats
SET node_type = 'external_or_aggregate'
WHERE node_type = 'other'
  AND node LIKE '%-APND'
  AND node !~ '_[0-9]_';

COMMIT;

\echo ''
\echo '=== Node types after reclassification ==='
\echo 'Only resource_node should feed candidate siting scores.'
SELECT node_type, COUNT(DISTINCT node) AS nodes, COUNT(*) AS node_months,
       ROUND(AVG(avg_da_price), 2)            AS mean_da,
       ROUND(STDDEV_SAMP(avg_da_price), 2)    AS sd_da,
       ROUND(AVG(neg_price_percent), 2)       AS avg_neg_pct
FROM caiso_node_stats
GROUP BY node_type ORDER BY nodes DESC;

\echo ''
\echo '=== Anything STILL unclassified? ==='
\echo 'If a recognisable pattern remains here, extend the rules above rather'
\echo 'than letting it sit in a bucket the scorer silently ignores.'
SELECT node FROM (SELECT DISTINCT node FROM caiso_node_stats WHERE node_type = 'other') s
ORDER BY node LIMIT 30;

\echo ''
\echo '=== Deepest negative-price resource nodes — the Curtailment signal ==='
\echo 'These are the CAISO nodes where a solar PPA would bleed value. They were'
\echo 'invisible when caiso_node_stats held only 3 hub rows.'
SELECT node,
       ROUND(AVG(avg_da_price), 2)      AS avg_da,
       ROUND(AVG(neg_price_percent), 2) AS neg_pct,
       ROUND(MIN(min_price), 2)         AS worst_hour,
       COUNT(*)                          AS months
FROM caiso_node_stats
WHERE node_type = 'resource_node'
GROUP BY node
HAVING COUNT(*) >= 12
ORDER BY neg_pct DESC LIMIT 15;
