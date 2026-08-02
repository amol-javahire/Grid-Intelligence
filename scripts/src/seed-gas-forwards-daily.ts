/**
 * Shape the monthly Henry Hub gas forward strip (gas_forwards) into daily prices.
 *
 * Methodology — MONTH × WEEKDAY, matching seed-power-forwards-daily.ts:
 *   shape_factor(month, weekday) = avg 2025 Henry Hub price for that weekday in
 *                                   that month / that month's overall daily avg
 *   daily_forward_price(future month, day) =
 *       monthly_forward_price × shape_factor(month, that day's actual weekday)
 *   then renormalised so each delivery month's calendar-day mean factor is 1.0.
 *
 * Gas settles on business days only — Henry Hub has ~261 prices in 2025, so the
 * Saturday and Sunday buckets are EMPTY. Both fall back to Friday's factor,
 * confirmed with the user as the intended treatment: it matches physical gas,
 * where weekend flow prices off the Friday settle.
 *
 * The renormalisation step matters here specifically. Friday's factor being
 * counted three times is not value-neutral on its own — the first run drifted
 * as far as 1.106 / 0.955 against the monthly forward. A monthly forward IS the
 * average price for that month, so the shaped series must average back to it.
 * Renormalising preserves the Friday-for-weekend rule and the relative shape
 * while restoring exact value neutrality.
 *
 * Henry-Hub-only scope — gas_forwards has no per-market split (Waha and CA
 * citygate have no forward strips), so this shapes the one curve that exists
 * rather than fabricating market-specific ones.
 *
 * Run: pnpm --filter @workspace/scripts seed-gas-forwards-daily
 * (run seed-gas-forwards first — this reads its output)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const SHAPE_YEAR = 2025;
const HUB = "henry_hub";
const FRIDAY = 5;
const DOW_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** month (1-12) → weekday (0=Sun..6=Sat) → factor */
type ShapeMap = Map<number, Map<number, number>>;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

async function buildShapeFactors(): Promise<ShapeMap> {
  const rows = await db.execute<{ d: string; price: string }>(sql`
    SELECT date::text AS d, price::float8 AS price
    FROM gas_prices
    WHERE hub = ${HUB} AND EXTRACT(YEAR FROM date) = ${SHAPE_YEAR} AND price IS NOT NULL
    ORDER BY date
  `);

  if (!rows.rows.length) {
    throw new Error(`No ${SHAPE_YEAR} daily prices for hub ${HUB} — seed real gas prices first`);
  }

  const byMonth = new Map<number, number[]>();
  const byMonthDow = new Map<number, Map<number, number[]>>();

  for (const r of rows.rows) {
    const dt = new Date(`${r.d}T00:00:00Z`);
    const month = dt.getUTCMonth() + 1;
    const dow = dt.getUTCDay();
    const price = Number(r.price);

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
    `  shape from ${rows.rows.length} real ${SHAPE_YEAR} daily prices (hub ${HUB}), ` +
      `${shape.size} months × weekday buckets`,
  );
  return shape;
}

/**
 * Weekend/holiday lookup: gas has no Sat/Sun settlement, so those buckets are
 * empty and resolve to Friday. If Friday is also missing (a month where the
 * source has gaps), walk backward through the week, then forward.
 */
function factorFor(shape: ShapeMap, month: number, dow: number): number {
  const dowMap = shape.get(month);
  if (!dowMap || dowMap.size === 0) return 1.0;
  const exact = dowMap.get(dow);
  if (exact !== undefined) return exact;
  const friday = dowMap.get(FRIDAY);
  if (friday !== undefined) return friday;
  for (let offset = 1; offset <= 6; offset++) {
    const back = dowMap.get((dow - offset + 7) % 7);
    if (back !== undefined) return back;
    const fwd = dowMap.get((dow + offset) % 7);
    if (fwd !== undefined) return fwd;
  }
  return 1.0;
}

async function main() {
  console.log("=== Gas Forwards Daily Shaping (Henry Hub, month × weekday) ===\n");

  const shape = await buildShapeFactors();

  const sample = shape.get(1);
  if (sample) {
    const parts = [...sample.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dow, f]) => `${DOW_NAME[dow]} ${f.toFixed(3)}`);
    console.log(`  Jan ${SHAPE_YEAR} weekday profile: ${parts.join("  ")}  (Sat/Sun absent → Friday)`);
  }

  const fwdRows = await db.execute<{ as_of_date: string; delivery_month: string; settle_price: string }>(sql`
    SELECT as_of_date::text, delivery_month::text, settle_price::float8 AS settle_price
    FROM gas_forwards
    WHERE as_of_date = (SELECT MAX(as_of_date) FROM gas_forwards)
      AND settle_price IS NOT NULL
    ORDER BY delivery_month ASC
  `);

  if (!fwdRows.rows.length) {
    console.error("  ✗ no gas_forwards rows — run seed-gas-forwards first");
    process.exit(1);
  }

  const asOfDate = fwdRows.rows[0].as_of_date;
  const dailyOut: Array<{ deliveryDate: string; priceMmbtu: number; monthlyForwardPrice: number; shapeFactor: number }> = [];

  for (const row of fwdRows.rows) {
    const [y, m] = row.delivery_month.split("-").map(Number);
    const monthlyPrice = Number(row.settle_price);
    const nDays = daysInMonth(y, m);

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
