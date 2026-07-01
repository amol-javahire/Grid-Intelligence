import { Router } from "express";
import { db } from "@workspace/db";
import { datacenters } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

/**
 * GET /api/datacenters
 * Returns all datacenters, optionally filtered by market, state, status.
 */
router.get("/datacenters", async (req, res) => {
  try {
    const { market, state, status } = req.query as Record<string, string | undefined>;

    const conditions = [];
    if (market) conditions.push(eq(datacenters.market, market));
    if (state)  conditions.push(eq(datacenters.state,  state));
    if (status) conditions.push(eq(datacenters.status, status));

    const rows = await db
      .select()
      .from(datacenters)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(datacenters.market, datacenters.state, datacenters.capacityMw);

    res.json(rows.map(r => ({
      ...r,
      capacityMw: Number(r.capacityMw),
      lat:        Number(r.lat),
      lon:        Number(r.lon),
    })));
  } catch (err) {
    req.log.error({ err }, "datacenters error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
