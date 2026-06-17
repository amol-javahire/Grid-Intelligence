import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

function riskScore(absAvgBasis: number, basisStddev: number, congPct: number, negPct: number): number {
  const absNorm  = Math.min(1, absAvgBasis / 50);
  const volNorm  = Math.min(1, basisStddev / 30);
  const congNorm = Math.min(1, congPct);
  const negNorm  = Math.min(1, negPct / 20);
  return Math.round((0.40 * absNorm + 0.25 * volNorm + 0.25 * congNorm + 0.10 * negNorm) * 100);
}

// ── Overview ─────────────────────────────────────────────────────────────────
router.get("/congestion-intel/overview", async (req, res) => {
  try {
    const threshold = Number(req.query.threshold ?? 10);
    const severe    = Number(req.query.severe    ?? 25);
    const extreme   = Number(req.query.extreme   ?? 50);

    const [sumRows, monthRows] = await Promise.all([
      db.execute<{
        resource_nodes: string; hub_zone_nodes: string; total_records: string;
        congestion_events: string; severe_events: string; extreme_events: string;
        neg_price_months: string; min_period: string; max_period: string;
      }>(sql`
        SELECT
          COUNT(DISTINCT node) FILTER (WHERE node_type = 'resource_node')   AS resource_nodes,
          COUNT(DISTINCT node) FILTER (WHERE node_type != 'resource_node')  AS hub_zone_nodes,
          COUNT(*)                                                            AS total_records,
          COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
            AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > ${threshold})  AS congestion_events,
          COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
            AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > ${severe})     AS severe_events,
          COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
            AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > ${extreme})    AS extreme_events,
          COUNT(*) FILTER (WHERE avg_rt_price::numeric < 0 OR avg_da_price::numeric < 0) AS neg_price_months,
          MIN(year::text || '-' || LPAD(month::text, 2, '0'))               AS min_period,
          MAX(year::text || '-' || LPAD(month::text, 2, '0'))               AS max_period
        FROM ercot_node_stats
      `),
      db.execute<{
        year: number; month: number;
        avg_basis: string; congestion_count: string; severe_count: string;
        extreme_count: string; rt_count: string;
      }>(sql`
        SELECT
          year, month,
          ROUND(AVG(avg_rt_price::numeric - avg_da_price::numeric)
            FILTER (WHERE avg_rt_price IS NOT NULL), 2)                        AS avg_basis,
          COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
            AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > ${threshold}) AS congestion_count,
          COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
            AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > ${severe})    AS severe_count,
          COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
            AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > ${extreme})   AS extreme_count,
          COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL)                         AS rt_count
        FROM ercot_node_stats
        GROUP BY year, month
        ORDER BY year, month
      `),
    ]);

    const s = sumRows.rows[0];
    res.json({
      resourceNodes:    Number(s.resource_nodes),
      hubZoneNodes:     Number(s.hub_zone_nodes),
      totalRecords:     Number(s.total_records),
      congestionEvents: Number(s.congestion_events),
      severeEvents:     Number(s.severe_events),
      extremeEvents:    Number(s.extreme_events),
      negPriceMonths:   Number(s.neg_price_months),
      minPeriod: s.min_period,
      maxPeriod: s.max_period,
      monthly: monthRows.rows.map(r => ({
        year:            Number(r.year),
        month:           Number(r.month),
        avgBasis:        r.avg_basis ? Number(r.avg_basis) : null,
        congestionCount: Number(r.congestion_count),
        severeCount:     Number(r.severe_count),
        extremeCount:    Number(r.extreme_count),
        rtCount:         Number(r.rt_count),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "congestion-intel/overview error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Heatmap ──────────────────────────────────────────────────────────────────
router.get("/congestion-intel/heatmap", async (req, res) => {
  try {
    const nodeType = req.query.nodeType as string | undefined;
    const limitN   = Math.min(Number(req.query.limit ?? 2000), 2000);
    const offsetN  = Number(req.query.offset ?? 0);

    const rows = await db.execute<{
      node: string; node_type: string;
      rt_months: string; total_months: string;
      avg_da: string; avg_rt: string;
      avg_basis: string; abs_avg_basis: string; basis_stddev: string; max_abs_basis: string;
      congestion_months: string; severe_months: string;
      avg_volatility: string; avg_neg_pct: string;
    }>(sql`
      SELECT
        node, node_type,
        COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL)     AS rt_months,
        COUNT(*)                                              AS total_months,
        ROUND(AVG(avg_da_price::numeric), 2)                  AS avg_da,
        ROUND(AVG(avg_rt_price::numeric)  FILTER (WHERE avg_rt_price IS NOT NULL), 2) AS avg_rt,
        ROUND(AVG(avg_rt_price::numeric  - avg_da_price::numeric)
              FILTER (WHERE avg_rt_price IS NOT NULL), 2)     AS avg_basis,
        ROUND(AVG(ABS(avg_rt_price::numeric - avg_da_price::numeric))
              FILTER (WHERE avg_rt_price IS NOT NULL), 2)     AS abs_avg_basis,
        ROUND(COALESCE(STDDEV(avg_rt_price::numeric - avg_da_price::numeric)
              FILTER (WHERE avg_rt_price IS NOT NULL), 0), 2) AS basis_stddev,
        ROUND(COALESCE(MAX(ABS(avg_rt_price::numeric - avg_da_price::numeric))
              FILTER (WHERE avg_rt_price IS NOT NULL), 0), 2) AS max_abs_basis,
        COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
          AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > 10) AS congestion_months,
        COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL
          AND ABS(avg_rt_price::numeric - avg_da_price::numeric) > 25) AS severe_months,
        ROUND(COALESCE(AVG(volatility::numeric)        FILTER (WHERE volatility IS NOT NULL), 0), 2)          AS avg_volatility,
        ROUND(COALESCE(AVG(neg_price_percent::numeric) FILTER (WHERE neg_price_percent IS NOT NULL), 0), 2)   AS avg_neg_pct
      FROM ercot_node_stats
      ${nodeType ? sql`WHERE node_type = ${nodeType}` : sql``}
      GROUP BY node, node_type
      ORDER BY abs_avg_basis DESC NULLS LAST
      LIMIT ${limitN} OFFSET ${offsetN}
    `);

    const results = rows.rows.map(r => {
      const abs = Number(r.abs_avg_basis ?? 0);
      const std = Number(r.basis_stddev ?? 0);
      const rtM = Number(r.rt_months ?? 0);
      const totM = Number(r.total_months ?? 1);
      const congPct = rtM > 0 ? Number(r.congestion_months) / rtM : 0;
      const negPct = Number(r.avg_neg_pct ?? 0);
      return {
        node: r.node, nodeType: r.node_type,
        rtMonths: rtM, totalMonths: totM,
        avgDa: Number(r.avg_da ?? 0), avgRt: Number(r.avg_rt ?? 0),
        avgBasis: Number(r.avg_basis ?? 0),
        absAvgBasis: abs, basisStddev: std,
        maxAbsBasis: Number(r.max_abs_basis ?? 0),
        congestionMonths: Number(r.congestion_months), severeMonths: Number(r.severe_months),
        congestionPct: Math.round(congPct * 100),
        avgVolatility: Number(r.avg_volatility ?? 0),
        avgNegPct: negPct,
        riskScore: riskScore(abs, std, congPct, negPct),
      };
    });

    res.json(results);
  } catch (err) {
    req.log.error({ err }, "congestion-intel/heatmap error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Node series ──────────────────────────────────────────────────────────────
router.get("/congestion-intel/node-series", async (req, res) => {
  try {
    const node = req.query.node as string;
    if (!node) { res.status(400).json({ error: "node required" }); return; }

    const rows = await db.execute<{
      year: number; month: number;
      avg_da_price: string; avg_rt_price: string;
      volatility: string; neg_price_percent: string;
      min_price: string; max_price: string;
      on_peak_avg: string; off_peak_avg: string;
    }>(sql`
      SELECT year, month, avg_da_price, avg_rt_price, volatility, neg_price_percent,
             min_price, max_price, on_peak_avg, off_peak_avg
      FROM ercot_node_stats
      WHERE node = ${node}
      ORDER BY year, month
    `);

    res.json(rows.rows.map(r => ({
      year: Number(r.year), month: Number(r.month),
      avgDa: Number(r.avg_da_price),
      avgRt: r.avg_rt_price ? Number(r.avg_rt_price) : null,
      basis: r.avg_rt_price ? Number(r.avg_rt_price) - Number(r.avg_da_price) : null,
      volatility: r.volatility ? Number(r.volatility) : null,
      negPricePct: r.neg_price_percent ? Number(r.neg_price_percent) : null,
      minPrice: r.min_price ? Number(r.min_price) : null,
      maxPrice: r.max_price ? Number(r.max_price) : null,
      onPeakAvg: r.on_peak_avg ? Number(r.on_peak_avg) : null,
      offPeakAvg: r.off_peak_avg ? Number(r.off_peak_avg) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "congestion-intel/node-series error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Basis compare ────────────────────────────────────────────────────────────
router.get("/congestion-intel/basis-compare", async (req, res) => {
  try {
    const nodeA = req.query.nodeA as string;
    const nodeB = req.query.nodeB as string;
    if (!nodeA || !nodeB) { res.status(400).json({ error: "nodeA and nodeB required" }); return; }

    const rows = await db.execute<{
      node: string; year: number; month: number;
      avg_da_price: string; avg_rt_price: string;
    }>(sql`
      SELECT node, year, month, avg_da_price, avg_rt_price
      FROM ercot_node_stats
      WHERE node IN (${nodeA}, ${nodeB}) AND avg_rt_price IS NOT NULL
      ORDER BY node, year, month
    `);

    const seriesMap: Record<string, { year: number; month: number; basis: number; da: number; rt: number }[]> = {};
    rows.rows.forEach(r => {
      if (!seriesMap[r.node]) seriesMap[r.node] = [];
      const basis = Number(r.avg_rt_price) - Number(r.avg_da_price);
      seriesMap[r.node].push({ year: Number(r.year), month: Number(r.month), basis, da: Number(r.avg_da_price), rt: Number(r.avg_rt_price) });
    });

    // Compute stats per node
    const statsFor = (node: string) => {
      const s = seriesMap[node] ?? [];
      if (!s.length) return null;
      const bases = s.map(r => r.basis).sort((a, b) => a - b);
      const mean = bases.reduce((a, b) => a + b, 0) / bases.length;
      const p5 = bases[Math.floor(bases.length * 0.05)];
      const p95 = bases[Math.floor(bases.length * 0.95)];
      const stddev = Math.sqrt(bases.reduce((a, b) => a + (b - mean) ** 2, 0) / bases.length);
      return {
        mean: Math.round(mean * 100) / 100,
        median: Math.round(bases[Math.floor(bases.length / 2)] * 100) / 100,
        p5: Math.round(p5 * 100) / 100,
        p95: Math.round(p95 * 100) / 100,
        stddev: Math.round(stddev * 100) / 100,
        min: Math.round(bases[0] * 100) / 100,
        max: Math.round(bases[bases.length - 1] * 100) / 100,
        negFreq: Math.round(bases.filter(b => b < 0).length / bases.length * 100),
        congFreq: Math.round(bases.filter(b => Math.abs(b) > 10).length / bases.length * 100),
        months: s.length,
      };
    };

    // Correlation (Pearson) on aligned months
    const aMap = new Map((seriesMap[nodeA] ?? []).map(r => [`${r.year}-${r.month}`, r.basis]));
    const bMap = new Map((seriesMap[nodeB] ?? []).map(r => [`${r.year}-${r.month}`, r.basis]));
    const keys = [...aMap.keys()].filter(k => bMap.has(k));
    let correlation = null;
    if (keys.length >= 3) {
      const aVals = keys.map(k => aMap.get(k)!);
      const bVals = keys.map(k => bMap.get(k)!);
      const aMean = aVals.reduce((s, v) => s + v, 0) / aVals.length;
      const bMean = bVals.reduce((s, v) => s + v, 0) / bVals.length;
      const cov = aVals.reduce((s, v, i) => s + (v - aMean) * (bVals[i] - bMean), 0) / aVals.length;
      const aStd = Math.sqrt(aVals.reduce((s, v) => s + (v - aMean) ** 2, 0) / aVals.length);
      const bStd = Math.sqrt(bVals.reduce((s, v) => s + (v - bMean) ** 2, 0) / bVals.length);
      correlation = aStd > 0 && bStd > 0 ? Math.round((cov / (aStd * bStd)) * 1000) / 1000 : null;
    }

    res.json({
      nodeA, nodeB, correlation, alignedMonths: keys.length,
      statsA: statsFor(nodeA), statsB: statsFor(nodeB),
      seriesA: seriesMap[nodeA] ?? [],
      seriesB: seriesMap[nodeB] ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "congestion-intel/basis-compare error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Backtest (dynamic year) ───────────────────────────────────────────────────
router.get("/congestion-intel/backtest", async (req, res) => {
  try {
    const threshold = Number(req.query.threshold ?? 10);

    // Find the most recent year with RT data — works regardless of what years are in the DB
    const boundsRes = await db.execute<{ test_year: string }>(sql`
      SELECT MAX(year) AS test_year FROM ercot_node_stats WHERE avg_rt_price IS NOT NULL
    `);
    const testYear = Number(boundsRes.rows[0]?.test_year ?? 2026);
    const trainY1  = testYear - 2;
    const trainY2  = testYear - 1;

    const rows = await db.execute<{
      node: string; node_type: string; month: number;
      predicted_basis: string; actual_basis: string;
      error: string; abs_error: string;
    }>(sql`
      WITH training AS (
        SELECT node, month,
          AVG(avg_rt_price::numeric - avg_da_price::numeric) AS predicted_basis
        FROM ercot_node_stats
        WHERE year IN (${trainY1}, ${trainY2}) AND avg_rt_price IS NOT NULL
        GROUP BY node, month
      ),
      actuals AS (
        SELECT e.node, e.month,
          (e.avg_rt_price::numeric - e.avg_da_price::numeric) AS actual_basis
        FROM ercot_node_stats e
        WHERE e.year = ${testYear} AND e.avg_rt_price IS NOT NULL
      ),
      bt AS (
        SELECT
          a.node,
          n.node_type,
          a.month,
          ROUND(t.predicted_basis::numeric, 2)                                AS predicted_basis,
          ROUND(a.actual_basis::numeric, 2)                                   AS actual_basis,
          ROUND(a.actual_basis::numeric - t.predicted_basis::numeric, 2)     AS error,
          ROUND(ABS(a.actual_basis::numeric - t.predicted_basis::numeric), 2) AS abs_error
        FROM actuals a
        JOIN training t ON a.node = t.node AND a.month = t.month
        JOIN (SELECT DISTINCT node, node_type FROM ercot_node_stats) n ON a.node = n.node
      )
      SELECT * FROM bt ORDER BY abs_error DESC
    `);

    const all = rows.rows.map(r => ({
      node: r.node, nodeType: r.node_type, month: Number(r.month),
      predicted: Number(r.predicted_basis),
      actual: Number(r.actual_basis),
      error: Number(r.error),
      absError: Number(r.abs_error),
      directionalMatch: Math.sign(Number(r.actual_basis)) === Math.sign(Number(r.predicted_basis)),
      actualCongestion: Math.abs(Number(r.actual_basis)) > threshold,
      predictedCongestion: Math.abs(Number(r.predicted_basis)) > threshold,
    }));

    if (!all.length) {
      res.json({ n: 0, testYear, trainingPeriod: `${trainY1}–${trainY2}`, testPeriod: `Year ${testYear}`, records: [] });
      return;
    }

    const mae  = all.reduce((s, r) => s + r.absError, 0) / all.length;
    const rmse = Math.sqrt(all.reduce((s, r) => s + r.error ** 2, 0) / all.length);
    const dirAcc = all.filter(r => r.directionalMatch).length / all.length;

    const tp = all.filter(r => r.actualCongestion && r.predictedCongestion).length;
    const fp = all.filter(r => !r.actualCongestion && r.predictedCongestion).length;
    const fn = all.filter(r => r.actualCongestion && !r.predictedCongestion).length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall    = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

    // Per-node MAE summary (top/bottom performers)
    const nodeMap: Record<string, number[]> = {};
    all.forEach(r => { if (!nodeMap[r.node]) nodeMap[r.node] = []; nodeMap[r.node].push(r.absError); });
    const nodeMAE = Object.entries(nodeMap)
      .map(([node, errs]) => ({ node, mae: Math.round(errs.reduce((s, v) => s + v, 0) / errs.length * 100) / 100, n: errs.length }))
      .sort((a, b) => a.mae - b.mae);

    // By month
    const monthMap: Record<number, number[]> = {};
    all.forEach(r => { if (!monthMap[r.month]) monthMap[r.month] = []; monthMap[r.month].push(r.absError); });
    const byMonth = Object.entries(monthMap)
      .map(([m, errs]) => ({ month: Number(m), mae: Math.round(errs.reduce((s, v) => s + v, 0) / errs.length * 100) / 100, n: errs.length }))
      .sort((a, b) => a.month - b.month);

    res.json({
      n: all.length,
      testYear,
      trainingPeriod: `${trainY1}–${trainY2}`,
      testPeriod: `Year ${testYear}`,
      mae:   Math.round(mae  * 100) / 100,
      rmse:  Math.round(rmse * 100) / 100,
      dirAcc: Math.round(dirAcc * 1000) / 10,
      precision: Math.round(precision * 1000) / 10,
      recall:    Math.round(recall    * 1000) / 10,
      f1:        Math.round(f1        * 1000) / 10,
      tp, fp, fn,
      nodeMAETop10:    nodeMAE.slice(0, 10),
      nodeMAEBottom10: nodeMAE.slice(-10).reverse(),
      byMonth,
      // Full scatter data (sample 2000 max for performance)
      scatter: all.slice(0, 2000).map(r => ({ predicted: r.predicted, actual: r.actual, nodeType: r.nodeType })),
    });
  } catch (err) {
    req.log.error({ err }, "congestion-intel/backtest error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Data quality ─────────────────────────────────────────────────────────────
router.get("/congestion-intel/data-quality", async (req, res) => {
  try {
    const rows = await db.execute<{
      year: number; node_type: string;
      unique_nodes: string; total_records: string;
      rt_records: string; vol_records: string; neg_records: string;
    }>(sql`
      SELECT
        year, node_type,
        COUNT(DISTINCT node)                                  AS unique_nodes,
        COUNT(*)                                              AS total_records,
        COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL)      AS rt_records,
        COUNT(*) FILTER (WHERE volatility IS NOT NULL)        AS vol_records,
        COUNT(*) FILTER (WHERE neg_price_percent IS NOT NULL) AS neg_records
      FROM ercot_node_stats
      GROUP BY year, node_type
      ORDER BY year, node_type
    `);

    const totals = await db.execute<{
      unique_nodes: string; total_records: string; rt_records: string;
      min_period: string; max_period: string;
    }>(sql`
      SELECT
        COUNT(DISTINCT node)                             AS unique_nodes,
        COUNT(*)                                         AS total_records,
        COUNT(*) FILTER (WHERE avg_rt_price IS NOT NULL) AS rt_records,
        MIN(year::text || '-' || LPAD(month::text,2,'0')) AS min_period,
        MAX(year::text || '-' || LPAD(month::text,2,'0')) AS max_period
      FROM ercot_node_stats
    `);

    const t = totals.rows[0];
    res.json({
      totalNodes: Number(t.unique_nodes),
      totalRecords: Number(t.total_records),
      rtRecords: Number(t.rt_records),
      minPeriod: t.min_period,
      maxPeriod: t.max_period,
      rtCompleteness: Math.round(Number(t.rt_records) / Number(t.total_records) * 1000) / 10,
      byYearAndType: rows.rows.map(r => ({
        year: Number(r.year), nodeType: r.node_type,
        uniqueNodes: Number(r.unique_nodes), totalRecords: Number(r.total_records),
        rtRecords: Number(r.rt_records), volRecords: Number(r.vol_records),
        negRecords: Number(r.neg_records),
        rtPct: Math.round(Number(r.rt_records) / Number(r.total_records) * 1000) / 10,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "congestion-intel/data-quality error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── Node list (for dropdowns) ────────────────────────────────────────────────
router.get("/congestion-intel/node-list", async (req, res) => {
  try {
    const nodeType = req.query.nodeType as string | undefined;
    const rows = await db.execute<{ node: string; node_type: string }>(sql`
      SELECT DISTINCT node, node_type
      FROM ercot_node_stats
      ${nodeType ? sql`WHERE node_type = ${nodeType}` : sql``}
      ORDER BY node_type, node
    `);
    res.json(rows.rows);
  } catch (err) {
    req.log.error({ err }, "congestion-intel/node-list error");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
