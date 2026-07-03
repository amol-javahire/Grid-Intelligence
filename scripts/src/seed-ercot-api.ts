/**
 * seed-ercot-api.ts
 *
 * Seeds REAL ERCOT historical settlement point prices via the ERCOT Developer API.
 * Covers: May 2025 – May 2026 (13 months), resource nodes + hubs + load zones.
 *
 * Endpoints (discovered via API introspection):
 *   RT: GET https://api.ercot.com/api/public-reports/np6-905-cd/spp_node_zone_hub
 *       Fields: [deliveryDate, deliveryHour, deliveryInterval, settlementPoint,
 *                settlementPointType, settlementPointPrice, DSTFlag]
 *
 *   DA: GET https://api.ercot.com/api/public-reports/np4-190-cd/dam_stlmnt_pnt_prices
 *       Fields: [deliveryDate, hourEnding, settlementPoint, settlementPointPrice, DSTFlag]
 *
 *   Auth: B2C ROPC flow — ERCOT_CLIENT_ID, ERCOT_USERNAME, ERCOT_PASSWORD
 *   Header: Ocp-Apim-Subscription-Key: ERCOT_SUBSCRIPTION_KEY
 */

import { db, ercotNodeStatsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import * as https from "node:https";

const CLIENT_ID = process.env.ERCOT_CLIENT_ID;
const USERNAME  = process.env.ERCOT_USERNAME;
const PASSWORD  = process.env.ERCOT_PASSWORD;
const SUB_KEY   = process.env.ERCOT_SUBSCRIPTION_KEY;

if (!CLIENT_ID || !USERNAME || !PASSWORD || !SUB_KEY) {
  console.error("ERROR: Missing ERCOT_CLIENT_ID, ERCOT_USERNAME, ERCOT_PASSWORD, or ERCOT_SUBSCRIPTION_KEY");
  process.exit(1);
}

// ── Date range ────────────────────────────────────────────────────────────────
// Gap-fill: only seed months missing or partial in the DB.
// Full history (Jan 2024 – Apr 2026) already seeded. Fetching only the gaps.
const MONTHS: Array<{ year: number; month: number }> = [];
for (let m = 5; m <= 5; m++)  MONTHS.push({ year: 2026, month: m }); // May 2026 only; run again for June

function padZ(n: number) { return String(n).padStart(2, "0"); }
function daysInMonth(y: number, m: number) { return new Date(y, m, 0).getDate(); }

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
      res.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    });
    req.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    req.write(body);
    req.end();
  });
}

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    https.get(url, { headers }, (res): void => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        void httpsGet(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
      res.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    }).on("error", (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

// ── Auth: B2C ROPC flow ───────────────────────────────────────────────────────
async function getIdToken(): Promise<string> {
  console.log("Authenticating with ERCOT B2C…");
  const body = new URLSearchParams({
    username: USERNAME!,
    password: PASSWORD!,
    grant_type: "password",
    scope: `openid ${CLIENT_ID} offline_access`,
    client_id: CLIENT_ID!,
    response_type: "id_token",
  }).toString();
  const tokenUrl = "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";
  const resp = await httpsPost(tokenUrl, body, { "Content-Type": "application/x-www-form-urlencoded" });
  const parsed = JSON.parse(resp) as { id_token?: string; access_token?: string; error?: string; error_description?: string };
  if (parsed.error) throw new Error(`B2C auth failed: ${parsed.error} — ${parsed.error_description}`);
  const token = parsed.id_token ?? parsed.access_token;
  if (!token) throw new Error(`No token in B2C response: ${resp.slice(0, 200)}`);
  console.log("  ✓ Auth token obtained");
  return token;
}

// ── Parsed row types ──────────────────────────────────────────────────────────
// RT:  [deliveryDate, deliveryHour, deliveryInterval, settlementPoint, settlementPointType, settlementPointPrice, DSTFlag]
// DAM: [deliveryDate, hourEnding, settlementPoint, settlementPointPrice, DSTFlag]
interface RtRow  { date: string; hour: number; node: string; type: string; price: number; }
interface DamRow { date: string; hour: number; node: string; price: number; }

// ── Fetch with full pagination ────────────────────────────────────────────────
// Extract "Try again in N seconds" from a 429 message
function parseRetryAfter(message: string): number {
  const m = message.match(/try again in (\d+)/i);
  return m ? (parseInt(m[1], 10) + 2) * 1000 : 30_000;
}

async function fetchAllPages<T>(
  token: string,
  baseUrl: string,
  params: Record<string, string>,
  parseRow: (arr: unknown[]) => T | null,
  _label: string,
): Promise<T[]> {
  const authHeaders = {
    "Authorization": `Bearer ${token}`,
    "Ocp-Apim-Subscription-Key": SUB_KEY!,
    "Accept": "application/json",
  };

  let page = 1;
  let totalPages = 1;
  const results: T[] = [];

  do {
    const qs = new URLSearchParams({ ...params, size: "100000", page: String(page) }).toString();
    let respText: string;
    let attempts = 0;

    // Retry loop for 429 rate limiting
    while (true) {
      respText = await httpsGet(`${baseUrl}?${qs}`, authHeaders);
      const quick = JSON.parse(respText) as { statusCode?: number; message?: string };
      if (quick.statusCode === 429) {
        const wait = parseRetryAfter(quick.message ?? "");
        process.stdout.write(` [rate-limit: wait ${Math.round(wait/1000)}s]`);
        await sleep(wait);
        attempts++;
        if (attempts > 5) throw new Error(`Too many 429s: ${quick.message}`);
        continue;
      }
      break;
    }

    const resp = JSON.parse(respText) as {
      _meta?: { totalPages?: number };
      data?: unknown[][];
      statusCode?: number;
      message?: string;
    };
    if (resp.statusCode && resp.statusCode >= 400) {
      throw new Error(`API ${resp.statusCode}: ${resp.message}`);
    }
    totalPages = resp._meta?.totalPages ?? 1;
    for (const row of resp.data ?? []) {
      const parsed = parseRow(row);
      if (parsed !== null) results.push(parsed);
    }
    if (page % 50 === 0) process.stdout.write(` (p${page}/${totalPages})`);
    page++;
    if (page <= totalPages) await sleep(1_400); // ~0.7 req/s to stay under rate cap
  } while (page <= totalPages);

  return results;
}

// ── Aggregation ───────────────────────────────────────────────────────────────
interface Agg { rt: number[]; da: number[]; onPk: number[]; offPk: number[] }
type Key = `${string}|${number}|${number}`;

function isOnPeak(dateStr: string, hour: number): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 5 && hour >= 7 && hour <= 22;
}
function mean(a: number[]) { return a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length; }
function stddev(a: number[]) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

function accumulateRt(rows: RtRow[], aggMap: Map<Key, Agg>) {
  for (const row of rows) {
    if (!row.node || !row.date) continue;
    const d = new Date(row.date + "T00:00:00Z");
    if (isNaN(d.getTime())) continue;
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
    const k: Key = `${row.node}|${year}|${month}`;
    if (!aggMap.has(k)) aggMap.set(k, { rt: [], da: [], onPk: [], offPk: [] });
    const agg = aggMap.get(k)!;
    agg.rt.push(row.price);
    if (isOnPeak(row.date, row.hour)) agg.onPk.push(row.price);
    else agg.offPk.push(row.price);
  }
}

function accumulateDa(rows: DamRow[], aggMap: Map<Key, Agg>) {
  for (const row of rows) {
    if (!row.node || !row.date) continue;
    const d = new Date(row.date + "T00:00:00Z");
    if (isNaN(d.getTime())) continue;
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
    const k: Key = `${row.node}|${year}|${month}`;
    if (!aggMap.has(k)) aggMap.set(k, { rt: [], da: [], onPk: [], offPk: [] });
    aggMap.get(k)!.da.push(row.price);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== ERCOT API Historical Seed ===");
  console.log(`Coverage: ${MONTHS[0].year}-${padZ(MONTHS[0].month)} – ${MONTHS[MONTHS.length-1].year}-${padZ(MONTHS[MONTHS.length-1].month)} (${MONTHS.length} months)\n`);
  console.log("Endpoints:");
  console.log("  RT:  np6-905-cd/spp_node_zone_hub");
  console.log("  DAM: np4-190-cd/dam_stlmnt_pnt_prices\n");

  const token = await getIdToken();
  const aggMap = new Map<Key, Agg>();

  for (const { year, month } of MONTHS) {
    const lastDay = daysInMonth(year, month);
    const dateFrom = `${year}-${padZ(month)}-01`;
    const dateTo   = `${year}-${padZ(month)}-${padZ(lastDay)}`;
    const label    = `${year}-${padZ(month)}`;

    // ── RT ────────────────────────────────────────────────────────────────────
    process.stdout.write(`[${label}] RT … `);
    try {
      const rtRows = await fetchAllPages<RtRow>(
        token,
        "https://api.ercot.com/api/public-reports/np6-905-cd/spp_node_zone_hub",
        { deliveryDateFrom: dateFrom, deliveryDateTo: dateTo },
        (arr) => {
          // [deliveryDate, deliveryHour, deliveryInterval, settlementPoint, settlementPointType, settlementPointPrice, DSTFlag]
          if (!Array.isArray(arr) || arr.length < 6) return null;
          return {
            date:  String(arr[0]),
            hour:  Number(arr[1]),
            node:  String(arr[3]),
            type:  String(arr[4]),
            price: Number(arr[5]),
          };
        },
        `${label} RT`,
      );
      accumulateRt(rtRows, aggMap);
      process.stdout.write(` ${rtRows.length.toLocaleString()} rows ✓\n`);
    } catch (e: unknown) {
      process.stdout.write(` ERROR: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}\n`);
    }
    await sleep(500);

    // ── DAM ───────────────────────────────────────────────────────────────────
    process.stdout.write(`[${label}] DA … `);
    try {
      const daRows = await fetchAllPages<DamRow>(
        token,
        "https://api.ercot.com/api/public-reports/np4-190-cd/dam_stlmnt_pnt_prices",
        { deliveryDateFrom: dateFrom, deliveryDateTo: dateTo },
        (arr) => {
          // [deliveryDate, hourEnding, settlementPoint, settlementPointPrice, DSTFlag]
          if (!Array.isArray(arr) || arr.length < 4) return null;
          const hourRaw = String(arr[1]); // e.g. "01:00"
          const hour = parseInt(hourRaw.split(":")[0] ?? "0", 10);
          return {
            date:  String(arr[0]),
            hour,
            node:  String(arr[2]),
            price: Number(arr[3]),
          };
        },
        `${label} DA`,
      );
      accumulateDa(daRows, aggMap);
      process.stdout.write(` ${daRows.length.toLocaleString()} rows ✓\n`);
    } catch (e: unknown) {
      process.stdout.write(` ERROR: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}\n`);
    }
    await sleep(500);
  }

  console.log(`\nAggregated ${aggMap.size.toLocaleString()} (node × month) combinations`);

  // ── Delete existing resource_node rows for covered months ─────────────────
  console.log("Clearing existing resource_node rows for covered months…");
  for (const { year, month } of MONTHS) {
    await db.delete(ercotNodeStatsTable).where(
      and(
        eq(ercotNodeStatsTable.nodeType, "resource_node"),
        eq(ercotNodeStatsTable.year, year),
        eq(ercotNodeStatsTable.month, month),
      )
    );
  }

  // ── Build and insert aggregated rows ──────────────────────────────────────
  const insertRows: typeof ercotNodeStatsTable.$inferInsert[] = [];

  for (const [k, agg] of aggMap.entries()) {
    const [node, ys, ms] = k.split("|");
    const year = Number(ys), month = Number(ms);
    if (!node || isNaN(year) || isNaN(month)) continue;

    const avgRt  = mean(agg.rt.length > 0 ? agg.rt : agg.da);
    const avgDa  = mean(agg.da.length > 0 ? agg.da : agg.rt);
    const rtPrices = agg.rt.length > 0 ? agg.rt : agg.da;
    const sd     = stddev(rtPrices);
    const onPk   = agg.onPk.length  > 0 ? mean(agg.onPk)  : avgRt;
    const offPk  = agg.offPk.length > 0 ? mean(agg.offPk) : avgRt;
    const allPrices = [...agg.rt, ...agg.da];
    const negPct = allPrices.length > 0 ? (allPrices.filter(p => p < 0).length / allPrices.length) * 100 : 0;
    const minP   = rtPrices.length > 0 ? Math.min(...rtPrices) : 0;
    const maxP   = rtPrices.length > 0 ? Math.max(...rtPrices) : 0;

    // Determine node type from the RT type field (stored in aggMap key context)
    // We use "resource_node" for RN types, "hub" for HB, "load_zone" for LZ
    // Since type comes from RT rows, all entries in aggMap are as-seen
    const nodeLower = node.toLowerCase();
    let nodeType = "resource_node";
    if (nodeLower.startsWith("hb_")) nodeType = "hub";
    else if (nodeLower.startsWith("lz_")) nodeType = "load_zone";

    insertRows.push({
      node, nodeType, year, month,
      avgDaPrice:       avgDa.toFixed(4),
      avgRtPrice:       avgRt.toFixed(4),
      volatility:       sd.toFixed(4),
      negPricePercent:  negPct.toFixed(3),
      onPeakAvg:        onPk.toFixed(4),
      offPeakAvg:       offPk.toFixed(4),
      minPrice:         minP.toFixed(4),
      maxPrice:         maxP.toFixed(4),
    });
  }

  console.log(`Inserting ${insertRows.length.toLocaleString()} rows…`);
  for (let i = 0; i < insertRows.length; i += 500) {
    await db.insert(ercotNodeStatsTable).values(insertRows.slice(i, i + 500));
    process.stdout.write(`\r  ${Math.min(i + 500, insertRows.length)}/${insertRows.length}`);
  }

  const totalCount = await db.select({ count: sql<number>`count(*)` }).from(ercotNodeStatsTable);
  console.log(`\n\n✓ Done. DB total: ${totalCount[0]?.count} ercot_node_stats rows`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
