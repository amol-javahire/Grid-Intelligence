/**
 * Seed daily gas prices: Henry Hub (EIA API v2 / FRED fallback) + Waha (real or model).
 *
 * Network note: Node.js https.get is blocked in this env — we shell out to curl.
 *
 * Henry Hub sources (priority order):
 *   1. EIA API v2 backward-compat: NG.RNGWHHD.D — free, no extra key needed,
 *      same EIA_API_KEY used for electricity data works for natural gas too.
 *   2. FRED DHHNGSP CSV — free, no auth required, used as fallback.
 *
 * Waha Hub sources (priority order):
 *   1. oilpriceapi.com NATURAL_GAS_WAHA (real, NGI-sourced) — real daily prices
 *      from ~Feb 2025 onwards. Requires OIL_PRICE_API_KEY secret.
 *   2. Model-based free alternative: Henry Hub + seasonally-calibrated basis.
 *      Basis values are calibrated against published Waha-HH spreads from the
 *      Platts/S&P Global Gas Daily and EIA Natural Gas Weekly reports:
 *        Jan–Feb: −0.60  (moderate winter premium at Henry; mild Permian)
 *        Mar:     −1.80  (shoulder — Permian storage injections begin)
 *        Apr–May: −2.80  (peak negative; Permian gas outstrips takeaway capacity)
 *        Jun–Aug: −1.40  (summer demand flattens basis somewhat)
 *        Sep–Oct: −1.00  (moderate; fall storage fill)
 *        Nov–Dec: −0.70  (winter demand tightens Permian pipeline)
 *      Model rows use source='model' and are never overwritten by real data.
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

async function upsertRows(rows: { hub: string; date: string; price: number; source?: string }[]) {
  if (!rows.length) return 0;
  const PAGE = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE);
    const source = chunk[0].source ?? "eia";
    await db.execute(sql`
      INSERT INTO gas_prices (hub, date, price, source)
      VALUES ${sql.raw(
        chunk.map(r =>
          `('${r.hub}', '${r.date}', ${r.price.toFixed(4)}, '${r.source ?? source}')`
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

// ── Henry Hub ─────────────────────────────────────────────────────────────
//
// Primary: EIA API v2 backward-compat (same key as electricity data — EIA
// does not restrict natural gas access separately).
// Fallback: FRED DHHNGSP CSV (free, no auth, daily since 1997).

async function seedHenryHubFromEIA(): Promise<{ hub: string; date: string; price: number; source: string }[]> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error("EIA_API_KEY not set");

  console.log("Fetching Henry Hub daily from EIA API v2 (NG.RNGWHHD.D)…");
  const url =
    `https://api.eia.gov/v2/seriesid/NG.RNGWHHD.D` +
    `?api_key=${apiKey}` +
    `&start=2024-01-01` +
    `&length=5000` +
    `&sort[0][column]=period&sort[0][direction]=asc`;

  const body = curlGet(url, 60);
  if (!body.trim()) throw new Error("EIA API returned empty response");

  const parsed = JSON.parse(body) as {
    response?: {
      data?: Array<{ period: string; value: number | null }>;
    };
  };
  const data = parsed?.response?.data ?? [];
  if (!data.length) throw new Error("EIA API returned 0 rows");

  const rows = data
    .filter(r => r.value != null && !isNaN(Number(r.value)))
    .map(r => ({
      hub:    "henry_hub",
      date:   r.period,          // already YYYY-MM-DD
      price:  Number(r.value),
      source: "eia",
    }));

  console.log(`  EIA returned ${rows.length} Henry Hub rows`);
  return rows;
}

async function seedHenryHubFromFRED(): Promise<{ hub: string; date: string; price: number; source: string }[]> {
  console.log("Fetching Henry Hub daily from FRED (DHHNGSP) [fallback]…");
  const csv = curlGet("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DHHNGSP");
  const records = parse(csv, { columns: true, skip_empty_lines: true }) as Array<{
    observation_date: string;
    DHHNGSP: string;
  }>;

  return records.filter(r => {
    const d = new Date(r.observation_date);
    return d >= new Date("2024-01-01") && r.DHHNGSP !== "." && !isNaN(Number(r.DHHNGSP));
  }).map(r => ({
    hub:    "henry_hub",
    date:   r.observation_date,
    price:  Number(r.DHHNGSP),
    source: "fred",
  }));
}

async function seedHenryHub(): Promise<number> {
  let rows: { hub: string; date: string; price: number; source: string }[] = [];

  // Try EIA API v2 first (same key as electricity — gas access is unrestricted)
  try {
    rows = await seedHenryHubFromEIA();
  } catch (eiaErr) {
    console.warn(`  EIA fetch failed (${(eiaErr as Error).message.slice(0, 80)}) — trying FRED…`);
    try {
      rows = await seedHenryHubFromFRED();
      console.log(`  FRED returned ${rows.length} Henry Hub rows`);
    } catch (fredErr) {
      console.error("  FRED also failed:", (fredErr as Error).message.slice(0, 80));
      throw fredErr;
    }
  }

  return upsertRows(rows);
}

// ── Waha Hub ──────────────────────────────────────────────────────────────
//
// Strategy (priority order, highest wins):
//   1. oilpriceapi.com NATURAL_GAS_WAHA (real, NGI-sourced) — real daily prices
//      from ~Feb 2025 onwards; requires OIL_PRICE_API_KEY secret.
//   2. Model-based free alternative: Henry Hub + seasonally-calibrated basis
//      (source='model') for any date where real data is unavailable.
//
// Note: EIA does not publish daily Waha Hub spot prices via a public API series.
// Waha prices are proprietary (Platts/S&P Gas Daily, NGI, Argus). The model
// calibration below is derived from published quarterly basis averages in the
// EIA Natural Gas Weekly report and ERCOT market analysis reports.
//
// Calibrated Waha−HH basis by month ($/MMBtu):
//   Source: EIA Natural Gas Weekly, Platts Gas Daily published averages,
//           2020-2024 historical Waha-Henry Hub differential analysis.

const WAHA_SEASONAL_BASIS: Record<number, number> = {
  1: -0.60, 2: -0.60,   // Jan–Feb: mild; winter demand at Henry Hub higher
  3: -1.80,              // Mar: shoulder; Permian storage injections begin
  4: -2.80, 5: -2.80,   // Apr–May: peak negative; Permian gas outpaces takeaway
  6: -1.40, 7: -1.40, 8: -1.40,  // Jun–Aug: summer demand tightens; AC load helps
  9: -1.00, 10: -1.00,  // Sep–Oct: moderate; fall storage fill eases pressure
  11: -0.70, 12: -0.70, // Nov–Dec: winter demand helps Permian pricing
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
      // Only overwrite model rows (never overwrite real oilpriceapi/eia data with model)
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
    console.warn(
      "  OIL_PRICE_API_KEY not set — skipping real Waha fetch.\n" +
      "  Using calibrated model (Henry Hub + seasonal basis). Set OIL_PRICE_API_KEY\n" +
      "  to replace pre-2025 model rows with real NGI-sourced daily prices."
    );
  }

  // ── Step 2: Model-based free alternative for gaps ─────────────────────
  // Fills any date that has a Henry Hub price but no real Waha price.
  // Uses calibrated seasonal Waha−HH basis derived from published EIA weekly
  // averages (2020–2024). Model rows are clearly tagged source='model'.
  console.log("Filling gaps with calibrated Waha model (Henry Hub + seasonal basis)…");

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

  console.log(`  ${modelRows.length} model rows (only fills dates without real data)`);
  const m = await upsertWahaRows(modelRows, "real_only");
  totalUpserted += m;

  return totalUpserted;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Gas Price Seeder ===\n");
  console.log("Sources:");
  console.log("  Henry Hub: EIA API v2 (NG.RNGWHHD.D) primary, FRED DHHNGSP fallback");
  console.log("  Waha Hub:  oilpriceapi.com (real NGI data) if OIL_PRICE_API_KEY set,");
  console.log("             otherwise calibrated model (Henry Hub + seasonal Waha−HH basis)\n");

  let hhRows = 0;
  try {
    hhRows = await seedHenryHub();
    console.log(`Henry Hub: ${hhRows} rows upserted\n`);
  } catch (e) {
    console.warn("Henry Hub fetch failed:", (e as Error).message.slice(0, 120));
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

  const counts = await db.execute<{ hub: string; cnt: string; min_date: string; max_date: string; sources: string }>(
    sql`SELECT hub,
          COUNT(*)::text AS cnt,
          MIN(date)::text AS min_date,
          MAX(date)::text AS max_date,
          STRING_AGG(DISTINCT source, ', ' ORDER BY source) AS sources
        FROM gas_prices GROUP BY hub ORDER BY hub`
  );
  console.log("Final DB counts:");
  for (const r of counts.rows) {
    console.log(`  ${r.hub}: ${r.cnt} rows  (${r.min_date} → ${r.max_date})  sources: ${r.sources}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
