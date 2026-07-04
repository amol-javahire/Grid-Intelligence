import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

// GET /api/regulatory
// Query params: market (ERCOT|CAISO|FEDERAL|PJM), category, status, impact_level
router.get("/regulatory", async (req, res) => {
  try {
    const { market, category, status, impact_level } = req.query as Record<string, string>;

    const conditions: string[] = [];
    if (market)       conditions.push(`market = '${market.replace(/'/g, "''")}'`);
    if (category)     conditions.push(`category = '${category.replace(/'/g, "''")}'`);
    if (status)       conditions.push(`status = '${status.replace(/'/g, "''")}'`);
    if (impact_level) conditions.push(`impact_level = '${impact_level.replace(/'/g, "''")}'`);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await db.execute(sql.raw(`
      SELECT
        id, market, category, title, summary, detail,
        effective_date, announced_date, status, impact_level,
        source_url, source_name, tags, model_impact,
        scraped_at, created_at
      FROM regulatory_items
      ${where}
      ORDER BY
        CASE impact_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        COALESCE(effective_date, announced_date) DESC
    `));

    const rows = (result as any).rows ?? [];
    res.json(rows.map((r: any) => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
    })));
  } catch (err) {
    req.log.error(err, "GET /regulatory failed");
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/regulatory/summary
// Returns aggregate counts by market + category for dashboard cards
router.get("/regulatory/summary", async (_req, res) => {
  try {
    const result = await db.execute(sql.raw(`
      SELECT
        market,
        category,
        status,
        impact_level,
        COUNT(*) as count,
        MAX(COALESCE(effective_date, announced_date)) as latest_date
      FROM regulatory_items
      GROUP BY market, category, status, impact_level
      ORDER BY market, category
    `));

    const rows = (result as any).rows ?? [];

    // Also grab total counts per market
    const totals = await db.execute(sql.raw(`
      SELECT
        market,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE impact_level = 'high') as high_count,
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        MAX(COALESCE(effective_date, announced_date)) as latest_date
      FROM regulatory_items
      GROUP BY market
    `));

    res.json({
      breakdown: rows,
      totals: (totals as any).rows ?? [],
    });
  } catch (err) {
    res.status(500).json({ error: "internal_error" });
  }
});

// ── OBBBA Credit Eligibility Analysis ─────────────────────────────────────────
// GET /api/regulatory/credit-eligibility
// Analyzes EIA 860 candidates (operable plants) for remaining PTC window + OBBBA context
router.get("/regulatory/credit-eligibility", async (_req, res) => {
  try {
    // Wind PTC runs 10 years from commissioning year. Active if COD + 10 >= 2026.
    const windPtc = await db.execute<{
      market: string; ptc_status: string; cnt: string; total_mw: string;
    }>(sql`
      SELECT market,
        CASE
          WHEN commissioning_year IS NULL THEN 'unknown'
          WHEN commissioning_year + 10 >= 2026 THEN 'active'
          ELSE 'expired'
        END AS ptc_status,
        COUNT(*)::text          AS cnt,
        SUM(capacity_mw)::int::text AS total_mw
      FROM candidates
      WHERE asset_type = 'wind'
      GROUP BY market, ptc_status
      ORDER BY market, ptc_status
    `);

    // PTC years remaining per wind plant
    const windPtcYears = await db.execute<{
      market: string; ptc_yr_bucket: string; cnt: string; total_mw: string;
    }>(sql`
      SELECT market,
        CASE
          WHEN commissioning_year IS NULL THEN 'Unknown'
          WHEN commissioning_year + 10 <= 2025 THEN 'Expired'
          WHEN commissioning_year + 10 - 2026 <= 2 THEN '1-2 yrs left'
          WHEN commissioning_year + 10 - 2026 <= 5 THEN '3-5 yrs left'
          ELSE '6+ yrs left'
        END AS ptc_yr_bucket,
        COUNT(*)::text          AS cnt,
        SUM(capacity_mw)::int::text AS total_mw
      FROM candidates WHERE asset_type = 'wind'
      GROUP BY market, ptc_yr_bucket
      ORDER BY market, ptc_yr_bucket
    `);

    // Solar: ITC was a one-time credit at commissioning. Flag IRA-era (2022+) vs pre-IRA.
    const solar = await db.execute<{
      market: string; era: string; cnt: string; total_mw: string;
    }>(sql`
      SELECT market,
        CASE
          WHEN commissioning_year >= 2022 THEN 'IRA era (2022+)'
          WHEN commissioning_year >= 2017 THEN 'Pre-IRA (2017-2021)'
          ELSE 'Legacy (pre-2017)'
        END AS era,
        COUNT(*)::text AS cnt,
        SUM(capacity_mw)::int::text AS total_mw
      FROM candidates WHERE asset_type = 'solar'
      GROUP BY market, era ORDER BY market, era
    `);

    // Queue safe-harbor analysis: ERCOT projects with request_date before Sep 30 2025
    const queue = await db.execute<{
      status: string; cnt: string; total_mw: string;
    }>(sql`
      SELECT
        CASE
          WHEN request_date <= '2025-09-30'::date OR request_date IS NULL THEN 'pre_obbba'
          ELSE 'post_obbba'
        END AS status,
        COUNT(*)::text AS cnt,
        ROUND(SUM(capacity_mw))::text AS total_mw
      FROM queue_projects
      WHERE market = 'ERCOT' AND withdrawal_date IS NULL
      GROUP BY 1
    `);

    res.json({
      windPtc:    windPtc.rows.map(r => ({ ...r, cnt: Number(r.cnt), totalMw: Number(r.total_mw) })),
      windPtcYears: windPtcYears.rows.map(r => ({ ...r, cnt: Number(r.cnt), totalMw: Number(r.total_mw) })),
      solar:      solar.rows.map(r => ({ ...r, cnt: Number(r.cnt), totalMw: Number(r.total_mw) })),
      queueSafeHarbor: queue.rows.map(r => ({ ...r, cnt: Number(r.cnt), totalMw: Number(r.total_mw) })),
    });
  } catch (err) {
    (res as any).log?.error({ err }, "credit-eligibility error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
