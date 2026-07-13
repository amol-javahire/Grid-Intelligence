import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

// ── GET /api/generators ───────────────────────────────────────────────────────
router.get("/generators", async (req, res) => {
  try {
    const { iso, asset_class, technology, zone, status } = req.query as Record<string, string | undefined>;

    const rows = await db.execute<{
      id: number; plant_name: string; operator: string; asset_class: string;
      technology: string; fuel_primary: string; nameplate_mw: string;
      summer_capacity_mw: string; commissioning_year: number | null;
      lat: string; lng: string; county: string; state: string;
      iso: string; load_zone: string; status: string;
      design_heat_rate: string | null; min_load_mw: string | null;
      max_load_mw: string | null; ramp_rate_mw_min: string | null;
      ramp_rate_emergency_mw_min: string | null;
      startup_cost_cold: string | null; startup_cost_warm: string | null;
      startup_cost_hot: string | null; startup_time_cold_h: string | null;
      vom_per_mwh: string | null; fuel_hub: string | null;
      co2_rate_tons_mwh: string | null; forced_outage_rate: string | null;
      planned_outage_days: number | null; implied_fuel_cost_per_mmb: string | null;
    }>(sql`
      SELECT
        g.id, g.plant_name, g.operator, g.asset_class, g.technology,
        g.fuel_primary, g.nameplate_mw, g.summer_capacity_mw,
        g.commissioning_year, g.lat, g.lng, g.county, g.state,
        g.iso, g.load_zone, g.status,
        tp.design_heat_rate, tp.min_load_mw, tp.max_load_mw,
        tp.ramp_rate_mw_min, tp.ramp_rate_emergency_mw_min,
        tp.startup_cost_cold, tp.startup_cost_warm, tp.startup_cost_hot,
        tp.startup_time_cold_h, tp.vom_per_mwh, tp.fuel_hub,
        tp.co2_rate_tons_mwh, tp.forced_outage_rate, tp.planned_outage_days,
        tp.implied_fuel_cost_per_mmb
      FROM generators g
      LEFT JOIN thermal_params tp ON tp.generator_id = g.id
      WHERE 1=1
        ${iso         ? sql`AND g.iso = ${iso}`               : sql``}
        ${asset_class ? sql`AND g.asset_class = ${asset_class}` : sql``}
        ${technology  ? sql`AND g.technology = ${technology}`  : sql``}
        ${zone        ? sql`AND g.load_zone = ${zone}`         : sql``}
        ${status      ? sql`AND g.status = ${status}`          : sql``}
      ORDER BY g.asset_class, g.technology, g.nameplate_mw DESC
    `);

    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "listGenerators error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── GET /api/generators/merit-order ──────────────────────────────────────────
// Returns thermal dispatch stack sorted by marginal cost at a given gas price.
// Marginal cost = design_heat_rate × gas_price + vom_per_mwh
// For non-gas (coal/lignite): uses implied_fuel_cost_per_mmb from DB.
router.get("/generators/merit-order", async (req, res) => {
  try {
    const iso      = (req.query.iso      as string) ?? "ERCOT";
    const gasPrice = parseFloat((req.query.gas_price as string) ?? "2.50");
    const co2Price = parseFloat((req.query.co2_price as string) ?? "0");

    if (isNaN(gasPrice)) {
      res.status(400).json({ error: "gas_price must be a number" });
      return;
    }

    const rows = await db.execute<{
      id: number; plant_name: string; operator: string;
      technology: string; fuel_primary: string; nameplate_mw: string;
      load_zone: string; commissioning_year: number | null;
      design_heat_rate: string | null; vom_per_mwh: string | null;
      co2_rate_tons_mwh: string | null; implied_fuel_cost_per_mmb: string | null;
      forced_outage_rate: string | null; startup_cost_cold: string | null;
    }>(sql`
      SELECT
        g.id, g.plant_name, g.operator, g.technology, g.fuel_primary,
        g.nameplate_mw, g.load_zone, g.commissioning_year,
        tp.design_heat_rate, tp.vom_per_mwh, tp.co2_rate_tons_mwh,
        tp.implied_fuel_cost_per_mmb, tp.forced_outage_rate,
        tp.startup_cost_cold
      FROM generators g
      JOIN thermal_params tp ON tp.generator_id = g.id
      WHERE g.iso = ${iso}
        AND g.asset_class = 'THERMAL'
        AND g.status = 'OPERATING'
        AND tp.design_heat_rate IS NOT NULL
      ORDER BY g.nameplate_mw DESC
    `);

    const units = rows.rows.map(r => {
      const hr   = parseFloat(r.design_heat_rate ?? "0");
      const vom  = parseFloat(r.vom_per_mwh ?? "0");
      const co2  = parseFloat(r.co2_rate_tons_mwh ?? "0");
      const mw   = parseFloat(r.nameplate_mw ?? "0");
      const efor = parseFloat(r.forced_outage_rate ?? "0.05");
      const fuelCost = r.implied_fuel_cost_per_mmb
        ? parseFloat(r.implied_fuel_cost_per_mmb)
        : gasPrice;
      const fuelComponent = hr * fuelCost;
      const co2Component  = co2 * co2Price;
      const marginalCost  = fuelComponent + vom + co2Component;
      return {
        id:                r.id,
        plant_name:        r.plant_name,
        operator:          r.operator,
        technology:        r.technology,
        fuel_primary:      r.fuel_primary,
        nameplate_mw:      mw,
        load_zone:         r.load_zone,
        commissioning_year: r.commissioning_year,
        design_heat_rate:  hr,
        vom_per_mwh:       vom,
        co2_rate_tons_mwh: co2,
        forced_outage_rate: efor,
        startup_cost_cold: r.startup_cost_cold ? parseFloat(r.startup_cost_cold) : null,
        fuel_component:    Math.round(fuelComponent * 100) / 100,
        co2_component:     Math.round(co2Component  * 100) / 100,
        marginal_cost:     Math.round(marginalCost  * 100) / 100,
        available_mw:      Math.round(mw * (1 - efor)),
      };
    });

    units.sort((a, b) => a.marginal_cost - b.marginal_cost);

    let cumulative = 0;
    const withCumulative = units.map(u => {
      const startMw = cumulative;
      cumulative += u.available_mw;
      return { ...u, start_mw: startMw, end_mw: cumulative, cumulative_mw: cumulative };
    });

    res.json({
      gas_price:        gasPrice,
      co2_price:        co2Price,
      total_thermal_mw: cumulative,
      units:            withCumulative,
    });
  } catch (err) {
    req.log.error({ err }, "meritOrder error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── GET /api/generators/summary ──────────────────────────────────────────────
router.get("/generators/summary", async (req, res) => {
  try {
    const iso = (req.query.iso as string) ?? "ERCOT";

    const rows = await db.execute(sql`
      SELECT
        g.asset_class, g.technology, g.fuel_primary, g.status,
        COUNT(*) AS unit_count,
        ROUND(SUM(g.nameplate_mw)::numeric, 0) AS total_mw,
        ROUND(AVG(g.nameplate_mw)::numeric, 1) AS avg_mw,
        ROUND(AVG(tp.design_heat_rate)::numeric, 3) AS avg_heat_rate,
        ROUND(AVG(tp.vom_per_mwh)::numeric, 2) AS avg_vom,
        ROUND(AVG(tp.co2_rate_tons_mwh)::numeric, 4) AS avg_co2_rate,
        ROUND(AVG(tp.forced_outage_rate)::numeric, 4) AS avg_efor,
        MIN(g.commissioning_year) AS oldest_year,
        MAX(g.commissioning_year) AS newest_year
      FROM generators g
      LEFT JOIN thermal_params tp ON tp.generator_id = g.id
      WHERE g.iso = ${iso} AND g.status = 'OPERATING'
      GROUP BY g.asset_class, g.technology, g.fuel_primary, g.status
      ORDER BY SUM(g.nameplate_mw) DESC
    `);

    const riskRows = await db.execute(sql`
      SELECT
        COUNT(*) AS at_risk_units,
        ROUND(SUM(g.nameplate_mw)::numeric, 0) AS at_risk_mw
      FROM generators g
      JOIN thermal_params tp ON tp.generator_id = g.id
      WHERE g.iso = ${iso}
        AND g.asset_class = 'THERMAL'
        AND g.status = 'OPERATING'
        AND tp.implied_fuel_cost_per_mmb IS NULL
        AND (tp.design_heat_rate * 2.50 + tp.vom_per_mwh) > 40
    `);

    res.json({
      byTechnology:   rows.rows,
      retirementRisk: riskRows.rows[0] ?? { at_risk_units: 0, at_risk_mw: 0 },
    });
  } catch (err) {
    req.log.error({ err }, "generatorSummary error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── GET /api/generators/eia-fleet ─────────────────────────────────────────────
// Full ERCOT fleet from EIA 860 (candidates table) — all fuel types.
// Used for wind / solar / storage / nuclear / hydro / biomass fleet tabs.
router.get("/generators/eia-fleet", async (req, res) => {
  try {
    const { iso, asset_type } = req.query as Record<string, string | undefined>;
    const market = iso ?? "ERCOT";

    const rows = await db.execute<{
      id: number; name: string; asset_type: string; capacity_mw: string;
      state: string | null; county: string | null;
      commissioning_year: number | null; interconnection_node: string | null;
      pricing_hub_node: string | null; curtailment_score: string | null;
      price_score: string | null; overall_score: string;
    }>(sql`
      SELECT
        id, name, asset_type, capacity_mw, state, county,
        commissioning_year, interconnection_node, pricing_hub_node,
        curtailment_score, price_score, overall_score
      FROM candidates
      WHERE market = ${market}
        AND status = 'active'
        ${asset_type ? sql`AND asset_type = ${asset_type}` : sql``}
      ORDER BY capacity_mw DESC
      LIMIT 500
    `);

    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "eia-fleet error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
