import { Router } from "express";
import { db } from "@workspace/db";
import { loadForecasts } from "@workspace/db/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";

const router = Router();

/**
 * GET /api/load-forecast/zones
 * Returns daily load forecast (base + EV + DC + total) for ERCOT zones.
 * Query: zone (optional), year (optional), month (optional)
 */
router.get("/load-forecast/zones", async (req, res) => {
  try {
    const { zone, year, month } = req.query as Record<string, string | undefined>;

    const conditions = [];
    if (zone)  conditions.push(eq(loadForecasts.zone,  zone));
    if (year)  conditions.push(eq(loadForecasts.year,  Number(year) as any));
    if (month) conditions.push(eq(loadForecasts.month, Number(month) as any));

    const rows = await db
      .select()
      .from(loadForecasts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(loadForecasts.zone, loadForecasts.year, loadForecasts.month, loadForecasts.day);

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "load-forecast/zones error");
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /api/load-forecast/overview
 * Monthly aggregated view per zone for the 3-year forecast window.
 */
router.get("/load-forecast/overview", async (req, res) => {
  try {
    const { zone } = req.query as Record<string, string | undefined>;

    const q = db
      .select({
        zone:    loadForecasts.zone,
        year:    loadForecasts.year,
        month:   loadForecasts.month,
        baseMw:  sql<number>`ROUND(AVG(base_mw)::numeric, 1)`.as("base_mw"),
        evMw:    sql<number>`ROUND(AVG(ev_mw)::numeric, 1)`.as("ev_mw"),
        dcMw:    sql<number>`ROUND(AVG(dc_mw)::numeric, 1)`.as("dc_mw"),
        totalMw: sql<number>`ROUND(AVG(total_mw)::numeric, 1)`.as("total_mw"),
        peakMw:  sql<number>`ROUND(MAX(total_mw)::numeric, 0)`.as("peak_mw"),
      })
      .from(loadForecasts)
      .groupBy(loadForecasts.zone, loadForecasts.year, loadForecasts.month)
      .orderBy(loadForecasts.zone, loadForecasts.year, loadForecasts.month);

    const rows = zone
      ? await q.where(eq(loadForecasts.zone, zone))
      : await q;

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "load-forecast/overview error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
