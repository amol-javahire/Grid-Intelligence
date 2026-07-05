import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

// ── Monthly generation summary by fuel type ────────────────────────────────────
// GET /api/ercot/dispatch/summary?months=12
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
        EXTRACT(year  FROM hour AT TIME ZONE 'America/Chicago')::int AS year,
        EXTRACT(month FROM hour AT TIME ZONE 'America/Chicago')::int AS month,
        resource_type,
        ROUND(SUM(avg_mw)::numeric, 0)                              AS total_mwh,
        ROUND(
          AVG(CASE WHEN hsl > 0 THEN avg_mw::float / hsl::float ELSE NULL END)::numeric,
          3
        )                                                           AS avg_cf,
        ROUND(AVG(offer_price_min)::numeric, 2)                     AS avg_offer_price,
        COUNT(DISTINCT resource_name)                               AS resource_count
      FROM ercot_hourly_dispatch
      WHERE hour >= NOW() - (${months} || ' months')::interval
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `);

    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "ercot dispatch summary error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Supply stack (merit order) for a given date ────────────────────────────────
// GET /api/ercot/dispatch/supply-stack?date=2024-01-15
// Returns all resources with their avg offer price + avg MW for the day,
// sorted by offer_price_min (merit order). Null-price resources (wind self-sched) sorted first.
router.get("/ercot/dispatch/supply-stack", async (req, res) => {
  try {
    const dateParam = req.query.date as string | undefined;
    const date = dateParam ?? new Date().toISOString().slice(0, 10);

    const rows = await db.execute<{
      resource_name: string;
      resource_type: string;
      avg_mw: number;
      hsl: number;
      offer_price_min: number;
      offer_price_max: number;
      offer_mw_total: number;
      capacity_factor: number;
    }>(sql`
      SELECT
        resource_name,
        resource_type,
        ROUND(AVG(avg_mw)::numeric,       2) AS avg_mw,
        ROUND(AVG(hsl)::numeric,          2) AS hsl,
        ROUND(AVG(offer_price_min)::numeric, 2) AS offer_price_min,
        ROUND(AVG(offer_price_max)::numeric, 2) AS offer_price_max,
        ROUND(AVG(offer_mw_total)::numeric,  2) AS offer_mw_total,
        ROUND(
          AVG(CASE WHEN hsl > 0 THEN avg_mw::float / hsl::float ELSE NULL END)::numeric,
          3
        ) AS capacity_factor
      FROM ercot_hourly_dispatch
      WHERE DATE(hour AT TIME ZONE 'America/Chicago') = ${date}::date
      GROUP BY resource_name, resource_type
      ORDER BY offer_price_min ASC NULLS FIRST, avg_mw DESC
    `);

    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "ercot supply stack error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Capacity factors by resource type — all-time or monthly ───────────────────
// GET /api/ercot/dispatch/capacity-factors?granularity=monthly
router.get("/ercot/dispatch/capacity-factors", async (req, res) => {
  try {
    const granularity = (req.query.granularity as string) ?? "monthly";
    const resourceType = req.query.resourceType as string | undefined;

    if (granularity === "monthly") {
      const rows = await db.execute<{
        year: number; month: number; resource_type: string;
        avg_cf: number; total_mwh: number; peak_mw: number;
      }>(sql`
        SELECT
          EXTRACT(year  FROM hour AT TIME ZONE 'America/Chicago')::int AS year,
          EXTRACT(month FROM hour AT TIME ZONE 'America/Chicago')::int AS month,
          resource_type,
          ROUND(
            AVG(CASE WHEN hsl > 0 THEN avg_mw::float / hsl::float ELSE NULL END)::numeric,
            3
          ) AS avg_cf,
          ROUND(SUM(avg_mw)::numeric, 0) AS total_mwh,
          ROUND(MAX(avg_mw)::numeric, 0) AS peak_mw
        FROM ercot_hourly_dispatch
        WHERE ${resourceType ? sql`resource_type = ${resourceType}` : sql`1=1`}
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
      `);
      res.json(rows.rows);
    } else {
      // all-time aggregate per resource type
      const rows = await db.execute<{
        resource_type: string; avg_cf: number; total_resources: number;
        avg_offer_price: number;
      }>(sql`
        SELECT
          resource_type,
          ROUND(
            AVG(CASE WHEN hsl > 0 THEN avg_mw::float / hsl::float ELSE NULL END)::numeric,
            3
          ) AS avg_cf,
          COUNT(DISTINCT resource_name) AS total_resources,
          ROUND(AVG(offer_price_min)::numeric, 2) AS avg_offer_price
        FROM ercot_hourly_dispatch
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
