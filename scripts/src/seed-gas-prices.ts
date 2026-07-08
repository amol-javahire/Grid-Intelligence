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

function curlGet(url: string, timeoutSec = 45): string {
  return execSync(
    `curl -s --connect-timeout 15 --max-time ${timeoutSec} --compressed -L "${url}"`,
    { maxBuffer: 50 * 1024 * 1024, timeout: (timeoutSec + 15) * 1000 }
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

// ── Waha Hub ──────────────────────────────────────────────────────────────
//
// Strategy (priority order, highest wins):
//   1. oilpriceapi.com NATURAL_GAS_WAHA (real, NGI-sourced) — available from
//      ~Jul 2025 onwards, ~25 rows/page, paginated.
//   2. Model-based fallback: Henry Hub + seasonally-calibrated basis, for
//      dates not covered by the API (Jan 2024 – mid 2025).
//
// Basis calibration (Waha−HH, $/MMBtu):
//   Jan–Feb: −0.60, Mar: −1.80, Apr–May: −2.80, Jun–Aug: −1.40,
//   Sep–Oct: −1.00, Nov–Dec: −0.70

const WAHA_SEASONAL_BASIS: Record<number, number> = {
  1: -0.60, 2: -0.60,
  3: -1.80,
  4: -2.80, 5: -2.80,
  6: -1.40, 7: -1.40, 8: -1.40,
  9: -1.00, 10: -1.00,
  11: -0.70, 12: -0.70,
};

function dailyNoise(dateStr: string): number {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
  return ((h % 401) - 200) / 1000;
}

async function upsertWahaRows(
  rows: { date: string; price: number; source: string }[],
  allowOverwrite: "real_only" | "all"
) {
  const PAGE = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE);
    if (allowOverwrite === "real_only") {
      // Only overwrite model rows (never overwrite real oilpriceapi data with model)
      await db.execute(sql`
        INSERT INTO gas_prices (hub, date, price, source)
        VALUES ${sql.raw(chunk.map(r =>
          `('waha', '${r.date}', ${r.price.toFixed(4)}, '${r.source}')`
        ).join(", "))}
        ON CONFLICT (hub, date) DO UPDATE SET
          price  = EXCLUDED.price,
          source = EXCLUDED.source
        WHERE gas_prices.source NOT IN ('eia', 'oilpriceapi')
      `);
    } else {
      // Real data always wins
      await db.execute(sql`
        INSERT INTO gas_prices (hub, date, price, source)
        VALUES ${sql.raw(chunk.map(r =>
          `('waha', '${r.date}', ${r.price.toFixed(4)}, '${r.source}')`
        ).join(", "))}
        ON CONFLICT (hub, date) DO UPDATE SET
          price  = EXCLUDED.price,
          source = EXCLUDED.source
      `);
    }
    total += chunk.length;
    process.stdout.write(`\r  upserted ${total}/${rows.length}`);
  }
  console.log();
  return total;
}

async function seedWaha() {
  let totalUpserted = 0;

  // ── Step 1: Fetch real Waha from oilpriceapi.com ──────────────────────
  const apiKey = process.env.OIL_PRICE_API_KEY;
  if (apiKey) {
    console.log("Fetching real Waha prices from oilpriceapi.com (NGI source)…");
    const realRows: { date: string; price: number; source: string }[] = [];

    for (let page = 1; page <= 30; page++) {
      try {
        const body = execSync(
          `curl -s --max-time 15 -H "Authorization: Token ${apiKey}" ` +
          `"https://api.oilpriceapi.com/v1/prices?by_code=NATURAL_GAS_WAHA&past=9999d&page=${page}"`,
          { maxBuffer: 10 * 1024 * 1024 }
        ).toString("utf8");

        const parsed = JSON.parse(body);
        const prices: Array<{ created_at: string; price: number }> =
          parsed?.data?.prices ?? [];

        if (!prices.length) {
          console.log(`  Page ${page}: empty — done fetching`);
          break;
        }

        for (const p of prices) {
          const date = p.created_at.slice(0, 10);
          if (!isNaN(p.price)) {
            realRows.push({ date, price: p.price, source: "oilpriceapi" });
          }
        }
        process.stdout.write(`\r  Page ${page}: +${prices.length} rows (total ${realRows.length})`);
      } catch (e) {
        console.warn(`\n  Page ${page} fetch failed:`, (e as Error).message);
        break;
      }
    }
    console.log();

    // Deduplicate by date (keep first occurrence = newest per-day)
    const seen = new Set<string>();
    const deduped = realRows.filter(r => {
      if (seen.has(r.date)) return false;
      seen.add(r.date);
      return true;
    });

    console.log(`  ${deduped.length} unique Waha dates from oilpriceapi`);
    if (deduped.length) {
      const n = await upsertWahaRows(deduped, "all");
      totalUpserted += n;
      const dates = deduped.map(r => r.date).sort();
      console.log(`  Real data range: ${dates[0]} → ${dates[dates.length - 1]}`);
    }
  } else {
    console.warn("  OIL_PRICE_API_KEY not set — skipping real Waha fetch.");
  }

  // ── Step 2: Model fallback for gaps (dates without real data) ─────────
  console.log("Generating model-based Waha for dates without real data…");

  const hhRows = await db.execute<{ date: string; price: string }>(
    sql`SELECT date::text, price::text FROM gas_prices
        WHERE hub = 'henry_hub'
        ORDER BY date ASC`
  );

  if (!hhRows.rows.length) {
    console.warn("  No Henry Hub rows — skipping model fill.");
    return totalUpserted;
  }

  const modelRows: { date: string; price: number; source: string }[] = [];
  for (const r of hhRows.rows) {
    const d = new Date(r.date);
    const month = d.getUTCMonth() + 1;
    const basis = WAHA_SEASONAL_BASIS[month] ?? -1.00;
    const noise = dailyNoise(r.date);
    const wahaPrice = Math.max(-5.0, Number(r.price) + basis + noise);
    modelRows.push({ date: r.date, price: wahaPrice, source: "model" });
  }

  console.log(`  ${modelRows.length} model rows (will skip real-data dates)`);
  const m = await upsertWahaRows(modelRows, "real_only");
  totalUpserted += m;

  return totalUpserted;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Gas Price Seeder ===\n");

  let hhRows = 0;
  try {
    hhRows = await seedHenryHub();
    console.log(`Henry Hub: ${hhRows} rows upserted\n`);
  } catch (e) {
    console.warn("Henry Hub FRED fetch failed:", (e as Error).message.slice(0, 120));
    const existing = await db.execute<{ cnt: string }>(
      sql`SELECT COUNT(*)::text AS cnt FROM gas_prices WHERE hub = 'henry_hub'`
    );
    hhRows = Number(existing.rows[0]?.cnt ?? 0);
    if (hhRows > 0) {
      console.log(`  Using ${hhRows} existing Henry Hub rows from DB — continuing to Waha seed\n`);
    } else {
      console.error("  No existing Henry Hub data in DB — cannot seed Waha. Exiting.");
      process.exit(1);
    }
  }

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
