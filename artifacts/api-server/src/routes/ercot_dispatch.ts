import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

// ── Monthly generation summary by fuel type ────────────────────────────────────
// GET /api/ercot/dispatch/summary?months=12
// Uses mv_dispatch_monthly (pre-aggregated by month per resource) for sub-100ms response.
// CF = SUM(actual_MWh) / (nameplate_MW × available_hours) — correct capacity factor.
router.get("/ercot/dispatch/summary", async (req, res) => {
  try {
    const months = Math.min(Number(req.query.months ?? 12), 30);

    const rows = await db.execute<{
      year: number; month: number;
      resource_type: string;
      total_mwh: number;
      avg_cf: number;
      avg_offer_price: number;
      resource_count: number;
    }>(sql`
      SELECT
        year, month, resource_type,
        ROUND(SUM(total_gen)::numeric, 0)        AS total_mwh,
        ROUND(
          (SUM(total_gen) / NULLIF(SUM(max_cap * hours::float), 0))::numeric,
          3
        )                                         AS avg_cf,
        ROUND(AVG(avg_offer)::numeric, 2)         AS avg_offer_price,
        COUNT(DISTINCT resource_name)             AS resource_count
      FROM mv_dispatch_monthly
      WHERE (year * 12 + month) >= (
        EXTRACT(year  FROM NOW() - (${months} || ' months')::interval)::int * 12 +
        EXTRACT(month FROM NOW() - (${months} || ' months')::interval)::int
      )
      GROUP BY year, month, resource_type
      ORDER BY year, month, resource_type
    `);

    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "ercot dispatch summary error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Supply stack (merit order) for a date or date range ────────────────────────
// GET /api/ercot/dispatch/supply-stack?date=2024-01-15          (single day)
// GET /api/ercot/dispatch/supply-stack?start=2024-01-01&end=2024-01-31  (range avg)
// CF = SUM(actual_MWh) / (nameplate_MW × hours) — correct capacity factor
router.get("/ercot/dispatch/supply-stack", async (req, res) => {
  try {
    const dateParam  = req.query.date  as string | undefined;
    const startParam = req.query.start as string | undefined;
    const endParam   = req.query.end   as string | undefined;

    const start = startParam ?? dateParam ?? new Date().toISOString().slice(0, 10);
    const end   = endParam   ?? dateParam ?? start;

    const rows = await db.execute<{
      resource_name:   string;
      resource_type:   string;
      avg_mw:          number;
      hsl:             number;
      offer_price_min: number;
      offer_price_max: number;
      offer_mw_total:  number;
      capacity_factor: number;
    }>(sql`
      SELECT
        resource_name,
        resource_type,
        ROUND(AVG(avg_mw)::numeric,          2) AS avg_mw,
        ROUND(MAX(hsl)::numeric,             2) AS hsl,
        ROUND(AVG(offer_price_min)::numeric, 2) AS offer_price_min,
        ROUND(AVG(offer_price_max)::numeric, 2) AS offer_price_max,
        ROUND(AVG(offer_mw_total)::numeric,  2) AS offer_mw_total,
        ROUND(
          (SUM(avg_mw) / NULLIF(MAX(hsl) * COUNT(*)::float, 0))::numeric,
          3
        ) AS capacity_factor
      FROM ercot_hourly_dispatch
      WHERE hour >= ${start}::date::timestamp AT TIME ZONE 'America/Chicago'
        AND hour <  (${end}::date + 1)::timestamp AT TIME ZONE 'America/Chicago'
      GROUP BY resource_name, resource_type
      ORDER BY offer_price_min ASC NULLS FIRST, avg_mw DESC
    `);

    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "ercot supply stack error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Capacity factors by resource type — windowed or monthly ──────────────────
// GET /api/ercot/dispatch/capacity-factors?granularity=monthly
// GET /api/ercot/dispatch/capacity-factors?granularity=alltime  (last 12 months)
// CF = SUM(actual_MWh) / (MAX(hsl) × hours) per resource, then roll up by type.
// Using MAX(hsl) as nameplate capacity and COUNT(*) as available hours.
router.get("/ercot/dispatch/capacity-factors", async (req, res) => {
  try {
    const granularity  = (req.query.granularity as string) ?? "monthly";
    const resourceType = req.query.resourceType as string | undefined;

    if (granularity === "monthly") {
      const rows = await db.execute<{
        year: number; month: number; resource_type: string;
        avg_cf: number; total_mwh: number; peak_mw: number;
      }>(sql`
        SELECT
          year, month, resource_type,
          ROUND(
            (SUM(total_gen) / NULLIF(SUM(max_cap * hours::float), 0))::numeric,
            3
          ) AS avg_cf,
          ROUND(SUM(total_gen)::numeric, 0) AS total_mwh,
          ROUND(MAX(peak_mw)::numeric,   0) AS peak_mw
        FROM (
          SELECT
            EXTRACT(year  FROM hour AT TIME ZONE 'America/Chicago')::int AS year,
            EXTRACT(month FROM hour AT TIME ZONE 'America/Chicago')::int AS month,
            resource_name,
            resource_type,
            SUM(avg_mw) AS total_gen,
            MAX(hsl)    AS max_cap,
            COUNT(*)    AS hours,
            MAX(avg_mw) AS peak_mw
          FROM ercot_hourly_dispatch
          WHERE ${resourceType ? sql`resource_type = ${resourceType}` : sql`1=1`}
          GROUP BY 1, 2, 3, 4
        ) sub
        GROUP BY year, month, resource_type
        ORDER BY year, month, resource_type
      `);
      res.json(rows.rows);
    } else {
      // "alltime" = last 12 months from mv_dispatch_monthly — instant (38k rows)
      const rows = await db.execute<{
        resource_type: string; avg_cf: number; total_resources: number;
        avg_offer_price: number;
      }>(sql`
        SELECT
          resource_type,
          ROUND(
            (SUM(total_gen) / NULLIF(SUM(max_cap * hours::float), 0))::numeric,
            3
          ) AS avg_cf,
          COUNT(DISTINCT resource_name) AS total_resources,
          ROUND(AVG(avg_offer)::numeric, 2) AS avg_offer_price
        FROM mv_dispatch_monthly
        WHERE (year * 12 + month) >= (
          EXTRACT(year  FROM NOW() - INTERVAL '12 months')::int * 12 +
          EXTRACT(month FROM NOW() - INTERVAL '12 months')::int
        )
        GROUP BY resource_type
        ORDER BY avg_cf DESC NULLS LAST
      `);
      res.json(rows.rows);
    }
  } catch (err) {
    req.log.error({ err }, "ercot capacity factors error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Seed progress ─────────────────────────────────────────────────────────────
// GET /api/ercot/dispatch/seed-status
router.get("/ercot/dispatch/seed-status", async (req, res) => {
  try {
    const stats = await db.execute<{
      total_rows: number; total_resources: number;
      min_hour: string; max_hour: string; days_seeded: number;
    }>(sql`
      SELECT
        COUNT(*)                         AS total_rows,
        COUNT(DISTINCT resource_name)    AS total_resources,
        MIN(hour)                        AS min_hour,
        MAX(hour)                        AS max_hour,
        (SELECT COUNT(*) FROM ercot_dispatch_seed_log WHERE rows_inserted >= 0) AS days_seeded
      FROM ercot_hourly_dispatch
    `);
    res.json(stats.rows[0] ?? {});
  } catch (err) {
    req.log.error({ err }, "ercot dispatch seed-status error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Available seeded dates ─────────────────────────────────────────────────────
// GET /api/ercot/dispatch/dates
router.get("/ercot/dispatch/dates", async (req, res) => {
  try {
    const rows = await db.execute<{ seed_date: string }>(sql`
      SELECT seed_date::text
      FROM ercot_dispatch_seed_log
      WHERE rows_inserted > 0
      ORDER BY seed_date
    `);
    res.json(rows.rows.map(r => r.seed_date));
  } catch (err) {
    req.log.error({ err }, "ercot dispatch dates error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
