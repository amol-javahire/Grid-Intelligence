/**
 * Seed daily gas prices: Henry Hub (FRED) + Waha (EIA v2, if key has gas access).
 *
 * Network note: Node.js https.get is blocked in this env — we shell out to curl.
 * Henry Hub: FRED DHHNGSP — free, no auth, daily since 1997.
 * Waha:      EIA v2 natural-gas — requires EIA_API_KEY with natural gas scope.
 *
 * Run: pnpm --filter @workspace/scripts run seed-gas-prices
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { execSync } from "child_process";
import { parse } from "csv-parse/sync";

// ── helpers ────────────────────────────────────────────────────────────────

function curlGet(url: string, timeoutSec = 30): string {
  return execSync(
    `curl -s --max-time ${timeoutSec} --compressed -L "${url}"`,
    { maxBuffer: 50 * 1024 * 1024 }
  ).toString("utf8");
}

async function upsertRows(rows: { hub: string; date: string; price: number }[]) {
  if (!rows.length) return 0;
  const PAGE = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE);
    await db.execute(sql`
      INSERT INTO gas_prices (hub, date, price, source)
      VALUES ${sql.raw(
        chunk.map(r =>
          `('${r.hub}', '${r.date}', ${r.price.toFixed(4)}, 'fred')`
        ).join(", ")
      )}
      ON CONFLICT (hub, date) DO UPDATE SET
        price  = EXCLUDED.price,
        source = EXCLUDED.source
    `);
    total += chunk.length;
    process.stdout.write(`\r  upserted ${total}/${rows.length}`);
  }
  console.log();
  return total;
}

// ── Henry Hub from FRED ────────────────────────────────────────────────────

async function seedHenryHub() {
  console.log("Fetching Henry Hub daily from FRED (DHHNGSP)…");
  const csv = curlGet("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DHHNGSP");
  const records = parse(csv, { columns: true, skip_empty_lines: true }) as Array<{
    observation_date: string;
    DHHNGSP: string;
  }>;

  const rows = records.filter(r => {
    const d = new Date(r.observation_date);
    return d >= new Date("2024-01-01") && r.DHHNGSP !== "." && !isNaN(Number(r.DHHNGSP));
  }).map(r => ({
    hub:   "henry_hub",
    date:  r.observation_date,
    price: Number(r.DHHNGSP),
  }));

  console.log(`  Parsed ${rows.length} Henry Hub rows (2024-01-01 → latest)`);
  return upsertRows(rows);
}

// ── Waha Hub — model-derived from Henry Hub + seasonal basis ──────────────
//
// EIA's free API only publishes Henry Hub spot prices. Waha (West Texas) hub
// spot prices require commercial data providers (Platts, Argus, NGI).
//
// We derive Waha from Henry Hub using a seasonally-calibrated basis model
// that reflects real market dynamics: Waha trades at a discount to HH due to
// ERCOT west Texas pipeline constraints, which widens in spring/fall when
// Permian wind is high and cooling/heating demand is low.
//
// Basis calibration (Waha−HH, $/MMBtu):
//   • Jan–Feb: −0.60  (winter demand tightens basis)
//   • Mar:     −1.80  (spring wind ramp; pipeline starts filling)
//   • Apr–May: −2.80  (peak wind, low demand; widest historical discount)
//   • Jun–Aug: −1.40  (summer cooling demand tightens basis)
//   • Sep–Oct: −1.00
//   • Nov–Dec: −0.70  (approaching winter demand)
//
// Source labeled 'model' — not real market data. Skips dates already seeded
// with source='eia' to avoid overwriting real data if ever available.

const WAHA_SEASONAL_BASIS: Record<number, number> = {
  1: -0.60, 2: -0.60,            // Jan–Feb: winter demand
  3: -1.80,                       // Mar: spring wind ramp
  4: -2.80, 5: -2.80,            // Apr–May: peak Permian wind, low demand
  6: -1.40, 7: -1.40, 8: -1.40, // Jun–Aug: summer cooling
  9: -1.00, 10: -1.00,           // Sep–Oct: shoulder
  11: -0.70, 12: -0.70,          // Nov–Dec: approaching winter
};

// Small deterministic daily noise (±$0.20) using date string as seed
function dailyNoise(dateStr: string): number {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
  return ((h % 401) - 200) / 1000; // −0.200 … +0.200
}

async function seedWaha() {
  console.log("Generating model-based Waha prices from Henry Hub + seasonal basis…");
  console.log("  (EIA free API only publishes Henry Hub — Waha requires commercial data)");

  // Pull Henry Hub prices from DB
  const hhRows = await db.execute<{ date: string; price: string }>(
    sql`SELECT date::text, price::text FROM gas_prices
        WHERE hub = 'henry_hub'
        ORDER BY date ASC`
  );

  if (!hhRows.rows.length) {
    console.warn("  No Henry Hub rows found — run Henry Hub seed first.");
    return 0;
  }

  console.log(`  Loaded ${hhRows.rows.length} Henry Hub rows as basis`);

  const rows: { hub: string; date: string; price: number }[] = [];

  for (const r of hhRows.rows) {
    const d = new Date(r.date);
    const month = d.getUTCMonth() + 1;
    const basis = WAHA_SEASONAL_BASIS[month] ?? -1.00;
    const noise = dailyNoise(r.date);
    const wahaPrice = Math.max(-5.0, Number(r.price) + basis + noise);
    rows.push({ hub: "waha", date: r.date, price: wahaPrice });
  }

  if (!rows.length) return 0;

  const PAGE = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE);
    await db.execute(sql`
      INSERT INTO gas_prices (hub, date, price, source)
      VALUES ${sql.raw(chunk.map(r =>
        `('${r.hub}', '${r.date}', ${r.price.toFixed(4)}, 'model')`
      ).join(", "))}
      ON CONFLICT (hub, date) DO UPDATE SET
        price  = EXCLUDED.price,
        source = EXCLUDED.source
      WHERE gas_prices.source != 'eia'
    `);
    total += chunk.length;
    process.stdout.write(`\r  upserted ${total}/${rows.length}`);
  }
  console.log();
  return total;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Gas Price Seeder ===\n");

  const hhRows = await seedHenryHub();
  console.log(`Henry Hub: ${hhRows} rows upserted\n`);

  const wahaRows = await seedWaha();
  console.log(`Waha: ${wahaRows} rows upserted\n`);

  const counts = await db.execute<{ hub: string; cnt: string; min_date: string; max_date: string }>(
    sql`SELECT hub, COUNT(*)::text AS cnt, MIN(date)::text AS min_date, MAX(date)::text AS max_date
        FROM gas_prices GROUP BY hub ORDER BY hub`
  );
  console.log("Final DB counts:");
  for (const r of counts.rows) {
    console.log(`  ${r.hub}: ${r.cnt} rows  (${r.min_date} → ${r.max_date})`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
