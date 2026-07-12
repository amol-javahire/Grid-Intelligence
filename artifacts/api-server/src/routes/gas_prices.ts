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

    // Monthly average DA power price for selected ERCOT node (last 30 months + all available)
    const powerRows = await db.execute<{
      year: string; month: string; avg_da: string;
    }>(sql`
      SELECT year, month, AVG(avg_da_price)::float8 AS avg_da
      FROM ercot_node_stats
      WHERE node = ${node} AND avg_da_price IS NOT NULL
      GROUP BY year, month
      ORDER BY year, month
    `);

    // Build power map
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

    // Format forward curve series
    const forwardStrip = curveRows.rows.map(r => {
      const d = new Date(r.delivery_month);
      const year  = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const gasPrice = Number(r.settle_price);
      // For future months we don't have historical power — use latest available power avg
      // as baseline and apply seasonal adjustment
      return {
        label:        fmtLabel(year, month),
        dateKey:      r.delivery_month,
        type:         "forward" as const,
        forwardPrice: gasPrice,
        source:       r.source,
        // Sensitivity: base, +$1, -$1
        sparkBase:    null as number | null,  // filled below if power data available
        sparkHigh:    null as number | null,  // gas +$1
        sparkLow:     null as number | null,  // gas -$1
      };
    });

    // Use the latest 3-month average power price as forward power proxy
    const recentPower = powerRows.rows.slice(-3);
    const avgPowerFwd = recentPower.length
      ? recentPower.reduce((sum, r) => sum + Number(r.avg_da), 0) / recentPower.length
      : null;

    if (avgPowerFwd != null) {
      for (const row of forwardStrip) {
        const gasBase = row.forwardPrice;
        row.sparkBase = avgPowerFwd - gasBase * hr;
        // sparkHigh = gas -$1/MMBtu scenario → higher spark spread (bull)
        row.sparkHigh = avgPowerFwd - (gasBase - 1) * hr;
        // sparkLow  = gas +$1/MMBtu scenario → lower spark spread (bear)
        row.sparkLow  = avgPowerFwd - (gasBase + 1) * hr;
      }
    }

    // Contango/backwardation analysis — guard against empty strip
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

    // Latest spot for display
    const latestSpot     = spotRows.rows.at(-1);
    const promptMonthFwd = forwardStrip[0] ?? null;

    res.json({
      asOfDate:        curveRows.rows[0]?.as_of_date ?? null,
      node,
      heatRate:        hr,
      latestSpot:      latestSpot ? Number(latestSpot.avg_price) : null,
      promptForward:   promptMonthFwd ? promptMonthFwd.forwardPrice : null,
      avgPowerFwd,
      curveShape,
      curveSteepness,
      sourceCounts,
      historicalSpot,
      forwardStrip:    forwardStrip,
    });
  } catch (err) {
    req.log.error({ err }, "forward-curve error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
