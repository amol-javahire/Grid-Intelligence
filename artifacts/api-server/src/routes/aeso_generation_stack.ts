import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

/* ══════════════════════════════════════════════════════════════════════════
   AESO Generation Stack — capacity factor, capture price, capture rate.

   Backed by infra/create-aeso-generation-stack.sql:
     aeso_asset_monthly  raw COMPONENTS per asset per month
     aeso_asset_ttm      trailing 12 months, components summed then divided once
     aeso_fuel_ttm       fleet rollup by fuel

   WEIGHTING (the whole point):
     capacity factor → capacity-hour weighted
     capture price   → generation weighted
     pool price      → hour weighted
     capture rate    → computed AFTER aggregating the two prices

   Monthly series are aggregated the same way — components summed per fuel per
   month, divided once. AVG() of a monthly ratio is never used anywhere here:
   it would overweight months where an asset barely generated.

   TWO METRICS CARRY CAVEATS, surfaced to the UI rather than silently shipped:

   · COGENERATION capacity factor is understated. Metered volume is net-to-grid;
     cogen consumes most output behind the fence, but max_capability_mw is total
     capability. Denominator includes capacity that never reaches the meter.
     The capture PRICE is unaffected and valid.

   · ENERGY STORAGE capacity factor is near zero and meaningless. Most Alberta
     batteries sit armed providing contingency reserve rather than arbitraging
     energy; their revenue is in the operating reserve market, which is not in
     pool price at all.
   ══════════════════════════════════════════════════════════════════════════ */

const CAVEATS: Record<string, string> = {
  COGENERATION:
    "Capacity factor understated: metered volume is net-to-grid, but capability is total. " +
    "Cogen consumes most output behind the fence. Capture price is unaffected.",
  "ENERGY STORAGE":
    "Capacity factor not meaningful: these assets mostly provide contingency reserve, " +
    "not energy arbitrage. Reserve revenue is outside pool price.",
};

// GET /api/aeso/generation-stack/fuels — fleet rollup, TTM
router.get("/aeso/generation-stack/fuels", async (req, res) => {
  try {
    const rows = await db.execute<{
      fuel_type: string; assets: number; mc_mw: number; ttm_gen_mwh: number;
      capacity_factor: number | null; capture_price: number | null;
      capture_rate: number | null; capture_spread: number | null;
      ttm_pool_price: number | null; partial_assets: number;
    }>(sql`
      SELECT fuel_type,
             assets::int,
             mc_mw::float,
             ttm_gen_mwh::float,
             capacity_factor::float,
             capture_price::float,
             capture_rate::float,
             capture_spread::float,
             ttm_pool_price::float,
             partial_assets::int
      FROM aeso_fuel_ttm
      ORDER BY mc_mw DESC NULLS LAST
    `);

    res.json({
      poolPrice: rows.rows[0]?.ttm_pool_price ?? null,
      fuels: rows.rows.map((r) => ({
        ...r,
        caveat: CAVEATS[r.fuel_type] ?? null,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "aeso generation-stack fuels error");
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/aeso/generation-stack/assets?fuel=WIND — per-asset TTM
router.get("/aeso/generation-stack/assets", async (req, res) => {
  try {
    const fuel = typeof req.query.fuel === "string" && req.query.fuel !== "ALL"
      ? req.query.fuel : null;

    const rows = await db.execute(sql`
      SELECT asset_id, asset_name, fuel_type,
             mc_mw::float,
             months_present::int,
             ttm_gen_mwh::float,
             capacity_factor::float,
             capture_price::float,
             capture_rate::float,
             capture_spread::float,
             ttm_pool_price::float,
             ttm_neg_price_gen_hours::int,
             capacity_caveat
      FROM aeso_asset_ttm
      WHERE (${fuel}::text IS NULL OR fuel_type = ${fuel})
      ORDER BY mc_mw DESC NULLS LAST
    `);

    res.json({ fuel: fuel ?? "ALL", assets: rows.rows });
  } catch (err) {
    req.log.error({ err }, "aeso generation-stack assets error");
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/aeso/generation-stack/monthly?fuel=WIND — monthly trend by fuel.
// Components summed per fuel per month, then divided once.
router.get("/aeso/generation-stack/monthly", async (req, res) => {
  try {
    const fuel = typeof req.query.fuel === "string" && req.query.fuel !== "ALL"
      ? req.query.fuel : null;

    const rows = await db.execute(sql`
      SELECT
        m.month,
        m.fuel_type,
        SUM(m.gen_mwh_pos)::float                                   AS gen_mwh,
        SUM(m.capacity_mwh)::float                                  AS capacity_mwh,
        (SUM(m.gen_mwh_pos) / NULLIF(SUM(m.capacity_mwh), 0))::float AS capacity_factor,
        (SUM(m.pool_revenue_pos) / NULLIF(SUM(m.gen_mwh_pos), 0))::float AS capture_price,
        MAX(m.avg_pool_price)::float                                AS avg_pool_price,
        ((SUM(m.pool_revenue_pos) / NULLIF(SUM(m.gen_mwh_pos), 0))
          / NULLIF(MAX(m.avg_pool_price), 0))::float                AS capture_rate,
        ((SUM(m.pool_revenue_pos) / NULLIF(SUM(m.gen_mwh_pos), 0))
          - MAX(m.avg_pool_price))::float                           AS capture_spread
      FROM aeso_asset_monthly m
      WHERE (${fuel}::text IS NULL OR m.fuel_type = ${fuel})
      GROUP BY m.month, m.fuel_type
      ORDER BY m.month
    `);

    res.json({ fuel: fuel ?? "ALL", months: rows.rows });
  } catch (err) {
    req.log.error({ err }, "aeso generation-stack monthly error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
