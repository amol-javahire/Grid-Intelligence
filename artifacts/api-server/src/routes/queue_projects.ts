import { Router } from "express";
import { db, queueProjectsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { ListQueueProjectsQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/queue-projects", async (req, res) => {
  try {
    const parsed = ListQueueProjectsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", message: parsed.error.message });
      return;
    }
    const { market, status, fuelType, limit = 500 } = parsed.data;
    const statusLower = status?.toLowerCase();
    const conditions = [];
    if (market) conditions.push(eq(queueProjectsTable.market, market));
    if (statusLower) conditions.push(eq(queueProjectsTable.status, statusLower));
    if (fuelType) conditions.push(eq(queueProjectsTable.fuelType, fuelType));

    const rows = await db.select().from(queueProjectsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(limit)
      .orderBy(queueProjectsTable.requestDate);

    res.json(rows.map(r => ({
      ...r,
      capacityMw: Number(r.capacityMw),
      latitude: r.latitude ? Number(r.latitude) : null,
      longitude: r.longitude ? Number(r.longitude) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "listQueueProjects error");
    res.status(500).json({ error: "internal_error", message: "Failed to list queue projects" });
  }
});

export default router;
