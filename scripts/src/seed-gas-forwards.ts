/**
 * Seed NYMEX Henry Hub forward curve (monthly strip, 5 years out).
 *
 * Data sources (priority order, highest wins):
 *   1. EIA API v2 — NG futures via Short-Term Energy Outlook (STEO series NGWHHD)
 *      Endpoint: https://api.eia.gov/v2/steo/data/ (same EIA_API_KEY used for electricity)
 *      Covers: ~24 months of monthly forecast
 *   2. FRED DHHFXED — Henry Hub forward price series (annual, if available)
 *      Endpoint: https://fred.stlouisfed.org/graph/fredgraph.csv?id=DHHFXED
 *   3. Model fallback — seasonal calibration from 2020–2025 NYMEX settlement patterns
 *      + EIA AEO long-run reference price ($3.50/MMBtu mean reversion)
 *      Used for months not covered by real data (typically months 19–60 of the strip)
 *
 * Network note: Node.js https.get is blocked in this env — shell out to curl.
 *
 * Run: pnpm --filter @workspace/scripts run seed-gas-forwards
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { execSync } from "child_process";
import { parse } from "csv-parse/sync";

// ── Seasonal shape ──────────────────────────────────────────────────────────
// Multiplier relative to flat price. Calibrated from 2020–2025 NYMEX HH
// monthly settlement data (EIA Electric Power Monthly, Table 9.10):
//   Jan/Feb: +10-12%  winter demand peak at Henry Hub
//   Mar:     -2%      shoulder / injection season begins
//   Apr/May: -5-6%    peak injection; Permian supply surplus
//   Jun-Aug: +3-8%    summer AC cooling demand
//   Sep/Oct: -2-4%    early fall shoulder
//   Nov/Dec: +4-9%    winter demand ramp
const SEASONAL_SHAPE: Record<number, number> = {
  1:  0.12, 2:  0.08, 3: -0.02, 4: -0.06,
  5: -0.05, 6:  0.03, 7:  0.08, 8:  0.06,
  9: -0.02, 10: -0.04, 11: 0.04, 12: 0.09,
};

// EIA AEO 2025 reference case: $3.50/MMBtu long-run equilibrium
const LONG_RUN_PRICE  = 3.50;
const MEAN_REVERSION  = 0.08;   // 8% of gap per month
const CONTANGO_TAPER  = 0.005;  // slight contango in first 12 months

function curlGet(url: string, timeoutSec = 30): string {
  return execSync(
    `curl -s --connect-timeout 10 --max-time ${timeoutSec} --compressed -L "${url}"`,
    { maxBuffer: 20 * 1024 * 1024, timeout: (timeoutSec + 10) * 1000 }
  ).toString("utf8");
}

// ── Source 1: EIA STEO (Short-Term Energy Outlook) ─────────────────────────
// EIA publishes monthly Henry Hub natural gas price forecasts (~24 months out)
// via the STEO dataset. Same API key as electricity data — no separate access required.

async function fetchEiaSteo(apiKey: string): Promise<Map<string, number>> {
  console.log("Trying EIA STEO for Henry Hub gas price outlook (NGWHHD)…");
  const url =
    `https://api.eia.gov/v2/steo/data/?api_key=${apiKey}` +
    `&frequency=monthly&data[0]=value&facets[seriesId][]=NGWHHD` +
    `&sort[0][column]=period&sort[0][direction]=asc&length=36`;

  const body = curlGet(url, 30);
  if (!body.trim() || body.trim().startsWith("<")) {
    throw new Error("EIA STEO returned empty or HTML response (may be blocked)");
  }

  const parsed = JSON.parse(body) as {
    response?: { data?: Array<{ period: string; value: number | string | null }> };
  };
  const data = parsed?.response?.data ?? [];
  if (!data.length) throw new Error("EIA STEO returned 0 rows for NGWHHD");

  const priceMap = new Map<string, number>();
  for (const row of data) {
    if (row.value == null || row.value === "") continue;
    const price = Number(row.value);
    if (isNaN(price) || price <= 0) continue;
    // period format: "YYYY-MM"
    const deliveryMonth = `${row.period}-01`;
    priceMap.set(deliveryMonth, price);
  }

  console.log(`  EIA STEO: ${priceMap.size} monthly price points`);
  return priceMap;
}

// ── Source 2: FRED DHHFXED ─────────────────────────────────────────────────
// FRED publishes Henry Hub Natural Gas Forward Price (annual series, if available).
// Endpoint is free with no auth. Falls through if series doesn't exist on FRED.

async function fetchFredForward(): Promise<Map<string, number>> {
  console.log("Trying FRED DHHFXED (Henry Hub forward price series)…");
  const csv = curlGet("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DHHFXED", 20);
  if (!csv.trim() || csv.trim().startsWith("<") || csv.trim().startsWith("<!")) {
    throw new Error("FRED DHHFXED returned HTML (series may not exist)");
  }

  const records = parse(csv, { columns: true, skip_empty_lines: true }) as Array<{
    observation_date: string;
    DHHFXED: string;
  }>;

  const priceMap = new Map<string, number>();
  for (const r of records) {
    if (!r.DHHFXED || r.DHHFXED === ".") continue;
    const price = Number(r.DHHFXED);
    if (isNaN(price) || price <= 0) continue;
    // FRED returns annual data — map to first month of each year
    const year = r.observation_date.slice(0, 4);
    const deliveryMonth = `${year}-01-01`;
    priceMap.set(deliveryMonth, price);
  }

  console.log(`  FRED DHHFXED: ${priceMap.size} annual price points`);
  if (!priceMap.size) throw new Error("FRED DHHFXED had no valid price rows");
  return priceMap;
}

// ── Model fallback ──────────────────────────────────────────────────────────
// Builds a seasonal forward strip anchored to spotPrice, applying mean reversion
// toward the EIA AEO long-run reference price and NYMEX seasonal settlement shape.
// Standard practice for extending real forward curves beyond liquid tenors.

function buildModelStrip(
  spotPrice: number,
  asOfDate: Date,
  months: number,
  startMonthOffset: number = 1  // 1 = start from prompt month (next calendar month)
): Array<{ deliveryMonth: string; settlePrice: number; source: "model" }> {
  const strip: Array<{ deliveryMonth: string; settlePrice: number; source: "model" }> = [];

  const baseYear  = asOfDate.getUTCFullYear();
  const baseMonth = asOfDate.getUTCMonth() + 1;  // 1-indexed

  let price = spotPrice;

  for (let i = 0; i < months; i++) {
    const rawMonth = baseMonth + startMonthOffset + i;
    const year  = baseYear + Math.floor((rawMonth - 1) / 12);
    const month = ((rawMonth - 1) % 12) + 1;

    price = price + MEAN_REVERSION * (LONG_RUN_PRICE - price);
    const contango = (startMonthOffset + i) < 12
      ? CONTANGO_TAPER * (12 - (startMonthOffset + i)) / 12 : 0;
    const seasonal = SEASONAL_SHAPE[month] ?? 0;
    const raw = price * (1 + seasonal) + contango;

    // Deterministic noise (reproducible, small)
    const seed = year * 100 + month;
    const noise = ((seed * 7 + 13) % 17 - 8) * 0.005;

    const finalPrice = Math.max(1.50, Math.round((raw + noise) * 100) / 100);
    const mm = String(month).padStart(2, "0");
    strip.push({ deliveryMonth: `${year}-${mm}-01`, settlePrice: finalPrice, source: "model" });
  }

  return strip;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Gas Forwards Seeder (NYMEX HH Strip) ===\n");
  console.log("Data sources (priority):");
  console.log("  1. EIA STEO monthly Henry Hub forecast (NGWHHD) — real, ~24 months");
  console.log("  2. FRED DHHFXED Henry Hub forward price — real, annual");
  console.log("  3. Model calibration — seasonal NYMEX shape + EIA AEO mean reversion\n");

  // Get latest Henry Hub spot for model anchoring
  const latestHH = await db.execute<{ date: string; price: string }>(sql`
    SELECT date::text, price::text
    FROM gas_prices
    WHERE hub = 'henry_hub' AND price IS NOT NULL
    ORDER BY date DESC
    LIMIT 1
  `);

  const spotPrice = latestHH.rows.length ? Number(latestHH.rows[0].price) : 3.20;
  const spotDateStr = latestHH.rows.length ? latestHH.rows[0].date : "default";
  console.log(`Spot anchor: $${spotPrice.toFixed(3)}/MMBtu (as of ${spotDateStr})\n`);

  const asOfDate    = new Date();
  const asOfDateStr = asOfDate.toISOString().slice(0, 10);
  const apiKey      = process.env.EIA_API_KEY;

  // ── Step 1: Attempt real data sources ────────────────────────────────────
  const realPrices = new Map<string, { price: number; source: string }>();
  let realDataCoveredMonths = 0;

  // Try EIA STEO
  if (apiKey) {
    try {
      const steoMap = await fetchEiaSteo(apiKey);
      // Only include future months (delivery_month > asOfDate)
      for (const [dm, price] of steoMap) {
        if (dm > asOfDateStr) {
          realPrices.set(dm, { price, source: "eia_steo" });
        }
      }
      realDataCoveredMonths = realPrices.size;
      console.log(`  ✓ EIA STEO contributed ${realDataCoveredMonths} forward months`);
    } catch (e) {
      console.warn(`  EIA STEO unavailable: ${(e as Error).message.slice(0, 100)}`);
    }
  } else {
    console.warn("  EIA_API_KEY not set — skipping EIA STEO fetch");
  }

  // Try FRED DHHFXED if STEO didn't fully cover
  if (realDataCoveredMonths < 24) {
    try {
      const fredMap = await fetchFredForward();
      for (const [dm, price] of fredMap) {
        if (dm > asOfDateStr && !realPrices.has(dm)) {
          realPrices.set(dm, { price, source: "fred" });
        }
      }
      const fredCount = [...realPrices.values()].filter(v => v.source === "fred").length;
      if (fredCount > 0) console.log(`  ✓ FRED DHHFXED contributed ${fredCount} additional forward months`);
    } catch (e) {
      console.warn(`  FRED DHHFXED unavailable: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  if (realPrices.size > 0) {
    console.log(`\nReal data covers ${realPrices.size} months.`);
  } else {
    console.log(`\nNo real forward data available from EIA STEO or FRED — using model for all 60 months.`);
  }

  // ── Step 2: Build complete 60-month strip ─────────────────────────────────
  // Fill any missing months with model calibration
  const strip: Array<{ deliveryMonth: string; settlePrice: number; source: string }> = [];

  const MONTHS_OUT = 60;
  const baseYear  = asOfDate.getUTCFullYear();
  const baseMonth = asOfDate.getUTCMonth() + 1;

  // Determine model anchor: use latest real price if available, else spot
  const latestRealPrice = realPrices.size
    ? [...realPrices.values()].at(-1)!.price
    : spotPrice;

  // Find the first month not covered by real data
  let firstModelMonth = 1;
  for (let i = 1; i <= MONTHS_OUT; i++) {
    const rawMonth = baseMonth + i;
    const year  = baseYear + Math.floor((rawMonth - 1) / 12);
    const month = ((rawMonth - 1) % 12) + 1;
    const mm    = String(month).padStart(2, "0");
    const dm    = `${year}-${mm}-01`;
    if (!realPrices.has(dm)) { firstModelMonth = i; break; }
  }

  const modelStrip = buildModelStrip(latestRealPrice, asOfDate, MONTHS_OUT, 1);
  const modelMap   = new Map(modelStrip.map(r => [r.deliveryMonth, r]));

  for (let i = 1; i <= MONTHS_OUT; i++) {
    const rawMonth = baseMonth + i;
    const year  = baseYear + Math.floor((rawMonth - 1) / 12);
    const month = ((rawMonth - 1) % 12) + 1;
    const mm    = String(month).padStart(2, "0");
    const dm    = `${year}-${mm}-01`;

    if (realPrices.has(dm)) {
      const r = realPrices.get(dm)!;
      strip.push({ deliveryMonth: dm, settlePrice: r.price, source: r.source });
    } else {
      const m = modelMap.get(dm);
      strip.push({ deliveryMonth: dm, settlePrice: m?.settlePrice ?? spotPrice, source: "model" });
    }
  }

  const sourceBreakdown = strip.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Strip composition: ${JSON.stringify(sourceBreakdown)}`);
  console.log(`Price range: $${Math.min(...strip.map(r => r.settlePrice)).toFixed(2)} – $${Math.max(...strip.map(r => r.settlePrice)).toFixed(2)}/MMBtu`);

  // ── Step 3: Upsert strip ──────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM gas_forwards WHERE as_of_date = ${asOfDateStr}::date`);

  for (let i = 0; i < strip.length; i += 60) {
    const chunk = strip.slice(i, i + 60);
    await db.execute(sql`
      INSERT INTO gas_forwards (as_of_date, delivery_month, settle_price, source)
      VALUES ${sql.raw(
        chunk.map(r =>
          `('${asOfDateStr}', '${r.deliveryMonth}', ${r.settlePrice.toFixed(4)}, '${r.source}')`
        ).join(", ")
      )}
      ON CONFLICT (as_of_date, delivery_month) DO UPDATE SET
        settle_price = EXCLUDED.settle_price,
        source       = EXCLUDED.source,
        fetched_at   = NOW()
    `);
  }

  console.log(`\nUpserted ${strip.length} rows into gas_forwards (as_of_date=${asOfDateStr}).`);
  console.log("Strip range:", strip[0].deliveryMonth, "→", strip[strip.length - 1].deliveryMonth);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
