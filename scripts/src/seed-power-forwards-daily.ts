/**
 * Shape monthly power forwards (power_forwards) into daily prices.
 *
 * Methodology — MONTH × WEEKDAY (revised 2026-08-02):
 *   1. Pull real 2025 hourly DA settlement prices at the same hub the monthly
 *      forward represents (HB_NORTH for ERCOT, SP15 for CAISO).
 *   2. Collapse to one average price per calendar day of 2025.
 *   3. For each (calendar month, weekday) pair, average those daily prices —
 *      e.g. "all Mondays in January 2025". 12 × 7 = up to 84 buckets.
 *   4. shape_factor(month, weekday) = bucket avg / that month's overall daily avg.
 *   5. For every future delivery month in power_forwards, each day looks up the
 *      factor for its OWN weekday in that calendar month, so a Saturday in
 *      Sep 2026 gets Sep 2025's Saturday behaviour.
 *   6. Renormalise each delivery month so the calendar-day mean factor is
 *      exactly 1.0 — the shaped daily series must average back to the monthly
 *      forward or the contract's value changes.
 *
 * Why weekday and not day-of-month position: the first version mapped day N of
 * a future month to day N of the 2025 month. That is value-correct but
 * misaligns the weekly cycle, because 2025's calendar puts weekends on
 * different dates than 2026's — it produced Sundays priced above the following
 * Monday. Weekday matching is what actually drives the daily power shape.
 *
 * Run: pnpm --filter @workspace/scripts seed-power-forwards-daily
 * (run seed-power-forwards first — this reads its output)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const REFERENCE: Record<string, { node: string; table: "ercot_hub_hourly" | "caiso_hub_hourly" }> = {
  ERCOT: { node: "HB_NORTH", table: "ercot_hub_hourly" },
  // Node names are the values as STORED in the hourly tables, which are NOT the
  // source API's identifiers (CAISO OASIS calls this TH_SP15_GEN-APND;
  // seed-caiso-hourly stores plain "SP15"). Verified against the live tables.
  CAISO: { node: "SP15", table: "caiso_hub_hourly" },
};

const SHAPE_YEAR = 2025;
const DOW_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** month (1-12) → weekday (0=Sun..6=Sat) → factor */
type ShapeMap = Map<number, Map<number, number>>;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

async function buildShapeFactors(market: string): Promise<ShapeMap> {
  const { node, table } = REFERENCE[market];

  const rows = await db.execute<{ d: string; avg_price: string }>(sql`
    SELECT make_date(year, month, day)::text AS d, AVG(da_price)::float8 AS avg_price
    FROM ${sql.raw(table)}
    WHERE node = ${node} AND year = ${SHAPE_YEAR} AND da_price IS NOT NULL
    GROUP BY year, month, day
    ORDER BY 1
  `);

  if (!rows.rows.length) {
    throw new Error(
      `No ${SHAPE_YEAR} hourly DA data for ${market} node ${node} in ${table} — seed real hourly data first`,
    );
  }

  const byMonth = new Map<number, number[]>();
  const byMonthDow = new Map<number, Map<number, number[]>>();

  for (const r of rows.rows) {
    const dt = new Date(`${r.d}T00:00:00Z`);
    const month = dt.getUTCMonth() + 1;
    const dow = dt.getUTCDay();
    const price = Number(r.avg_price);

    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(price);

    if (!byMonthDow.has(month)) byMonthDow.set(month, new Map());
    const dowMap = byMonthDow.get(month)!;
    if (!dowMap.has(dow)) dowMap.set(dow, []);
    dowMap.get(dow)!.push(price);
  }

  const shape: ShapeMap = new Map();
  for (const [month, dowMap] of byMonthDow) {
    const monthAvg = mean(byMonth.get(month)!);
    if (!monthAvg) continue;
    const out = new Map<number, number>();
    for (const [dow, prices] of dowMap) out.set(dow, mean(prices) / monthAvg);
    shape.set(month, out);
  }

  console.log(
    `  [${market}] shape from ${rows.rows.length} real ${SHAPE_YEAR} daily prices (node ${node}), ` +
      `${shape.size} months × weekday buckets`,
  );
  return shape;
}

/**
 * Look up the factor for a weekday, falling back to the nearest weekday that
 * has data (power hubs settle every day so this should never fire, but a gap
 * in the source year must not silently become a zero price).
 */
function factorFor(shape: ShapeMap, month: number, dow: number): number {
  const dowMap = shape.get(month);
  if (!dowMap || dowMap.size === 0) return 1.0;
  const exact = dowMap.get(dow);
  if (exact !== undefined) return exact;
  for (let offset = 1; offset <= 6; offset++) {
    const back = dowMap.get((dow - offset + 7) % 7);
    if (back !== undefined) return back;
    const fwd = dowMap.get((dow + offset) % 7);
    if (fwd !== undefined) return fwd;
  }
  return 1.0;
}

