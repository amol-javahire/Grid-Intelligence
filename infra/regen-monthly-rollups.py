#!/usr/bin/env python3
"""
regen-monthly-rollups.py — Rebuild ERCOT monthly price rollups FROM hourly data.

Replaces the stale Replit monthly values in:
  - ercot_node_stats   (hubs + load zones: HB_*, LZ_*)   — column `node`, `node_type`
  - ercot_nodal_stats  (resource nodes: everything else) — column `settlement_point`

Source: ercot_node_prices (hourly da_price / rt_price, seeded by seed-nodal-prices.py).

All aggregation happens IN Postgres (GROUP BY) — no dataframe round-trip.
This is the correct tool for an in-DB source→rollup→dest transform; Polars is for
file/CSV processing (see CLAUDE.md convention note).

Metrics per (node, year, month):
  avg_da_price      AVG(da_price)
  avg_rt_price      AVG(rt_price)
  volatility/std    STDDEV_SAMP(da_price)
  neg_price_percent 100 * share of hours with rt_price < 0   (RT = curtailment signal)
  on_peak_avg       AVG(da_price) for HE07–HE22 Mon–Fri      (ERCOT on-peak)
  off_peak_avg      AVG(da_price) for all other hours
  min_price/max     MIN/MAX(da_price)
  sample_count      COUNT(*)  (nodal table only)

ERCOT on-peak = interval-start hour 6..21 (HE 7..22), Mon–Fri.
NERC holidays are NOT excluded (negligible effect on monthly averages).

Idempotent: deletes existing rows then re-inserts. Safe to re-run.
Usage: python3 infra/regen-monthly-rollups.py
"""
import os, time, logging
import psycopg2

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]

# Shared on-peak predicate (ERCOT: HE07–HE22 Mon–Fri → interval-start hour 6..21)
ON_PEAK = ("EXTRACT(DOW  FROM hour) BETWEEN 1 AND 5 "
           "AND EXTRACT(HOUR FROM hour) BETWEEN 6 AND 21")

# ── Hub / Load-Zone rollup → ercot_node_stats ─────────────────────────────────
NODE_STATS_SQL = f"""
INSERT INTO ercot_node_stats
  (node, node_type, year, month,
   avg_da_price, avg_rt_price, volatility, neg_price_percent,
   on_peak_avg, off_peak_avg, min_price, max_price)
SELECT
  node_name AS node,
  CASE WHEN node_name LIKE 'HB\\_%' THEN 'hub' ELSE 'load_zone' END AS node_type,
  EXTRACT(YEAR  FROM hour)::int  AS year,
  EXTRACT(MONTH FROM hour)::int  AS month,
  ROUND(AVG(da_price)::numeric, 4)                                   AS avg_da_price,
  ROUND(AVG(rt_price)::numeric, 4)                                   AS avg_rt_price,
  ROUND(STDDEV_SAMP(da_price)::numeric, 4)                           AS volatility,
  ROUND(100.0 * COUNT(*) FILTER (WHERE rt_price < 0)
        / NULLIF(COUNT(rt_price), 0), 3)                             AS neg_price_percent,
  ROUND(AVG(da_price) FILTER (WHERE {ON_PEAK})::numeric, 4)          AS on_peak_avg,
  ROUND(AVG(da_price) FILTER (WHERE NOT ({ON_PEAK}))::numeric, 4)    AS off_peak_avg,
  ROUND(MIN(da_price)::numeric, 4)                                   AS min_price,
  ROUND(MAX(da_price)::numeric, 4)                                   AS max_price
FROM ercot_node_prices
WHERE (node_name LIKE 'HB\\_%' OR node_name LIKE 'LZ\\_%')
  AND da_price IS NOT NULL
GROUP BY node_name, year, month;
"""

# ── Resource-node rollup → ercot_nodal_stats ──────────────────────────────────
NODAL_STATS_SQL = f"""
INSERT INTO ercot_nodal_stats
  (settlement_point, year, month,
   avg_da_price, avg_rt_price, std_dev, neg_price_percent,
   on_peak_avg, off_peak_avg, min_price, max_price, sample_count)
SELECT
  node_name AS settlement_point,
  EXTRACT(YEAR  FROM hour)::int  AS year,
  EXTRACT(MONTH FROM hour)::int  AS month,
  ROUND(AVG(da_price)::numeric, 4)                                   AS avg_da_price,
  ROUND(AVG(rt_price)::numeric, 4)                                   AS avg_rt_price,
  ROUND(STDDEV_SAMP(da_price)::numeric, 4)                           AS std_dev,
  ROUND(100.0 * COUNT(*) FILTER (WHERE rt_price < 0)
        / NULLIF(COUNT(rt_price), 0), 3)                             AS neg_price_percent,
  ROUND(AVG(da_price) FILTER (WHERE {ON_PEAK})::numeric, 4)          AS on_peak_avg,
  ROUND(AVG(da_price) FILTER (WHERE NOT ({ON_PEAK}))::numeric, 4)    AS off_peak_avg,
  ROUND(MIN(da_price)::numeric, 4)                                   AS min_price,
  ROUND(MAX(da_price)::numeric, 4)                                   AS max_price,
  COUNT(*)                                                           AS sample_count
FROM ercot_node_prices
WHERE node_name NOT LIKE 'HB\\_%'
  AND node_name NOT LIKE 'LZ\\_%'
  AND da_price IS NOT NULL
GROUP BY node_name, year, month;
"""


def regen(conn, table: str, insert_sql: str):
    t0 = time.time()
    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        before = cur.fetchone()[0]
        cur.execute(f"DELETE FROM {table}")
        cur.execute(insert_sql)
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        after = cur.fetchone()[0]
    conn.commit()
    log.info(f"{table}: {before:,} old rows → {after:,} regenerated in {time.time()-t0:.1f}s")


def main():
    conn = psycopg2.connect(DATABASE_URL)

    # Coverage snapshot before regen
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(DISTINCT node_name),
                   COUNT(*) FILTER (WHERE da_price IS NOT NULL),
                   COUNT(*) FILTER (WHERE rt_price IS NOT NULL)
            FROM ercot_node_prices
        """)
        nodes, da_rows, rt_rows = cur.fetchone()
    log.info(f"Source ercot_node_prices: {nodes:,} nodes | {da_rows:,} DA rows | {rt_rows:,} RT rows")
    if rt_rows == 0:
        log.warning("No RT rows yet — avg_rt_price / neg_price_percent will be NULL. "
                    "Re-run this after RT seeding completes.")

    regen(conn, "ercot_node_stats",  NODE_STATS_SQL)
    regen(conn, "ercot_nodal_stats", NODAL_STATS_SQL)

    # Spot-check reference values from CLAUDE.md / project instructions
    log.info("── Spot checks ──")
    with conn.cursor() as cur:
        cur.execute("""
            SELECT node, node_type,
                   ROUND(AVG(avg_da_price),2), ROUND(AVG(neg_price_percent),2)
            FROM ercot_node_stats
            WHERE node IN ('HB_PAN','HB_NORTH','HB_WEST','HB_HOUSTON','HB_BUSAVG')
            GROUP BY node, node_type ORDER BY node
        """)
        for r in cur.fetchall():
            log.info(f"  {r[0]:12s} ({r[1]}): avg_da=${r[2]}  neg_price={r[3]}%")

    conn.close()
    log.info("=== ROLLUP REGEN DONE ===")


if __name__ == "__main__":
    main()
