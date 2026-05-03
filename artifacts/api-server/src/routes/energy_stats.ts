import { Router } from "express";
import { db, ercotNodeStatsTable, ercotNodalStatsTable, caisoNodeStatsTable, pjmNodeStatsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  ListErcotNodeStatsQueryParams,
  ListErcotNodalStatsQueryParams,
  ListCaisoNodeStatsQueryParams,
  ListPjmNodeStatsQueryParams,
} from "@workspace/api-zod";

const router = Router();

// ERCOT Settlement Points — distinct resource node names (excludes HB_* and LZ_*)
router.get("/ercot-settlement-points", async (req, res) => {
  try {
    const rows = await db.execute<{ settlement_point: string }>(
      sql`SELECT DISTINCT settlement_point
          FROM ercot_nodal_stats
          WHERE LEFT(settlement_point, 3) NOT IN ('HB_', 'LZ_')
          ORDER BY settlement_point`
    );
    res.json(rows.rows.map(r => r.settlement_point));
  } catch (err) {
    req.log.error({ err }, "listErcotSettlementPoints error");
    res.status(500).json({ error: "internal_error", message: "Failed to list settlement points" });
  }
});

// ERCOT Node Stats
router.get("/ercot-node-stats", async (req, res) => {
  try {
    const parsed = ListErcotNodeStatsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", message: parsed.error.message });
      return;
    }
    const { node, year, month } = parsed.data;
    const conditions = [];
    if (node) conditions.push(eq(ercotNodeStatsTable.node, node));
    if (year !== undefined) conditions.push(eq(ercotNodeStatsTable.year, year));
    if (month !== undefined) conditions.push(eq(ercotNodeStatsTable.month, month));

    const rows = await db.select().from(ercotNodeStatsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(ercotNodeStatsTable.year, ercotNodeStatsTable.month);

    res.json(rows.map(r => ({
      ...r,
      avgDaPrice: Number(r.avgDaPrice),
      avgRtPrice: r.avgRtPrice ? Number(r.avgRtPrice) : null,
      volatility: r.volatility ? Number(r.volatility) : null,
      negPricePercent: r.negPricePercent ? Number(r.negPricePercent) : null,
      onPeakAvg: r.onPeakAvg ? Number(r.onPeakAvg) : null,
      offPeakAvg: r.offPeakAvg ? Number(r.offPeakAvg) : null,
      minPrice: r.minPrice ? Number(r.minPrice) : null,
      maxPrice: r.maxPrice ? Number(r.maxPrice) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "listErcotNodeStats error");
    res.status(500).json({ error: "internal_error", message: "Failed to list ERCOT node stats" });
  }
});

// ERCOT Nodal Stats
router.get("/ercot-nodal-stats", async (req, res) => {
  try {
    const parsed = ListErcotNodalStatsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", message: parsed.error.message });
      return;
    }
    const { settlementPoint, year, month } = parsed.data;
    const conditions = [];
    if (settlementPoint) conditions.push(eq(ercotNodalStatsTable.settlementPoint, settlementPoint));
    if (year !== undefined) conditions.push(eq(ercotNodalStatsTable.year, year));
    if (month !== undefined) conditions.push(eq(ercotNodalStatsTable.month, month));

    const rows = await db.select().from(ercotNodalStatsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(ercotNodalStatsTable.year, ercotNodalStatsTable.month);

    res.json(rows.map(r => ({
      ...r,
      avgDaPrice: Number(r.avgDaPrice),
      avgRtPrice: r.avgRtPrice ? Number(r.avgRtPrice) : null,
      stdDev: r.stdDev ? Number(r.stdDev) : null,
      negPricePercent: r.negPricePercent ? Number(r.negPricePercent) : null,
      onPeakAvg: r.onPeakAvg ? Number(r.onPeakAvg) : null,
      offPeakAvg: r.offPeakAvg ? Number(r.offPeakAvg) : null,
      minPrice: r.minPrice ? Number(r.minPrice) : null,
      maxPrice: r.maxPrice ? Number(r.maxPrice) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "listErcotNodalStats error");
    res.status(500).json({ error: "internal_error", message: "Failed to list ERCOT nodal stats" });
  }
});

// CAISO Node Stats
router.get("/caiso-node-stats", async (req, res) => {
  try {
    const parsed = ListCaisoNodeStatsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", message: parsed.error.message });
      return;
    }
    const { node, year, month } = parsed.data;
    const conditions = [];
    if (node) conditions.push(eq(caisoNodeStatsTable.node, node));
    if (year !== undefined) conditions.push(eq(caisoNodeStatsTable.year, year));
    if (month !== undefined) conditions.push(eq(caisoNodeStatsTable.month, month));

    const rows = await db.select().from(caisoNodeStatsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(caisoNodeStatsTable.year, caisoNodeStatsTable.month);

    res.json(rows.map(r => ({
      ...r,
      avgDaPrice: Number(r.avgDaPrice),
      avgRtPrice: r.avgRtPrice ? Number(r.avgRtPrice) : null,
      volatility: r.volatility ? Number(r.volatility) : null,
      negPricePercent: r.negPricePercent ? Number(r.negPricePercent) : null,
      onPeakAvg: r.onPeakAvg ? Number(r.onPeakAvg) : null,
      offPeakAvg: r.offPeakAvg ? Number(r.offPeakAvg) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "listCaisoNodeStats error");
    res.status(500).json({ error: "internal_error", message: "Failed to list CAISO node stats" });
  }
});

// PJM Node Stats
router.get("/pjm-node-stats", async (req, res) => {
  try {
    const parsed = ListPjmNodeStatsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", message: parsed.error.message });
      return;
    }
    const { node, year, month } = parsed.data;
    const conditions = [];
    if (node) conditions.push(eq(pjmNodeStatsTable.node, node));
    if (year !== undefined) conditions.push(eq(pjmNodeStatsTable.year, year));
    if (month !== undefined) conditions.push(eq(pjmNodeStatsTable.month, month));

    const rows = await db.select().from(pjmNodeStatsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(pjmNodeStatsTable.year, pjmNodeStatsTable.month);

    res.json(rows.map(r => ({
      ...r,
      avgDaPrice: Number(r.avgDaPrice),
      avgRtPrice: r.avgRtPrice ? Number(r.avgRtPrice) : null,
      volatility: r.volatility ? Number(r.volatility) : null,
      negPricePercent: r.negPricePercent ? Number(r.negPricePercent) : null,
      onPeakAvg: r.onPeakAvg ? Number(r.onPeakAvg) : null,
      offPeakAvg: r.offPeakAvg ? Number(r.offPeakAvg) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "listPjmNodeStats error");
    res.status(500).json({ error: "internal_error", message: "Failed to list PJM node stats" });
  }
});

export default router;
