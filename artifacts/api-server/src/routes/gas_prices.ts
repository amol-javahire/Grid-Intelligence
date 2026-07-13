import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

// ── Daily/Weekly gas prices ────────────────────────────────────────────────

router.get("/gas-prices", async (req, res) => {
  try {
    const { hub, from, to } = req.query as Record<string, string | undefined>;
    const fromDate = from ?? "2024-01-01";
    const toDate   = to   ?? new Date().toISOString().slice(0, 10);

    const rows = await db.execute<{
      hub: string; date: string; price: string; source: string;
    }>(sql`
      SELECT hub, date::text, price::float8, source
      FROM gas_prices
      WHERE date >= ${fromDate}::date
        AND date <= ${toDate}::date
        ${hub ? sql`AND hub = ${hub}` : sql``}
      ORDER BY hub, date
    `);

    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "gas-prices error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Spark spread: monthly average power price - (gas price × heat_rate) ──

router.get("/gas-prices/spark-spread", async (req, res) => {
  try {
    const {
      node      = "HB_HOUSTON",
      heat_rate = "8.5",
      gas_hub   = "henry_hub",
    } = req.query as Record<string, string | undefined>;

    const hr = parseFloat(heat_rate);

    // Monthly average DA price for selected ERCOT node
    const powerRows = await db.execute<{
      year: string; month: string; avg_da: string;
    }>(sql`
      SELECT year, month, AVG(avg_da_price)::float8 AS avg_da
      FROM ercot_node_stats
      WHERE node = ${node}
        AND avg_da_price IS NOT NULL
        AND year >= 2024
      GROUP BY year, month
      ORDER BY year, month
    `);

    // Monthly average gas price (interpolate weekly/daily to monthly)
    const gasRows = await db.execute<{
      year: string; month: string; avg_gas: string;
    }>(sql`
      SELECT
        EXTRACT(YEAR  FROM date)::int AS year,
        EXTRACT(MONTH FROM date)::int AS month,
        AVG(price::float8)            AS avg_gas
      FROM gas_prices
      WHERE hub = ${gas_hub}
        AND price IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);

    // Join on year+month
    const gasMap = new Map(
      gasRows.rows.map(r => [`${r.year}-${r.month}`, Number(r.avg_gas)])
    );

    const result = powerRows.rows.map(r => {
      const gasPrice = gasMap.get(`${r.year}-${r.month}`);
      const powerPrice = Number(r.avg_da);
      const sparkSpread = gasPrice != null
        ? powerPrice - gasPrice * hr
        : null;
      return {
        year:        Number(r.year),
        month:       Number(r.month),
        powerPrice,
        gasPrice:    gasPrice ?? null,
        sparkSpread,
        heatRate:    hr,
      };
    });

    res.json({ node, gasHub: gas_hub, heatRate: hr, data: result });
  } catch (err) {
    req.log.error({ err }, "spark-spread error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Implied heat rate: power price ÷ gas price ────────────────────────────

router.get("/gas-prices/implied-heat-rate", async (req, res) => {
  try {
    const {
      node    = "HB_HOUSTON",
      gas_hub = "henry_hub",
    } = req.query as Record<string, string | undefined>;

    const powerRows = await db.execute<{
      year: string; month: string; avg_da: string;
    }>(sql`
      SELECT year, month, AVG(avg_da_price)::float8 AS avg_da
      FROM ercot_node_stats
      WHERE node = ${node} AND avg_da_price IS NOT NULL AND year >= 2024
      GROUP BY year, month ORDER BY year, month
    `);

    const gasRows = await db.execute<{
      year: string; month: string; avg_gas: string;
    }>(sql`
      SELECT
        EXTRACT(YEAR  FROM date)::int AS year,
        EXTRACT(MONTH FROM date)::int AS month,
        AVG(price::float8) AS avg_gas
      FROM gas_prices WHERE hub = ${gas_hub} AND price IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1, 2
    `);

    const gasMap = new Map(
      gasRows.rows.map(r => [`${r.year}-${r.month}`, Number(r.avg_gas)])
    );

    const result = powerRows.rows.map(r => {
      const gasPrice   = gasMap.get(`${r.year}-${r.month}`);
      const powerPrice = Number(r.avg_da);
      const impliedHR  = gasPrice && gasPrice > 0 ? powerPrice / gasPrice : null;
      return {
        year: Number(r.year), month: Number(r.month),
        powerPrice, gasPrice: gasPrice ?? null, impliedHeatRate: impliedHR,
      };
    });

    res.json({ node, gasHub: gas_hub, data: result });
  } catch (err) {
    req.log.error({ err }, "implied-heat-rate error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Waha-HH basis alongside LZ_WEST power basis ───────────────────────────

router.get("/gas-prices/waha-basis", async (req, res) => {
  try {
    // Monthly HH and Waha averages → basis = Waha - HH
    const gasRows = await db.execute<{
      year: string; month: string;
      hh_avg: string; waha_avg: string;
    }>(sql`
      SELECT
        EXTRACT(YEAR  FROM date)::int AS year,
        EXTRACT(MONTH FROM date)::int AS month,
        AVG(price::float8) FILTER (WHERE hub = 'henry_hub') AS hh_avg,
        AVG(price::float8) FILTER (WHERE hub = 'waha')      AS waha_avg
      FROM gas_prices
      WHERE price IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);

    // LZ_WEST monthly DA-RT power basis
    const powerRows = await db.execute<{
      year: string; month: string;
      avg_da: string; avg_rt: string; neg_pct: string;
    }>(sql`
      SELECT year, month,
        AVG(avg_da_price)::float8      AS avg_da,
        AVG(avg_rt_price)::float8      AS avg_rt,
        AVG(neg_price_percent)::float8 AS neg_pct
      FROM ercot_node_stats
      WHERE node = 'LZ_WEST'
        AND (avg_da_price IS NOT NULL OR avg_rt_price IS NOT NULL)
      GROUP BY year, month
      ORDER BY year, month
    `);

    const powerMap = new Map(
      powerRows.rows.map(r => [`${r.year}-${r.month}`, r])
    );

    const result = gasRows.rows.map(r => {
      const key = `${r.year}-${r.month}`;
      const pw  = powerMap.get(key);
      const hh  = r.hh_avg   != null ? Number(r.hh_avg)   : null;
      const waha= r.waha_avg != null ? Number(r.waha_avg) : null;
      return {
        year:  Number(r.year),
        month: Number(r.month),
        hhAvg:       hh,
        wahaAvg:     waha,
        wahaBasis:   hh != null && waha != null ? waha - hh : null,
        powerDaAvg:  pw ? Number(pw.avg_da) : null,
        powerRtAvg:  pw ? Number(pw.avg_rt) : null,
        powerBasis:  pw && pw.avg_rt != null && pw.avg_da != null
                       ? Number(pw.avg_rt) - Number(pw.avg_da) : null,
        negPricePct: pw ? Number(pw.neg_pct) : null,
      };
    });

    res.json({ data: result });
  } catch (err) {
    req.log.error({ err }, "waha-basis error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Summary: current prices + spark spreads by node ──────────────────────

router.get("/gas-prices/summary", async (req, res) => {
  try {
    // Latest gas prices
    const latestGas = await db.execute<{
      hub: string; date: string; price: string; source: string;
    }>(sql`
      SELECT DISTINCT ON (hub) hub, date::text, price::float8, source
      FROM gas_prices WHERE price IS NOT NULL
      ORDER BY hub, date DESC
    `);

    // Latest monthly ERCOT hub/zone prices (hub/load zone nodes only)
    const latestPower = await db.execute<{
      node: string; year: string; month: string; avg_da: string;
    }>(sql`
      SELECT DISTINCT ON (node) node, year, month, avg_da_price::float8 AS avg_da
      FROM ercot_node_stats
      WHERE node_type IN ('hub', 'load_zone') AND avg_da_price IS NOT NULL
      ORDER BY node, year DESC, month DESC
    `);

    const gasByHub = Object.fromEntries(
      latestGas.rows.map(r => [r.hub, { date: r.date, price: Number(r.price), source: r.source }])
    );

    const HH_HR   = 8.5;
    const nodes = latestPower.rows.map(r => {
      const powerPrice = Number(r.avg_da);
      const hhGas      = gasByHub["henry_hub"]?.price;
      const wahaGas    = gasByHub["waha"]?.price;
      const isWest     = r.node === "LZ_WEST" || r.node === "HB_PAN";
      const gasPrice   = isWest ? (wahaGas ?? hhGas) : hhGas;
      return {
        node: r.node, year: Number(r.year), month: Number(r.month),
        powerPrice,
        gasPrice:    gasPrice ?? null,
        sparkSpread: gasPrice != null ? powerPrice - gasPrice * HH_HR : null,
        impliedHR:   gasPrice && gasPrice > 0 ? powerPrice / gasPrice : null,
      };
    });

    res.json({
      latestGas: gasByHub,
      nodes,
      benchmarks: {
        ccgt:   { label: "CCGT (efficient)", minHR: 6.5, maxHR: 7.5 },
        gasCT:  { label: "Gas CT (peaker)",  minHR: 9.0, maxHR: 11.0 },
        steam:  { label: "Old steam",        minHR: 12.0, maxHR: 15.0 },
      },
    });
  } catch (err) {
    req.log.error({ err }, "gas-prices/summary error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Forward curve: NYMEX HH strip + historical overlay + spark sensitivity ─

router.get("/gas-prices/forward-curve", async (req, res) => {
  try {
    const {
      node      = "HB_HOUSTON",
      heat_rate = "8.5",
    } = req.query as Record<string, string | undefined>;

    const hr = parseFloat(heat_rate);

    // Latest forward curve (most recent as_of_date)
    const curveRows = await db.execute<{
      as_of_date: string; delivery_month: string; settle_price: string; source: string;
    }>(sql`
      SELECT as_of_date::text, delivery_month::text, settle_price::float8, source
      FROM gas_forwards
      WHERE as_of_date = (SELECT MAX(as_of_date) FROM gas_forwards)
      ORDER BY delivery_month ASC
    `);

    // Historical HH spot — monthly averages for last 30 months
    const spotRows = await db.execute<{
      year: string; month: string; avg_price: string;
    }>(sql`
      SELECT
        EXTRACT(YEAR  FROM date)::int AS year,
        EXTRACT(MONTH FROM date)::int AS month,
        AVG(price::float8) AS avg_price
      FROM gas_prices
      WHERE hub = 'henry_hub' AND price IS NOT NULL
        AND date >= (CURRENT_DATE - INTERVAL '30 months')
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);

    // Monthly average DA power price for selected ERCOT node (all available)
    const powerRows = await db.execute<{
      year: string; month: string; avg_da: string;
    }>(sql`
      SELECT year, month, AVG(avg_da_price)::float8 AS avg_da
      FROM ercot_node_stats
      WHERE node = ${node} AND avg_da_price IS NOT NULL
      GROUP BY year, month
      ORDER BY year, month
    `);

    // Seasonal shape: avg DA price by calendar month (1–12), normalized by annual avg
    // Used to add realistic ERCOT seasonal pattern to synthetic power forwards
    const seasonalRows = await db.execute<{
      calendar_month: string; avg_da: string;
    }>(sql`
      SELECT
        month::int AS calendar_month,
        AVG(avg_da_price)::float8 AS avg_da
      FROM ercot_node_stats
      WHERE node = ${node} AND avg_da_price IS NOT NULL
      GROUP BY month
      ORDER BY month
    `);

    // Build seasonal multipliers (ratio to annual mean — 1.0 = at-season-average)
    const seasonalMap = new Map<number, number>();
    if (seasonalRows.rows.length > 0) {
      const annualAvg = seasonalRows.rows.reduce((s, r) => s + Number(r.avg_da), 0) / seasonalRows.rows.length;
      if (annualAvg > 0) {
        for (const r of seasonalRows.rows) {
          seasonalMap.set(Number(r.calendar_month), Number(r.avg_da) / annualAvg);
        }
      }
    }

    // ── Model-based fallback when gas_forwards is empty ───────────────────────
    // 24-month mean-reversion strip: latest spot → $3.50 over 18 months,
    // shaped by NYMEX seasonal multipliers (winter/summer peaks)
    let rawCurveRows = [...curveRows.rows];
    if (rawCurveRows.length === 0) {
      const SEASONAL_HH = [1.15, 1.20, 1.05, 0.95, 0.95, 1.00, 1.10, 1.15, 1.05, 0.95, 1.00, 1.10];
      const TARGET      = 3.50;
      const REV_MO      = 18;
      const latestSpot  = spotRows.rows.length > 0
        ? Number(spotRows.rows.at(-1)!.avg_price)
        : TARGET;
      const today = new Date();
      const asOf  = today.toISOString().slice(0, 10);

      for (let i = 0; i < 36; i++) {
        const d      = new Date(Date.UTC(today.getFullYear(), today.getMonth() + i + 1, 1));
        const t      = Math.min(i / REV_MO, 1.0);
        const base   = latestSpot + (TARGET - latestSpot) * t;
        const shaped = base * SEASONAL_HH[d.getUTCMonth()];
        rawCurveRows.push({
          as_of_date:     asOf,
          delivery_month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`,
          settle_price:   String(Math.round(shaped * 1000) / 1000),
          source:         "model",
        });
      }
    }

    // Build power map for historical overlay
    const powerMap = new Map(
      powerRows.rows.map(r => [`${r.year}-${r.month}`, Number(r.avg_da)])
    );

    // Format historical spot series
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const fmtLabel = (y: number, m: number) => `${MONTHS[m-1]} '${String(y).slice(2)}`;

    const historicalSpot = spotRows.rows.map(r => {
      const year = Number(r.year);
      const month = Number(r.month);
      const gasPrice = Number(r.avg_price);
      const powerPrice = powerMap.get(`${year}-${month}`);
      return {
        label:       fmtLabel(year, month),
        dateKey:     `${year}-${String(month).padStart(2,"0")}-01`,
        type:        "historical" as const,
        spotPrice:   gasPrice,
        powerPrice:  powerPrice ?? null,
        sparkSpread: powerPrice != null ? powerPrice - gasPrice * hr : null,
      };
    });

    // Use latest 3-month average power price as flat power forward proxy (for spark sensitivity)
    const recentPower = powerRows.rows.slice(-3);
    const avgPowerFwd = recentPower.length
      ? recentPower.reduce((sum, r) => sum + Number(r.avg_da), 0) / recentPower.length
      : null;

    // Format forward curve series — now includes syntheticPowerPrice per month
    const forwardStrip = rawCurveRows.map(r => {
      const d = new Date(r.delivery_month);
      const year  = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const gasPrice = Number(r.settle_price);

      // Synthetic power forward: gas × heat_rate, scaled by seasonal shape
      const seasonalMult = seasonalMap.get(month) ?? 1.0;
      const syntheticPowerPrice = gasPrice * hr * seasonalMult;

      return {
        label:        fmtLabel(year, month),
        dateKey:      r.delivery_month,
        type:         "forward" as const,
        forwardPrice: gasPrice,
        source:       r.source,
        syntheticPowerPrice: Math.round(syntheticPowerPrice * 100) / 100,
        seasonalMult: Math.round(seasonalMult * 1000) / 1000,
        // Sensitivity spark spreads (vs flat avgPowerFwd proxy)
        sparkBase:    null as number | null,
        sparkHigh:    null as number | null,
        sparkLow:     null as number | null,
      };
    });

    if (avgPowerFwd != null) {
      for (const row of forwardStrip) {
        const gasBase = row.forwardPrice;
        row.sparkBase = avgPowerFwd - gasBase * hr;
        row.sparkHigh = avgPowerFwd - (gasBase - 1) * hr;
        row.sparkLow  = avgPowerFwd - (gasBase + 1) * hr;
      }
    }

    // Contango/backwardation analysis
    let curveShape: "contango" | "backwardation" | "flat" = "flat";
    let curveSteepness = 0;
    if (forwardStrip.length >= 12) {
      const first6    = forwardStrip.slice(0, 6).map(r => r.forwardPrice);
      const last6     = forwardStrip.slice(-6).map(r => r.forwardPrice);
      const avgFirst6 = first6.reduce((a, b) => a + b, 0) / first6.length;
      const avgLast6  = last6.reduce((a, b) => a + b, 0) / last6.length;
      curveSteepness  = Math.round((avgLast6 - avgFirst6) * 100) / 100;
      curveShape      = curveSteepness > 0.10 ? "contango" : curveSteepness < -0.10 ? "backwardation" : "flat";
    }

    // Source breakdown for UI labeling
    const sourceCounts = forwardStrip.reduce<Record<string, number>>((acc, r) => {
      acc[r.source] = (acc[r.source] ?? 0) + 1;
      return acc;
    }, {});

    // Average synthetic power price across the full strip (used by PPA calculator)
    const avgSyntheticPowerFwd = forwardStrip.length
      ? Math.round(forwardStrip.reduce((s, r) => s + r.syntheticPowerPrice, 0) / forwardStrip.length * 100) / 100
      : null;

    // Latest spot for display
    const latestSpot     = spotRows.rows.at(-1);
    const promptMonthFwd = forwardStrip[0] ?? null;

    res.json({
      asOfDate:              rawCurveRows[0]?.as_of_date ?? null,
      node,
      heatRate:              hr,
      latestSpot:            latestSpot ? Number(latestSpot.avg_price) : null,
      promptForward:         promptMonthFwd ? promptMonthFwd.forwardPrice : null,
      avgPowerFwd,
      avgSyntheticPowerFwd,
      curveShape,
      curveSteepness,
      sourceCounts,
      historicalSpot,
      forwardStrip,
    });
  } catch (err) {
    req.log.error({ err }, "forward-curve error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Upload Bloomberg / CME gas forward strip ───────────────────────────────
//
// POST /api/gas-prices/forward-curve/upload
// Body: { rows: [{deliveryMonth: "YYYY-MM-DD", settlePrice: number}], source?: string }
// Upserts into gas_forwards with as_of_date = today, source = 'user_csv'

router.post("/gas-prices/forward-curve/upload", async (req, res) => {
  try {
    const rows = req.body?.rows as Array<{ deliveryMonth: string; settlePrice: number }> | undefined;
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: "bad_request", message: "rows array required" });
      return;
    }

    // Validate each row
    const clean: { deliveryMonth: string; settlePrice: number }[] = [];
    for (const r of rows) {
      if (!r.deliveryMonth || typeof r.settlePrice !== "number" || isNaN(r.settlePrice)) continue;
      // Normalise to YYYY-MM-01
      const d = new Date(r.deliveryMonth);
      if (isNaN(d.getTime())) continue;
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
      if (r.settlePrice <= 0 || r.settlePrice > 50) continue; // sanity bounds for gas $/MMBtu
      clean.push({ deliveryMonth: month, settlePrice: r.settlePrice });
    }

    if (clean.length === 0) {
      res.status(400).json({ error: "bad_request", message: "No valid rows found after parsing" });
      return;
    }

    const asOfDate = new Date().toISOString().slice(0, 10);
    const source   = (req.body?.source as string | undefined) ?? "user_csv";

    // Upsert each row
    let upserted = 0;
    for (const row of clean) {
      await db.execute(sql`
        INSERT INTO gas_forwards (as_of_date, delivery_month, settle_price, source)
        VALUES (${asOfDate}::date, ${row.deliveryMonth}::date, ${row.settlePrice}, ${source})
        ON CONFLICT (as_of_date, delivery_month)
        DO UPDATE SET settle_price = EXCLUDED.settle_price, source = EXCLUDED.source, fetched_at = NOW()
      `);
      upserted++;
    }

    res.json({ ok: true, upserted, asOfDate, source });
  } catch (err) {
    req.log.error({ err }, "forward-curve/upload error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
