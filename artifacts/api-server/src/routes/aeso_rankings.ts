import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

/* ══════════════════════════════════════════════════════════════════════════
   AESO asset rankings.

   Alberta is a single province-wide pool price with no locational basis until
   REM go-live (~2027). ERCOT's top-weighted dimensions — nodal curtailment,
   nodal basis, nodal congestion — therefore have NO Alberta equivalent and are
   deliberately absent rather than imported and silently zeroed.

   Six dimensions are computed from measured data; two are disclosed proxies.
   Every dimension carries a `dataStatus` so the UI can show what is measured
   versus assumed, per the platform's data-provenance rules.
   ══════════════════════════════════════════════════════════════════════════ */

interface AssetRow {
  asset_id: string;
  asset_name: string | null;
  fuel_type: string | null;
  sub_fuel_type: string | null;
  owner: string | null;
  max_capability_mw: number | null;
  location: string | null;
  status: string | null;
  gen_mwh: number | null;        // total metered MWh in window
  gen_hours: number | null;      // hours with a metered reading
  capture_price: number | null;  // generation-weighted pool price
  neg_price_hours: number | null;
}

// GET /api/aeso/rankings
// Returns every registered asset with its computed dimension scores.
router.get("/aeso/rankings", async (req, res) => {
  try {
    const months = Math.min(Number(req.query.months ?? 12), 36);

    // Generation-weighted capture price per asset, joined to the registry.
    // LEFT JOIN so assets with no metered volume still appear (scored as
    // "no data" rather than zero).
    const rows = await db.execute<AssetRow>(sql`
      WITH gen AS (
        SELECT
          mv.asset_id,
          SUM(mv.metered_mw)                                   AS gen_mwh,
          COUNT(*)                                             AS gen_hours,
          SUM(mv.metered_mw * pp.pool_price)
            / NULLIF(SUM(mv.metered_mw), 0)                    AS capture_price,
          COUNT(*) FILTER (WHERE pp.pool_price < 0)            AS neg_price_hours
        FROM aeso_metered_volume mv
        JOIN aeso_pool_price pp
          ON pp.date = mv.date AND pp.hour_ending = mv.hour_ending
        WHERE mv.date >= (CURRENT_DATE - (${months} || ' months')::interval)
          AND mv.metered_mw > 0
        GROUP BY mv.asset_id
      )
      SELECT
        ar.asset_id,
        ar.asset_name,
        ar.fuel_type,
        ar.sub_fuel_type,
        ar.pool_participant_name AS owner,
        ar.max_capability_mw::float,
        ar.location,
        ar.status,
        gen.gen_mwh::float,
        gen.gen_hours::float,
        gen.capture_price::float,
        gen.neg_price_hours::float
      FROM aeso_asset_registry ar
      LEFT JOIN gen ON gen.asset_id = ar.asset_id
      WHERE COALESCE(ar.max_capability_mw, 0) > 0
      ORDER BY ar.max_capability_mw DESC NULLS LAST
    `);

    // System-wide reference pool price over the same window — the denominator
    // for capture rate. Alberta has one price, so this is unambiguous.
    const [ref] = (await db.execute<{ avg_pool: number | null; hrs: number | null }>(sql`
      SELECT AVG(pool_price)::float AS avg_pool, COUNT(*)::float AS hrs
      FROM aeso_pool_price
      WHERE date >= (CURRENT_DATE - (${months} || ' months')::interval)
    `)).rows;

    const avgPool = ref?.avg_pool ?? null;

    res.json({
      months,
      referencePoolPrice: avgPool,
      referenceHours: ref?.hrs ?? 0,
      assets: rows.rows,
      // Surfaced so the UI can show honest coverage rather than implying
      // every dimension is measured.
      coverage: {
        assetsTotal: rows.rows.length,
        assetsWithGeneration: rows.rows.filter(r => (r.gen_mwh ?? 0) > 0).length,
        poolPriceHours: ref?.hrs ?? 0,
      },
    });
  } catch (err) {
    req.log.error({ err }, "aeso rankings error");
    // Never return an empty success — an empty list would read as "no assets"
    // rather than "query failed". See TECHNICAL_NOTES on truthful failures.
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/aeso/rankings/summary — dashboard KPI counts
router.get("/aeso/rankings/summary", async (req, res) => {
  try {
    const [totals] = (await db.execute<{
      assets: number; total_mw: number; fuels: number;
    }>(sql`
      SELECT COUNT(*)::int AS assets,
             COALESCE(SUM(max_capability_mw), 0)::float AS total_mw,
             COUNT(DISTINCT fuel_type)::int AS fuels
      FROM aeso_asset_registry
      WHERE COALESCE(max_capability_mw, 0) > 0
    `)).rows;

    const byFuel = await db.execute<{ fuel_type: string; assets: number; mw: number }>(sql`
      SELECT COALESCE(fuel_type, 'unknown') AS fuel_type,
             COUNT(*)::int AS assets,
             COALESCE(SUM(max_capability_mw), 0)::float AS mw
      FROM aeso_asset_registry
      WHERE COALESCE(max_capability_mw, 0) > 0
      GROUP BY 1 ORDER BY mw DESC
    `);

    res.json({ ...totals, byFuel: byFuel.rows });
  } catch (err) {
    req.log.error({ err }, "aeso rankings summary error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
