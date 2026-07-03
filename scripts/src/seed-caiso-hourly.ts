/**
 * seed-caiso-hourly.ts
 *
 * Seeds CAISO DA + RT hourly LMP data from CAISO OASIS public API.
 * No authentication required — fully public endpoint.
 *
 * Nodes: TH_SP15_GEN-APND (SP15), TH_NP15_GEN-APND (NP15), TH_ZP26_GEN-APND (ZP26)
 * Coverage: Jan 2024 → May 2026 (~29 months × 3 nodes × ~720 hrs ≈ 63k rows)
 *
 * CAISO OASIS notes:
 * - Max 31-day window per request
 * - DA market_run_id = DAM, RT market_run_id = HASP (5-min intervals, avg to hourly)
 * - Some months return 114-byte empty response → skip gracefully
 * - ZIP streaming: compSize may be 0 in local header; read from central directory
 */

import { db } from "@workspace/db";
import { caisoHubHourlyTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as https from "node:https";
import * as zlib from "node:zlib";

const OASIS = "https://oasis.caiso.com/oasisapi/SingleZip";

const NODES = [
  { id: "TH_SP15_GEN-APND", label: "SP15" },
  { id: "TH_NP15_GEN-APND", label: "NP15" },
  { id: "TH_ZP26_GEN-APND", label: "ZP26" },
];

const YEARS_MONTHS: Array<{ year: number; month: number }> = [];
for (const year of [2024, 2025]) {
  for (let m = 1; m <= 12; m++) YEARS_MONTHS.push({ year, month: m });
}
for (let m = 1; m <= 6; m++) YEARS_MONTHS.push({ year: 2026, month: m });

function padZero(n: number) { return n.toString().padStart(2, "0"); }

function utcOffset(month: number): string {
  return month >= 3 && month <= 10 ? "-0700" : "-0800";
}

function oasisUrl(nodeId: string, queryname: string, marketRunId: string, year: number, month: number): string {
  const off = utcOffset(month);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const start = `${year}${padZero(month)}01T00:00${off}`;
  const end = `${nextYear}${padZero(nextMonth)}01T00:00${off}`;
  return `${OASIS}?queryname=${queryname}&version=1&market_run_id=${marketRunId}&startdatetime=${start}&enddatetime=${end}&node=${encodeURIComponent(nodeId)}&resultformat=6`;
}

function downloadBuffer(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res): void => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        void downloadBuffer(res.headers.location, redirects + 1).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
      res.on("error", (err) => settle(() => reject(err)));
    });
    req.on("error", (err) => settle(() => reject(err)));
    req.setTimeout(20_000, () => { settle(() => reject(new Error("Download timeout"))); req.destroy(); });
  });
}

function extractCsvFromZip(buf: Buffer): string | null {
  if (buf.length < 100) return null;
  // Find end-of-central-directory record
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOff) !== 0x02014b50) return null;
  // Read compSize from central directory (authoritative even when local header shows 0)
  const compSize = buf.readUInt32LE(cdOff + 20);
  const fnLen = buf.readUInt16LE(cdOff + 28);
  const localOff = buf.readUInt32LE(cdOff + 42);
  const fn = buf.slice(cdOff + 46, cdOff + 46 + fnLen).toString();
  if (fn.includes("INVALID")) return null;
  const lFnLen = buf.readUInt16LE(localOff + 26);
  const lExLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lFnLen + lExLen;
  if (compSize === 0) return null;
  try {
    return zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString("utf8");
  } catch {
    return null;
  }
}

interface RawRow {
  date: string;   // "YYYY-MM-DD"
  hour: number;   // 1..24
  price: number;
}

function parseCsv(csv: string): RawRow[] {
  const lines = csv.split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(s => s.trim());
  const idxDate = header.indexOf("OPR_DT");
  const idxHour = header.indexOf("OPR_HR");
  const idxType = header.indexOf("LMP_TYPE");
  const idxMW   = header.indexOf("MW");
  if (idxDate < 0 || idxHour < 0 || idxMW < 0) return [];
  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 3) continue;
    const lmpType = idxType >= 0 ? parts[idxType]?.trim() : "LMP";
    if (lmpType !== "LMP") continue;
    const price = parseFloat(parts[idxMW]);
    if (isNaN(price)) continue;
    const hour = parseInt(parts[idxHour], 10);
    if (isNaN(hour)) continue;
    rows.push({ date: parts[idxDate]?.trim() ?? "", hour, price });
  }
  return rows;
}

// Group raw rows by (date, hour) → average (handles 5-min RT intervals)
function average(rows: RawRow[]): RawRow[] {
  const map = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.date}|${r.hour}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r.price);
  }
  return Array.from(map.entries()).map(([k, prices]) => {
    const [date, hourStr] = k.split("|");
    return { date, hour: parseInt(hourStr, 10), price: prices.reduce((s, v) => s + v, 0) / prices.length };
  });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchMonthHourly(nodeId: string, marketRunId: string, year: number, month: number): Promise<RawRow[]> {
  // DA uses PRC_LMP + DAM; RT uses PRC_HASP_LMP + HASP
  const queryname = marketRunId === "DAM" ? "PRC_LMP" : "PRC_HASP_LMP";
  const mrId = marketRunId === "DAM" ? "DAM" : "HASP";
  const url = oasisUrl(nodeId, queryname, mrId, year, month);
  const buf = await downloadBuffer(url);
  if (buf.length < 200) return [];  // empty / rate-limited response
  const csv = extractCsvFromZip(buf);
  if (!csv) return [];
  return average(parseCsv(csv));
}

