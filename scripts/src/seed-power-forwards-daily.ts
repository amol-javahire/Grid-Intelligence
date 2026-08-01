/**
 * Shape monthly power forwards (power_forwards) into daily prices.
 *
 * Methodology (confirmed with user 2026-07-31):
 *   1. Pull real 2025 hourly DA settlement prices at the same hub the
 *      monthly forward represents (HB_NORTH for ERCOT, SP15 for CAISO —
 *      see power_forwards.ts).
 *   2. Collapse to a daily average price per (month, day) in 2025.
 *   3. Compute each 2025 month's average of its own daily averages.
 *   4. shape_factor(month, day) = 2025 daily avg / 2025 monthly avg.
 *   5. For every future delivery month in power_forwards, and every day in
 *      that month, daily_price = monthly_forward_price × shape_factor,
 *      matched by calendar day-of-month POSITION (day 15 of any future
 *      September uses the factor from day 15 of Sep 2025) — not by weekday.
 *      This exact mapping (calendar position, not weekday-average) was
 *      explicitly requested over the alternative that was offered.
 *   6. Days that don't exist in the 2025 source month (Feb 29 in a leap-year
 *      target) fall back to the nearest earlier day's factor in that month.
 *
 * Run: pnpm --filter @workspace/scripts seed-power-forwards-daily
 * (run seed-power-forwards first — this reads its output)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const REFERENCE: Record<string, { node: string; table: "ercot_hub_hourly" | "caiso_hub_hourly" }> = {
  ERCOT: { node: "HB_NORTH", table: "ercot_hub_hourly" },
  // Node names below are the values as STORED in the hourly tables, which are
  // NOT the same as the source API's identifiers (CAISO OASIS calls this
  // TH_SP15_GEN-APND; seed-caiso-hourly stores it as plain "SP15"). Verified
  // against the live tables 2026-07-31 — check before changing.
  CAISO: { node: "SP15", table: "caiso_hub_hourly" },
};

const SHAPE_YEAR = 2025;

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

async function buildShapeFactors(market: string): Promise<Map<number, Map<number, number>>> {
  const { node, table } = REFERENCE[market];

  const dailyRows = await db.execute<{ month: number; day: number; avg_price: string }>(sql`
    SELECT month, day, AVG(da_price)::float8 AS avg_price
    FROM ${sql.raw(table)}
    WHERE node = ${node} AND year = ${SHAPE_YEAR} AND da_price IS NOT NULL
    GROUP BY month, day
    ORDER BY month, day
  `);

  if (!dailyRows.rows.length) {
    throw new Error(`No ${SHAPE_YEAR} hourly DA data found for ${market} node ${node} in ${table} — seed real hourly data first`);
  }

  // Monthly avg = average of that month's own daily averages
  const monthlyDaily = new Map<number, number[]>();
  for (const r of dailyRows.rows) {
    const arr = monthlyDaily.get(r.month) ?? [];
    arr.push(Number(r.avg_price));
    monthlyDaily.set(r.month, arr);
  }
  const monthlyAvg = new Map<number, number>();
  for (const [month, prices] of monthlyDaily) {
    monthlyAvg.set(month, prices.reduce((s, p) => s + p, 0) / prices.length);
  }

  const shapeFactor = new Map<number, Map<number, number>>();
  for (const r of dailyRows.rows) {
    const mAvg = monthlyAvg.get(r.month)!;
    if (!mAvg) continue;
    const dayMap = shapeFactor.get(r.month) ?? new Map<number, number>();
    dayMap.set(r.day, Number(r.avg_price) / mAvg);
    shapeFactor.set(r.month, dayMap);
  }

  console.log(`  [${market}] shape built from ${dailyRows.rows.length} real 2025 daily prices (node ${node}), ${shapeFactor.size} months covered`);
  return shapeFactor;
}

function factorFor(shapeFactor: Map<number, Map<number, number>>, month: number, day: number): number {
  const dayMap = shapeFactor.get(month);
  if (!dayMap) return 1.0;
  for (let d = day; d >= 1; d--) {
    const f = dayMap.get(d);
    if (f !== undefined) return f;
  }
  // fall forward if nothing at/below (shouldn't normally happen)
  const anyFactor = [...dayMap.values()][0];
  return anyFactor ?? 1.0;
}

async function main() {
  console.log("=== Power Forwards Daily Shaping ===\n");

  for (const market of Object.keys(REFERENCE)) {
    console.log(`[${market}]`);
    const shapeFactor = await buildShapeFactors(market);

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
      for (let d = 1; d <= nDays; d++) {
        const factor = factorFor(shapeFactor, m, d);
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