async function main() {
  console.log("=== Power Forwards Daily Shaping (month × weekday) ===\n");

  for (const market of Object.keys(REFERENCE)) {
    console.log(`[${market}]`);
    const shape = await buildShapeFactors(market);

    // Show the weekday profile so the shape is inspectable, not a black box.
    const sample = shape.get(9) ?? shape.get(1);
    if (sample) {
      const label = shape.has(9) ? "Sep" : "Jan";
      const parts = [...sample.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([dow, f]) => `${DOW_NAME[dow]} ${f.toFixed(3)}`);
      console.log(`  ${label} ${SHAPE_YEAR} weekday profile: ${parts.join("  ")}`);
    }

    const fwdRows = await db.execute<{ as_of_date: string; delivery_month: string; price_mwh: string }>(sql`
      SELECT as_of_date::text, delivery_month::text, price_mwh::float8 AS price_mwh
      FROM power_forwards
      WHERE market = ${market}
        AND as_of_date = (SELECT MAX(as_of_date) FROM power_forwards WHERE market = ${market})
        AND price_mwh IS NOT NULL
      ORDER BY delivery_month ASC
    `);

    if (!fwdRows.rows.length) {
      console.warn(`  ✗ no power_forwards rows for ${market} — run seed-power-forwards first, skipping\n`);
      continue;
    }

    const asOfDate = fwdRows.rows[0].as_of_date;
    const dailyOut: Array<{ deliveryDate: string; priceMwh: number; monthlyForwardPriceMwh: number; shapeFactor: number }> = [];

    for (const row of fwdRows.rows) {
      const [y, m] = row.delivery_month.split("-").map(Number);
      const monthlyPrice = Number(row.price_mwh);
      const nDays = daysInMonth(y, m);

      // Factor per day using that day's ACTUAL weekday in the delivery year,
      // then rescale so the calendar-day mean is exactly 1.0 for this month.
      const raw: number[] = [];
      for (let d = 1; d <= nDays; d++) {
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        raw.push(factorFor(shape, m, dow));
      }
      const mu = mean(raw);
      const norm = mu > 0 ? raw.map((f) => f / mu) : raw.map(() => 1);

      for (let d = 1; d <= nDays; d++) {
        const factor = norm[d - 1];
        dailyOut.push({
          deliveryDate: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
          priceMwh: Math.round(monthlyPrice * factor * 10000) / 10000,
          monthlyForwardPriceMwh: monthlyPrice,
          shapeFactor: Math.round(factor * 100000) / 100000,
        });
      }
    }

    const { node } = REFERENCE[market];
    const PAGE = 500;
    let total = 0;
    for (let i = 0; i < dailyOut.length; i += PAGE) {
      const chunk = dailyOut.slice(i, i + PAGE);
      await db.execute(sql`
        INSERT INTO power_forwards_daily
          (market, as_of_date, delivery_date, price_mwh, monthly_forward_price_mwh, shape_factor, reference_node, shape_year)
        VALUES ${sql.raw(
          chunk.map((r) =>
            `('${market}', '${asOfDate}', '${r.deliveryDate}', ${r.priceMwh}, ${r.monthlyForwardPriceMwh}, ${r.shapeFactor}, '${node}', ${SHAPE_YEAR})`,
          ).join(", "),
        )}
        ON CONFLICT (market, as_of_date, delivery_date) DO UPDATE SET
          price_mwh                 = EXCLUDED.price_mwh,
          monthly_forward_price_mwh = EXCLUDED.monthly_forward_price_mwh,
          shape_factor               = EXCLUDED.shape_factor,
          reference_node             = EXCLUDED.reference_node,
          shape_year                 = EXCLUDED.shape_year,
          created_at                 = now()
      `);
      total += chunk.length;
    }
    console.log(`  ✓ upserted ${total} daily rows across ${fwdRows.rows.length} months (as_of ${asOfDate})\n`);
  }

  const summary = await db.execute<{ market: string; n: string; lo: string; hi: string; min_p: string; max_p: string }>(sql`
    SELECT market, COUNT(*)::text AS n, MIN(delivery_date)::text AS lo, MAX(delivery_date)::text AS hi,
           MIN(price_mwh)::text AS min_p, MAX(price_mwh)::text AS max_p
    FROM power_forwards_daily
    GROUP BY market
  `);
  console.log("=== Summary ===");
  for (const r of summary.rows) console.log(`  ${r.market}: ${r.n} days, ${r.lo} → ${r.hi}, $${r.min_p}–$${r.max_p}/MWh`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
