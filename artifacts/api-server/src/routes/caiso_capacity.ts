import { Router } from "express";
import { db } from "@workspace/db";
import { candidatesTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

const router = Router();

/**
 * GET /api/caiso-capacity
 * Real EIA-860 installed capacity (from `candidates`) aggregated by fuel type
 * for a given CAISO pricing hub (SP15 or NP15). Used as the real-data basis
 * for the CAISO reserve-margin stress test (no CAISO nodal OPF model exists).
 * Query: hub (optional, defaults to all CAISO)
 */
router.get("/caiso-capacity", async (req, res) => {
  try {
    const { hub } = req.query as Record<string, string | undefined>;

    const conditions = [eq(candidatesTable.market, "CAISO"), eq(candidatesTable.status, "active")];
    if (hub) conditions.push(eq(candidatesTable.pricingHubNode, hub));

    const rows = await db
      .select({
        fuelType:   candidatesTable.assetType,
        capacityMw: sql<number>`ROUND(SUM(capacity_mw)::numeric, 1)`.as("capacity_mw"),
        count:      sql<number>`COUNT(*)`.as("count"),
      })
      .from(candidatesTable)
      .where(and(...conditions))
      .groupBy(candidatesTable.assetType)
      .orderBy(sql`SUM(capacity_mw) DESC`);

    res.json({
      hub: hub ?? "ALL",
      byFuelType: rows.map(r => ({
        fuelType: r.fuelType,
        capacityMw: Number(r.capacityMw),
        count: Number(r.count),
      })),
      totalMw: Number(rows.reduce((s, r) => s + Number(r.capacityMw), 0).toFixed(1)),
      source: "EIA-860 2024 Operable generators (candidates table)",
    });
  } catch (err) {
    req.log.error({ err }, "caiso-capacity error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
