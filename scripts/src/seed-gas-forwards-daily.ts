/**
 * Shape the monthly Henry Hub gas forward strip (gas_forwards) into daily prices.
 *
 * Same methodology as seed-power-forwards-daily.ts, applied to the single
 * national gas_forwards curve using gas_prices (hub='henry_hub') as the
 * real 2025 daily reference:
 *
 *   shape_factor(month, day) = 2025 real daily Henry Hub price / 2025 real
 *                               monthly avg Henry Hub price
 *   daily_forward_price(future month, day N) =
 *       monthly_forward_price(future month) × shape_factor(calendar month,
 *       day N), matched by calendar day-of-month POSITION, not weekday.
 *
 * Henry-Hub-only scope — gas_forwards has no per-market split (Waha/CA
 * citygate don't have forward strips yet), so this shapes the one curve
 * that exists rather than fabricating market-specific ones.
 *
 * Run: pnpm --filter @workspace/scripts seed-gas-forwards-daily
 * (run seed-gas-forwards first — this reads its output)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const SHAPE_YEAR = 2025;
const HUB = "henry_hub";

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

async function buildShapeFactors(): Promise<Map<number, Map<number, number>>> {
  const dailyRows = await db.execute<{ month: number; day: number; price: string }>(sql`
    SELECT EXTRACT(MONTH FROM date)::int AS month, EXTRACT(DAY FROM date)::int AS day, price::float8 AS price
    FROM gas_prices
    WHERE hub = ${HUB} AND EXTRACT(YEAR FROM date) = ${SHAPE_YEAR} AND price IS NOT NULL
    ORDER BY date
  `);

  if (!dailyRows.rows.length) {
    throw new Error(`No ${SHAPE_YEAR} daily prices found for hub ${HUB} — seed real gas prices first`);
  }

  const monthlyDaily = new Map<number, number[]>();
  for (const r of dailyRows.rows) {
    const arr = monthlyDaily.get(r.month) ?? [];
    arr.push(Number(r.price));
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
    dayMap.set(r.day, Number(r.price) / mAvg);
    shapeFactor.set(r.month, dayMap);
  }

  console.log(`  shape built from ${dailyRows.rows.length} real 2025 daily prices (hub ${HUB}), ${shapeFactor.size} months covered`);
  return shapeFactor;
}

/**
 * Gas settles on business days only — Henry Hub has ~261 prices in 2025, not
 * 365. Weekend and holiday delivery days therefore have no factor of their
 * own and walk BACKWARD to the most recent prior trading day in the same
 * month, i.e. Sat/Sun both take Friday's factor. Confirmed with the user
 * 2026-07-31 as the intended treatment — it matches physical gas, where
 * weekend flow prices off the Friday settle.
 *
 * Consequence: the mean factor across all calendar days of a month will not
 * be exactly 1.000 (Friday's value is counted three times). Expect ~0.99–1.01
 * drift. That is correct, not a bug — do not "fix" it by renormalising.
 */
function factorFor(shapeFactor: Map<number, Map<number, number>>, month: number, day: number): number {
  const dayMap = shapeFactor.get(month);
  if (!dayMap) return 1.0;
  for (let d = day; d >= 1; d--) {
    const f = dayMap.get(d);
    if (f !== undefined) return f;
  }
  const anyFactor = [...dayMap.values()][0];
  return anyFactor ?? 1.0;
}

async function main() {
  console.log("=== Gas Forwards Daily Shaping (Henry Hub) ===\n");

  const shapeFactor = await buildShapeFactors();

  const fwdRows = await db.execute<{ as_of_date: string; delivery_month: string; settle_price: string }>(sql`
    SELECT as_of_date::text, delivery_month::text, settle_price::float8 AS settle_price
    FROM gas_forwards
    WHERE as_of_date = (SELECT MAX(as_of_date) FROM gas_forwards)
      AND settle_price IS NOT NULL
    ORDER BY delivery_month ASC
  `);

  if (!fwdRows.rows.length) {
    console.error("  ✗ no gas_forwards rows found — run seed-gas-forwards first");
    process.exit(1);
  }

  const asOfDate = fwdRows.rows[0].as_of_date;
  const dailyOut: Array<{ deliveryDate: string; priceMmbtu: number; monthlyForwardPrice: number; shapeFactor: number }> = [];

  for (const row of fwdRows.rows) {
    const [y, m] = row.delivery_month.split("-").map(Number);
    const monthlyPrice = Number(row.settle_price);
    const nDays = daysInMonth(y, m);
    for (let d = 1; d <= nDays; d++) {
      const factor = factorFor(shapeFactor, m, d);
      dailyOut.push({
        deliveryDate: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        priceMmbtu: Math.round(monthlyPrice * factor * 10000) / 10000,
        monthlyForwardPrice: monthlyPrice,
        shapeFactor: Math.round(factor * 100000) / 100000,
      });
    }
  }

  const PAGE = 500;
  let total = 0;
  for (let i = 0; i < dailyOut.length; i += PAGE) {
    const chunk = dailyOut.slice(i, i + PAGE);
    await db.execute(sql`
      INSERT INTO gas_forwards_daily
        (as_of_date, delivery_date, price_mmbtu, monthly_forward_price, shape_factor, reference_hub, shape_year)
      VALUES ${sql.raw(
        chunk.map((r) =>
          `('${asOfDate}', '${r.deliveryDate}', ${r.priceMmbtu}, ${r.monthlyForwardPrice}, ${r.shapeFactor}, '${HUB}', ${SHAPE_YEAR})`,
        ).join(", "),
      )}
      ON CONFLICT (as_of_date, delivery_date) DO UPDATE SET
        price_mmbtu           = EXCLUDED.price_mmbtu,
        monthly_forward_price = EXCLUDED.monthly_forward_price,
        shape_factor           = EXCLUDED.shape_factor,
        reference_hub           = EXCLUDED.reference_hub,
        shape_year              = EXCLUDED.shape_year,
        created_at              = now()
    `);
    total += chunk.length;
  }
  console.log(`  ✓ upserted ${total} daily rows across ${fwdRows.rows.length} months (as_of ${asOfDate})\n`);

  const summary = await db.execute<{ n: string; lo: string; hi: string; min_p: string; max_p: string }>(sql`
    SELECT COUNT(*)::text AS n, MIN(delivery_date)::text AS lo, MAX(delivery_date)::text AS hi,
           MIN(price_mmbtu)::text AS min_p, MAX(price_mmbtu)::text AS max_p
    FROM gas_forwards_daily
  `);
  console.log("=== Summary ===");
  for (const r of summary.rows) console.log(`  ${r.n} days, ${r.lo} → ${r.hi}, $${r.min_p}–$${r.max_p}/MMBtu`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
