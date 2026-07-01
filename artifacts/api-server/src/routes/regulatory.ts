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

export default router;
