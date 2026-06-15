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
    // Return real resource nodes from ercot_node_stats (seeded from CDR 12301)
    const rows = await db.execute<{ node: string }>(
      sql`SELECT DISTINCT node
          FROM ercot_node_stats
          WHERE node_type = 'resource_node'
          ORDER BY node`
    );
    res.json(rows.rows.map(r => r.node));
  } catch (err) {
    req.log.error({ err }, "listErcotSettlementPoints error");
    res.status(500).json({ error: "internal_error", message: "Failed to list settlement points" });
  }
});

// CAISO Settlement Points — distinct resource node names (excludes zones)
router.get("/caiso-settlement-points", async (req, res) => {
  try {
    const rows = await db.execute<{ node: string }>(
      sql`SELECT DISTINCT node
          FROM caiso_node_stats
          WHERE node NOT IN ('NP15', 'SP15', 'ZP26')
          ORDER BY node`
    );
    res.json(rows.rows.map(r => r.node));
  } catch (err) {
    req.log.error({ err }, "listCaisoSettlementPoints error");
    res.status(500).json({ error: "internal_error", message: "Failed to list CAISO settlement points" });
  }
});

// ERCOT Node Stats
router.get("/ercot-node-stats", async (req, res) => {
  try {
    // Parse manually to support new params without waiting for codegen
    const { node, nodeType, year, month, sortBy, limit: limitStr } = req.query as Record<string, string | undefined>;
    const parsedYear = year !== undefined ? Number(year) : undefined;
    const parsedMonth = month !== undefined ? Number(month) : undefined;
    const parsedLimit = limitStr !== undefined ? Number(limitStr) : undefined;

    const conditions = [];
    if (node) conditions.push(eq(ercotNodeStatsTable.node, node));
    if (nodeType) conditions.push(eq(ercotNodeStatsTable.nodeType, nodeType));
    if (parsedYear !== undefined) conditions.push(eq(ercotNodeStatsTable.year, parsedYear));
    if (parsedMonth !== undefined) conditions.push(eq(ercotNodeStatsTable.month, parsedMonth));

    let rows = await db.select().from(ercotNodeStatsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(ercotNodeStatsTable.year, ercotNodeStatsTable.month);

    // Apply sort in JS for flexibility
    if (sortBy === "neg_price_percent") {
      rows.sort((a, b) => Number(b.negPricePercent ?? 0) - Number(a.negPricePercent ?? 0));
    } else if (sortBy === "volatility") {
      rows.sort((a, b) => Number(b.volatility ?? 0) - Number(a.volatility ?? 0));
    } else if (sortBy === "avg_rt_price") {
      rows.sort((a, b) => Number(b.avgRtPrice ?? 0) - Number(a.avgRtPrice ?? 0));
    } else if (sortBy === "price_range") {
      rows.sort((a, b) => (Number(b.maxPrice ?? 0) - Number(b.minPrice ?? 0)) - (Number(a.maxPrice ?? 0) - Number(a.minPrice ?? 0)));
    }
    if (parsedLimit) rows = rows.slice(0, parsedLimit);

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

// PJM Settlement Points — distinct resource node names (excludes zone/hub nodes)
const PJM_ZONE_NODES = new Set([
  "Western Hub", "Eastern Hub", "AEP-Dayton Hub", "NI Hub",
  "PSEG", "PPL", "DOM", "BGE", "PECO", "COMED", "ATSI", "PENELEC",
]);

router.get("/pjm-settlement-points", async (req, res) => {
  try {
    const rows = await db.execute<{ node: string }>(
      sql`SELECT DISTINCT node FROM pjm_node_stats ORDER BY node`
    );
    const resource = rows.rows.map(r => r.node).filter(n => !PJM_ZONE_NODES.has(n));
    res.json(resource);
  } catch (err) {
    req.log.error({ err }, "listPjmSettlementPoints error");
    res.status(500).json({ error: "internal_error", message: "Failed to list PJM settlement points" });
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

// ERCOT Node Locations — bus mapping zone + EIA lat/lon + pricing summary
// Sourced from: ERCOT CDR 10008 (bus mapping via gridstatus), EIA 860 name match
router.get("/ercot-node-locations", async (req, res) => {
  type NodeLocRow = {
    node_name: string; node_type: string; load_zone: string | null; hub: string | null;
    substation: string | null; latitude: number | null; longitude: number | null;
    location_source: string; eia_plant_name: string | null;
    avg_da_price: number | null; avg_rt_price: number | null; months_available: number;
  };
  try {
    const { zone, nodeType, limit: limitStr } = req.query as Record<string, string | undefined>;
    const parsedLimit = Math.min(limitStr ? Number(limitStr) : 1000, 2000);

    let rows: { rows: NodeLocRow[] };

    if (zone && nodeType) {
      rows = await db.execute<NodeLocRow>(sql`
        SELECT node_name, node_type, load_zone, hub, substation,
               latitude::float, longitude::float, location_source, eia_plant_name,
               avg_da_price::float, avg_rt_price::float, months_available
        FROM ercot_node_locations
        WHERE load_zone = ${zone} AND node_type = ${nodeType}
        ORDER BY avg_da_price DESC NULLS LAST LIMIT ${parsedLimit}`);
    } else if (zone) {
      rows = await db.execute<NodeLocRow>(sql`
        SELECT node_name, node_type, load_zone, hub, substation,
               latitude::float, longitude::float, location_source, eia_plant_name,
               avg_da_price::float, avg_rt_price::float, months_available
        FROM ercot_node_locations
        WHERE load_zone = ${zone}
        ORDER BY avg_da_price DESC NULLS LAST LIMIT ${parsedLimit}`);
    } else if (nodeType) {
      rows = await db.execute<NodeLocRow>(sql`
        SELECT node_name, node_type, load_zone, hub, substation,
               latitude::float, longitude::float, location_source, eia_plant_name,
               avg_da_price::float, avg_rt_price::float, months_available
        FROM ercot_node_locations
        WHERE node_type = ${nodeType}
        ORDER BY avg_da_price DESC NULLS LAST LIMIT ${parsedLimit}`);
    } else {
      rows = await db.execute<NodeLocRow>(sql`
        SELECT node_name, node_type, load_zone, hub, substation,
               latitude::float, longitude::float, location_source, eia_plant_name,
               avg_da_price::float, avg_rt_price::float, months_available
        FROM ercot_node_locations
        ORDER BY avg_da_price DESC NULLS LAST LIMIT ${parsedLimit}`);
    }

    res.json(rows.rows.map(r => ({
      nodeName: r.node_name,
      nodeType: r.node_type,
      loadZone: r.load_zone,
      hub: r.hub,
      substation: r.substation,
      latitude: r.latitude,
      longitude: r.longitude,
      locationSource: r.location_source,
      eiaPlantName: r.eia_plant_name,
      avgDaPrice: r.avg_da_price,
      avgRtPrice: r.avg_rt_price,
      monthsAvailable: r.months_available,
    })));
  } catch (err) {
    req.log.error({ err }, "ercotNodeLocations error");
    res.status(500).json({ error: "internal_error", message: "Failed to list ERCOT node locations" });
  }
});

// Transmission Lines — HIFLD 115kV+ (ERCOT/CAISO/PJM) as GeoJSON FeatureCollection
// Source: HIFLD Electric Power Transmission Lines (public, no auth)
router.get("/transmission-lines", async (req, res) => {
  type TxRow = {
    hifld_id: string; line_type: string | null; status: string | null;
    voltage_kv: number | null; volt_class: string | null; owner: string | null;
    sub_from: string | null; sub_to: string | null; iso: string | null;
    line_length_km: number | null; coordinates: unknown;
  };
  try {
    const { minVoltage: minVStr, iso, status } = req.query as Record<string, string | undefined>;
    const minVoltage = minVStr ? Number(minVStr) : 115;

    let rows: { rows: TxRow[] };

    if (iso && status) {
      rows = await db.execute<TxRow>(sql`
        SELECT hifld_id, line_type, status, voltage_kv::float, volt_class, owner,
               sub_from, sub_to, iso, line_length_km::float, coordinates
        FROM transmission_lines
        WHERE voltage_kv >= ${minVoltage} AND iso = ${iso} AND status = ${status}
        ORDER BY voltage_kv DESC NULLS LAST LIMIT 25000`);
    } else if (iso) {
      rows = await db.execute<TxRow>(sql`
        SELECT hifld_id, line_type, status, voltage_kv::float, volt_class, owner,
               sub_from, sub_to, iso, line_length_km::float, coordinates
        FROM transmission_lines
        WHERE voltage_kv >= ${minVoltage} AND iso = ${iso}
        ORDER BY voltage_kv DESC NULLS LAST LIMIT 25000`);
    } else {
      rows = await db.execute<TxRow>(sql`
        SELECT hifld_id, line_type, status, voltage_kv::float, volt_class, owner,
               sub_from, sub_to, iso, line_length_km::float, coordinates
        FROM transmission_lines
        WHERE voltage_kv >= ${minVoltage}
        ORDER BY voltage_kv DESC NULLS LAST LIMIT 25000`);
    }

    // Return as GeoJSON FeatureCollection (properties keyed as VOLTAGE/TYPE to match frontend)
    const features = rows.rows.map(r => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: Array.isArray(r.coordinates) ? r.coordinates : [],
      },
      properties: {
        VOLTAGE: r.voltage_kv,
        VOLT_CLASS: r.volt_class,
        TYPE: r.line_type,
        STATUS: r.status,
        OWNER: r.owner,
        SUB_1: r.sub_from,
        SUB_2: r.sub_to,
        ISO: r.iso,
        LENGTH_KM: r.line_length_km,
      },
    }));

    res.json({ type: "FeatureCollection", features });
  } catch (err) {
    req.log.error({ err }, "transmissionLines error");
    res.status(500).json({ error: "internal_error", message: "Failed to load transmission lines" });
  }
});

// CAISO Node Locations — ATL_PNODE_MAP zone assignments + EIA 860 lat/lon matching
// Sourced from: CAISO OASIS ATL_PNODE_MAP (public), EIA 860 name match
router.get("/caiso-node-locations", async (req, res) => {
  type CaisoLocRow = {
    node_name: string; node_type: string; caiso_zone: string | null;
    latitude: number | null; longitude: number | null;
    location_source: string; eia_plant_name: string | null;
    avg_da_price: number | null; months_available: number;
  };
  try {
    const { zone, nodeType, limit: limitStr } = req.query as Record<string, string | undefined>;
    const parsedLimit = Math.min(limitStr ? Number(limitStr) : 2000, 3000);

    let rows: { rows: CaisoLocRow[] };

    if (zone && nodeType) {
      rows = await db.execute<CaisoLocRow>(sql`
        SELECT node_name, node_type, caiso_zone, latitude::float, longitude::float,
               location_source, eia_plant_name, avg_da_price::float, months_available
        FROM caiso_node_locations
        WHERE caiso_zone = ${zone} AND node_type = ${nodeType}
        ORDER BY node_name LIMIT ${parsedLimit}`);
    } else if (zone) {
      rows = await db.execute<CaisoLocRow>(sql`
        SELECT node_name, node_type, caiso_zone, latitude::float, longitude::float,
               location_source, eia_plant_name, avg_da_price::float, months_available
        FROM caiso_node_locations
        WHERE caiso_zone = ${zone}
        ORDER BY node_name LIMIT ${parsedLimit}`);
    } else if (nodeType) {
      rows = await db.execute<CaisoLocRow>(sql`
        SELECT node_name, node_type, caiso_zone, latitude::float, longitude::float,
               location_source, eia_plant_name, avg_da_price::float, months_available
        FROM caiso_node_locations
        WHERE node_type = ${nodeType}
        ORDER BY node_name LIMIT ${parsedLimit}`);
    } else {
      rows = await db.execute<CaisoLocRow>(sql`
        SELECT node_name, node_type, caiso_zone, latitude::float, longitude::float,
               location_source, eia_plant_name, avg_da_price::float, months_available
        FROM caiso_node_locations
        ORDER BY node_name LIMIT ${parsedLimit}`);
    }

    res.json(rows.rows.map(r => ({
      nodeName: r.node_name,
      nodeType: r.node_type,
      caisoZone: r.caiso_zone,
      latitude: r.latitude,
      longitude: r.longitude,
      locationSource: r.location_source,
      eiaPlantName: r.eia_plant_name,
      avgDaPrice: r.avg_da_price,
      monthsAvailable: r.months_available,
    })));
  } catch (err) {
    req.log.error({ err }, "caisoNodeLocations error");
    res.status(500).json({ error: "internal_error", message: "Failed to list CAISO node locations" });
  }
});

// ─── ERCOT Hub Hourly ──────────────────────────────────────────────────────
// GET /api/ercot/hub-hourly?node=LZ_WEST&year=2024&month=7
// Returns 24-row average hourly DA+RT profile for the selected node/month.
router.get("/ercot/hub-hourly", async (req, res) => {
  try {
    const { node, year, month } = req.query as Record<string, string>;
    if (!node || !year || !month) {
      res.status(400).json({ error: "bad_request", message: "node, year, month are required" });
      return;
    }
    const yr = parseInt(year, 10);
    const mo = parseInt(month, 10);
    if (isNaN(yr) || isNaN(mo) || mo < 1 || mo > 12) {
      res.status(400).json({ error: "bad_request", message: "Invalid year or month" });
      return;
    }
    const rows = await db.execute<{ hour: number; da_price: string; rt_price: string }>(
      sql`SELECT hour,
             ROUND(AVG(da_price::numeric), 4) AS da_price,
             ROUND(AVG(rt_price::numeric), 4) AS rt_price
          FROM ercot_hub_hourly
          WHERE node = ${node}
            AND year = ${yr}
            AND month = ${mo}
          GROUP BY hour
          ORDER BY hour`
    );
    const totalQ = await db.execute<{ cnt: string }>(
      sql`SELECT COUNT(*) AS cnt FROM ercot_hub_hourly`
    );
    res.json({
      node, year: yr, month: mo,
      totalRows: parseInt(totalQ.rows[0]?.cnt ?? "0", 10),
      hourly: rows.rows.map(r => ({
        hour: Number(r.hour),
        daPrice: parseFloat(r.da_price),
        rtPrice: parseFloat(r.rt_price),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "ercot/hub-hourly error");
    res.status(500).json({ error: "internal_error", message: "Failed to fetch hourly data" });
  }
});

// GET /api/ercot/hub-hourly/nodes — list of distinct nodes with data
router.get("/ercot/hub-hourly/nodes", async (req, res) => {
  try {
    const rows = await db.execute<{ node: string; node_type: string; year_count: string; row_count: string }>(
      sql`SELECT node, node_type,
             COUNT(DISTINCT year) AS year_count,
             COUNT(*) AS row_count
          FROM ercot_hub_hourly
          GROUP BY node, node_type
          ORDER BY node`
    );
    res.json(rows.rows.map(r => ({
      node: r.node,
      nodeType: r.node_type,
      yearCount: Number(r.year_count),
      rowCount: Number(r.row_count),
    })));
  } catch (err) {
    req.log.error({ err }, "ercot/hub-hourly/nodes error");
    res.status(500).json({ error: "internal_error", message: "Failed to list hub hourly nodes" });
  }
});

export default router;
