/**
 * Seed regional wholesale power price forecast — EIA STEO.
 *
 * NOT a tradeable market quote. Real ERCOT/CAISO hub power futures trade on
 * ICE/Nodal behind paid feeds with no free public source (checked the
 * commodity API connected to this project — it covers only Henry Hub, Brent,
 * WTI, TTF; no regional US power). This is the best available free
 * alternative: EIA's own monthly wholesale price forecast, one series per
 * ISO region, published through the same STEO API already used for the
 * Henry Hub gas forward strip (seed-gas-forwards.ts).
 *
 * Series confirmed live against the EIA API via
 * scripts/src/discover-eia-series.ts (2026-07) — do not change these
 * without re-running that discovery script first:
 *   ERCOT → ELWHU_TX  "Wholesale Electricity Price, ERCOT (Texas) ISO North hub"
 *   CAISO → ELWHU_CA  "Wholesale Electricity Price, CAISO (California ISO) SP15 zone"
 *
 * Network note: Node.js https.get is blocked in this env — shell out to curl
 * (same workaround as every other EIA/FRED seeder in this repo).
 *
 * Run: pnpm --filter @workspace/scripts seed-power-forwards
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { execSync } from "child_process";

const SERIES: Record<string, string> = {
  ERCOT: "ELWHU_TX",
  CAISO: "ELWHU_CA",
};

function curlGet(url: string, timeoutSec = 30): string {
  return execSync(
    `curl -s --connect-timeout 10 --max-time ${timeoutSec} --compressed -L "${url}"`,
    { maxBuffer: 20 * 1024 * 1024, timeout: (timeoutSec + 10) * 1000 },
  ).toString("utf8");
}

async function fetchSteoSeries(seriesId: string): Promise<Map<string, number>> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error("EIA_API_KEY not set");

  const url =
    `https://api.eia.gov/v2/steo/data/?api_key=${apiKey}` +
    `&frequency=monthly&data[0]=value&facets[seriesId][]=${seriesId}` +
    `&sort[0][column]=period&sort[0][direction]=asc&length=60`;

  const body = curlGet(url, 30);
  if (!body.trim() || body.trim().startsWith("<")) {
    throw new Error(`EIA STEO returned empty/HTML for ${seriesId}`);
  }

  const parsed = JSON.parse(body) as {
    response?: { data?: Array<{ period: string; value: number | string | null }> };
  };
  const data = parsed?.response?.data ?? [];
  if (!data.length) throw new Error(`EIA STEO returned 0 rows for ${seriesId}`);

  const priceMap = new Map<string, number>();
  for (const row of data) {
    if (row.value == null || row.value === "") continue;
    const price = Number(row.value);
    if (isNaN(price) || price <= 0) continue;
    const deliveryMonth = `${row.period}-01`; // period format: "YYYY-MM"
    priceMap.set(deliveryMonth, price);
  }
  return priceMap;
}

async function upsertMarket(market: string, priceMap: Map<string, number>, asOfDate: string, seriesId: string) {
  if (!priceMap.size) return 0;
  const rows = [...priceMap.entries()].map(([deliveryMonth, price]) => ({
    market, asOfDate, deliveryMonth, priceMwh: price, source: "eia_steo", seriesId,
  }));
  const PAGE = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE);
    await db.execute(sql`
      INSERT INTO power_forwards (market, as_of_date, delivery_month, price_mwh, source, series_id)
      VALUES ${sql.raw(
        chunk.map((r) =>
          `('${r.market}', '${r.asOfDate}', '${r.deliveryMonth}', ${r.priceMwh.toFixed(4)}, '${r.source}', '${r.seriesId}')`,
        ).join(", "),
      )}
      ON CONFLICT (market, as_of_date, delivery_month) DO UPDATE SET
        price_mwh  = EXCLUDED.price_mwh,
        source     = EXCLUDED.source,
        series_id  = EXCLUDED.series_id,
        fetched_at = now()
    `);
    total += chunk.length;
  }
  return total;
}

async function main() {
  console.log("=== Power Forwards Seed (EIA STEO wholesale price forecast) ===\n");
  const asOfDate = new Date().toISOString().slice(0, 10);

  for (const [market, seriesId] of Object.entries(SERIES)) {
    console.log(`[${market}] Fetching ${seriesId}...`);
    try {
      const priceMap = await fetchSteoSeries(seriesId);
      console.log(`  ${priceMap.size} monthly points`);
      const n = await upsertMarket(market, priceMap, asOfDate, seriesId);
      console.log(`  ✓ upserted ${n} rows (as_of ${asOfDate})\n`);
    } catch (err) {
      console.error(`  ✗ ${market} failed: ${(err as Error).message}\n`);
    }
  }

  const summary = await db.execute<{ market: string; n: string; lo: string; hi: string }>(sql`
    SELECT market, COUNT(*)::text AS n, MIN(delivery_month)::text AS lo, MAX(delivery_month)::text AS hi
    FROM power_forwards
    WHERE as_of_date = ${asOfDate}
    GROUP BY market
  `);
  console.log("=== Summary (this run) ===");
  for (const r of summary.rows) console.log(`  ${r.market}: ${r.n} months, ${r.lo} → ${r.hi}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
