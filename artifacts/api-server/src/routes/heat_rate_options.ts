import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

router.get("/heat-rate-options/market-data", async (req, res) => {
  try {
    // Monthly Henry Hub gas prices (average of daily)
    const gasRows = await db.execute<{ year_month: string; avg_gas: string }>(sql`
      SELECT
        TO_CHAR(date_trunc('month', date), 'YYYY-MM') AS year_month,
        ROUND(AVG(price)::numeric, 4)                 AS avg_gas
      FROM gas_prices
      WHERE price > 0
      GROUP BY date_trunc('month', date)
      ORDER BY date_trunc('month', date)
    `);

    // Monthly ERCOT hub DA + RT prices + volatility
    const powerRows = await db.execute<{
      year_month: string; node: string;
      avg_da: string; avg_rt: string; volatility: string | null;
    }>(sql`
      SELECT
        year::text || '-' || LPAD(month::text, 2, '0') AS year_month,
        node,
        ROUND(avg_da_price::numeric, 4)                AS avg_da,
        ROUND(COALESCE(avg_rt_price, avg_da_price)::numeric, 4) AS avg_rt,
        ROUND(volatility::numeric, 4)                  AS volatility
      FROM ercot_node_stats
      WHERE node_type = 'hub'
        AND avg_da_price IS NOT NULL
      ORDER BY year_month, node
    `);

    const hubs = [...new Set(powerRows.rows.map(r => r.node))].sort();

    // Index gas by month
    const gasByMonth: Record<string, number> = {};
    for (const r of gasRows.rows) gasByMonth[r.year_month] = Number(r.avg_gas);

    // Index power by [month][hub]
    type HubPriceEntry = { da: number; rt: number; vol: number | null };
    const powerByMonthHub: Record<string, Record<string, HubPriceEntry>> = {};
    for (const r of powerRows.rows) {
      if (!powerByMonthHub[r.year_month]) powerByMonthHub[r.year_month] = {};
      powerByMonthHub[r.year_month][r.node] = {
        da: Number(r.avg_da),
        rt: Number(r.avg_rt),
        vol: r.volatility !== null ? Number(r.volatility) : null,
      };
    }

    // Combined monthly rows (only months with both gas & at least one hub)
    const allMonths = [...new Set([
      ...Object.keys(gasByMonth),
      ...Object.keys(powerByMonthHub),
    ])].sort();

    const monthly = allMonths
      .filter(m => gasByMonth[m] != null && powerByMonthHub[m] != null)
      .map(m => ({
        yearMonth: m,
        gasPriceMmbtu: gasByMonth[m],
        hubs: powerByMonthHub[m] ?? {},
      }));

    // Per-hub historical spark-spread volatility at HR = 9.0
    const REFERENCE_HR = 9.0;
    const hubVol: Record<string, number> = {};
    for (const hub of hubs) {
      const spreads = monthly
        .filter(m => m.hubs[hub])
        .map(m => m.hubs[hub].da - REFERENCE_HR * m.gasPriceMmbtu);
      if (spreads.length >= 3) {
        const diffs = spreads.slice(1).map((v, i) => v - spreads[i]);
        const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const variance =
          diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1);
        // Annualise from monthly standard deviation
        hubVol[hub] = Math.round(Math.sqrt(variance * 12) * 100) / 100;
      }
    }

    return res.json({ hubs, monthly, hubVol });
  } catch (err) {
    req.log.error({ err }, "heat-rate-options/market-data error");
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