async function main() {
  console.log("=== CAISO Hub Hourly Seed ===");
  console.log("Nodes: SP15, NP15, ZP26 · DA + RT · Jan 2024–Jun 2026\n");

  // Check existing rows — skip only months that have BOTH da_price and rt_price populated
  const existingRows = await db.execute<{ node: string; year: number; month: number; has_rt: string }>(
    sql`SELECT node, year, month,
           MAX(CASE WHEN rt_price IS NOT NULL THEN 1 ELSE 0 END)::text AS has_rt
        FROM caiso_hub_hourly
        GROUP BY node, year, month`
  );
  // Only skip months where RT is already populated
  const existingKeys = new Set(
    existingRows.rows.filter(r => r.has_rt === "1").map(r => `${r.node}|${r.year}|${r.month}`)
  );
  const daOnlyKeys = new Set(
    existingRows.rows.filter(r => r.has_rt === "0").map(r => `${r.node}|${r.year}|${r.month}`)
  );
  console.log(`Fully seeded (DA+RT): ${existingKeys.size} node-months.`);
  console.log(`DA-only (will re-run RT fetch): ${daOnlyKeys.size} node-months.\n`);

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const node of NODES) {
    console.log(`\n── Node: ${node.label} (${node.id})`);

    for (const { year, month } of YEARS_MONTHS) {
      const label = `${year}-${padZero(month)}`;

      if (existingKeys.has(`${node.label}|${year}|${month}`)) {
        process.stdout.write(`  ${label}: skip ✓\n`);
        totalSkipped++;
        continue;
      }

      process.stdout.write(`  ${label}: fetching DA...`);
      let daRows: RawRow[] = [];
      let rtRows: RawRow[] = [];

      try {
        daRows = await fetchMonthHourly(node.id, "DAM", year, month);
        process.stdout.write(` ${daRows.length} rows.`);
      } catch (err) {
        process.stdout.write(` DA ERROR: ${err}\n`);
        await sleep(5000);
        continue;
      }

      process.stdout.write(` RT...`);
      try {
        await sleep(1000); // be polite to OASIS
        rtRows = await fetchMonthHourly(node.id, "RTM", year, month);
        process.stdout.write(` ${rtRows.length} rows.`);
      } catch (err) {
        process.stdout.write(` RT ERROR (${err}) — saving DA-only.\n`);
        await sleep(2000);
      }

      if (daRows.length === 0 && rtRows.length === 0) {
        process.stdout.write(` empty — skip.\n`);
        totalSkipped++;
        await sleep(1000);
        continue;
      }

      // Merge DA + RT into per-(date, hour) records
      const daMap = new Map(daRows.map(r => [`${r.date}|${r.hour}`, r.price]));
      const rtMap = new Map(rtRows.map(r => [`${r.date}|${r.hour}`, r.price]));
      const allKeys = new Set([...daMap.keys(), ...rtMap.keys()]);

      const inserts: Array<typeof caisoHubHourlyTable.$inferInsert> = [];
      for (const k of allKeys) {
        const [dateStr, hourStr] = k.split("|");
        const d = new Date(dateStr + "T12:00:00Z");
        inserts.push({
          node:     node.label,
          nodeType: "hub",
          year,
          month,
          day:      d.getUTCDate(),
          hour:     parseInt(hourStr, 10),
          daPrice:  daMap.has(k) ? String(daMap.get(k)!.toFixed(4)) : null,
          rtPrice:  rtMap.has(k) ? String(rtMap.get(k)!.toFixed(4)) : null,
        });
      }

      if (inserts.length === 0) {
        process.stdout.write(` nothing to insert.\n`);
        continue;
      }

      // Batch upsert in chunks of 500 — updates rt_price on existing DA-only rows
      const CHUNK = 500;
      let inserted = 0;
      for (let i = 0; i < inserts.length; i += CHUNK) {
        const chunk = inserts.slice(i, i + CHUNK);
        await db.insert(caisoHubHourlyTable)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              caisoHubHourlyTable.node,
              caisoHubHourlyTable.year,
              caisoHubHourlyTable.month,
              caisoHubHourlyTable.day,
              caisoHubHourlyTable.hour,
            ],
            set: { rtPrice: sql`EXCLUDED.rt_price` },
          });
        inserted += chunk.length;
      }
      totalInserted += inserted;
      process.stdout.write(` ✓ inserted ${inserted}\n`);

      await sleep(800); // rate-limit between months
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Inserted: ${totalInserted} rows`);
  console.log(`Skipped:  ${totalSkipped} node-months (already in DB)`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
