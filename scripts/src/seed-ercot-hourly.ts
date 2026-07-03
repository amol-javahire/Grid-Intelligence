/**
 * seed-ercot-hourly.ts
 *
 * Extracts HOURLY DA + RT prices for all 15 ERCOT hub/zone settlement points
 * from CDR reports 13060 (DAM) and 13061 (RTM).
 *
 * RTM: 15-min intervals per hour → averaged to hourly.
 * DAM: already hourly.
 *
 * Stores to ercot_hub_hourly table.
 * ~240,000 rows expected (15 nodes × ~2.25 years × 8,760 hr/yr)
 */

import { db } from "@workspace/db";
import { ercotHubHourlyTable } from "@workspace/db";
import * as https from "node:https";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";

const CACHE_DIR = "/tmp/ercot-hourly-cache";

const CDR = "https://www.ercot.com/misdownload/servlets/mirDownload?mimic_duns=000000000&doclookupId=";

const RTM_IDS: Record<number, string> = { // CDR 13061 — updated July 2026
  2024: "1065471230",
  2025: "1177737535",
  2026: "1243904638",
};
const DAM_IDS: Record<number, string> = { // CDR 13060 — updated July 2026
  2024: "1065468714",
  2025: "1177667469",
  2026: "1243902715",
};

const HUB_ZONE_NODES = new Set([
  "HB_BUSAVG","HB_HOUSTON","HB_HUBAVG","HB_NORTH","HB_PAN","HB_SOUTH","HB_WEST",
  "LZ_AEN","LZ_CPS","LZ_HOUSTON","LZ_LCRA","LZ_NORTH","LZ_RAYBN","LZ_SOUTH","LZ_WEST",
]);

function nodeType(sp: string): "hub" | "load_zone" {
  return sp.startsWith("HB_") ? "hub" : "load_zone";
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
      res.on("error", (e) => settle(() => reject(e)));
    });
    req.on("error", (e) => settle(() => reject(e)));
    req.setTimeout(90_000, () => { settle(() => reject(new Error("Download timeout"))); req.destroy(); });
  });
}

function extractXlsxFromZip(buf: Buffer): Buffer {
  let eocdOff = buf.length - 22;
  while (eocdOff >= 0 && buf.readUInt32LE(eocdOff) !== 0x06054b50) eocdOff--;
  if (eocdOff < 0) throw new Error("No EOCD in ZIP");
  let cdOff = buf.readUInt32LE(eocdOff + 16);
  const z64Loc = eocdOff - 20;
  if (z64Loc >= 0 && buf.readUInt32LE(z64Loc) === 0x07064b50) {
    const z64Pos = buf.readUInt32LE(z64Loc + 8) + buf.readUInt32LE(z64Loc + 12) * 4294967296;
    if (z64Pos < buf.length && buf.readUInt32LE(z64Pos) === 0x06064b50)
      cdOff = buf.readUInt32LE(z64Pos + 48) + buf.readUInt32LE(z64Pos + 52) * 4294967296;
  }
  let compSize = buf.readUInt32LE(cdOff + 20);
  let localOff = buf.readUInt32LE(cdOff + 42);
  const fnLen = buf.readUInt16LE(cdOff + 28), extraLen = buf.readUInt16LE(cdOff + 30);
  let ep = cdOff + 46 + fnLen, eEnd = ep + extraLen;
  while (ep < eEnd - 3) {
    const tag = buf.readUInt16LE(ep), sz = buf.readUInt16LE(ep + 2);
    if (tag === 0x0001) {
      let p = ep + 4;
      const usz = buf.readUInt32LE(cdOff + 24);
      if (usz === 0xFFFFFFFF && p + 8 <= ep + 4 + sz) p += 8;
      if (compSize === 0xFFFFFFFF && p + 8 <= ep + 4 + sz) { compSize = buf.readUInt32LE(p) + buf.readUInt32LE(p+4)*4294967296; p += 8; }
      if (localOff === 0xFFFFFFFF && p + 8 <= ep + 4 + sz) localOff = buf.readUInt32LE(p) + buf.readUInt32LE(p+4)*4294967296;
    }
    ep += 4 + sz;
  }
  const lFnLen = buf.readUInt16LE(localOff + 26), lExLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lFnLen + lExLen;
  return zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize));
}

function parseDate(s: string): { year: number; month: number; day: number } {
  const [mm, dd, yyyy] = s.split("/").map(Number);
  return { year: yyyy, month: mm, day: dd };
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// key: "SP|YYYY|MM|DD|HH"
type HourKey = string;
type HourAgg = { da: number[]; rt: number[] };

function hkey(sp: string, year: number, month: number, day: number, hour: number): HourKey {
  return `${sp}|${year}|${month}|${day}|${hour}`;
}

function parseRtmSheet(ws: XLSX.WorkSheet, map: Map<HourKey, HourAgg>) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as (string | number)[][];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 7) continue;
    const dateStr = r[0] as string;
    const hourRaw = r[1];
    const flag = r[3] as string;
    const sp = r[4] as string;
    const price = Number(r[6]);
    if (flag === "Y" || !sp || isNaN(price) || !dateStr?.includes("/")) continue;
    if (!HUB_ZONE_NODES.has(sp)) continue;
    const { year, month, day } = parseDate(dateStr);
    const hour = typeof hourRaw === "number" ? hourRaw : parseInt(String(hourRaw));
    if (isNaN(hour)) continue;
    const k = hkey(sp, year, month, day, hour);
    const agg = map.get(k) ?? { da: [], rt: [] };
    agg.rt.push(price);
    map.set(k, agg);
  }
}

function parseDamSheet(ws: XLSX.WorkSheet, map: Map<HourKey, HourAgg>) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as (string | number)[][];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 5) continue;
    const dateStr = r[0] as string;
    const flag = r[2] as string;
    const sp = r[3] as string;
    const price = Number(r[4]);
    if (flag === "Y" || !sp || isNaN(price) || !dateStr?.includes("/")) continue;
    if (!HUB_ZONE_NODES.has(sp)) continue;
    const { year, month, day } = parseDate(dateStr);
    const hourRaw = r[1];
    const hour = typeof hourRaw === "number" ? hourRaw : parseInt(String(hourRaw));
    if (isNaN(hour)) continue;
    const k = hkey(sp, year, month, day, hour);
    const agg = map.get(k) ?? { da: [], rt: [] };
    agg.da.push(price);
    map.set(k, agg);
  }
}

function mean(a: number[]) { return a.length === 0 ? null : a.reduce((s, v) => s + v, 0) / a.length; }

async function getXlsxPath(year: number, type: "RTM" | "DAM", ids: Record<number, string>): Promise<string> {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${type.toLowerCase()}-${year}.xlsx`);
  if (fs.existsSync(cachePath)) {
    const sz = fs.statSync(cachePath).size;
    console.log(`  [${year}] ${type} XLSX: ${(sz/1024/1024).toFixed(1)} MB (cached)`);
    return cachePath;
  }
  const url = CDR + ids[year as keyof typeof ids];
  console.log(`  [${year}] Downloading ${type}...`);
  const buf = await downloadBuffer(url);
  console.log(`  [${year}] ${type} zip: ${(buf.length/1024/1024).toFixed(1)} MB → extracting...`);
  const xlBuf = extractXlsxFromZip(buf);
  fs.writeFileSync(cachePath, xlBuf);
  console.log(`  [${year}] ${type} XLSX: ${(xlBuf.length/1024/1024).toFixed(1)} MB → cached`);
  return cachePath;
}

async function processYear(
  year: number,
  map: Map<HourKey, HourAgg>,
  skipMonths: Set<number>,   // month numbers already fully covered in DB
) {
  for (const [type, ids] of [["RTM", RTM_IDS], ["DAM", DAM_IDS]] as const) {
    const cachePath = await getXlsxPath(year, type, ids);
    console.log(`  [${year}] Parsing ${type}...`);
    // Read workbook ONCE — not inside the per-sheet loop
    const wb = XLSX.read(fs.readFileSync(cachePath), { type: "buffer" });
    let parsed = 0;
    for (let mi = 0; mi < MONTHS.length; mi++) {
      const sn = MONTHS[mi];
      const monthNum = mi + 1;
      if (skipMonths.has(monthNum)) { process.stdout.write(` [${sn}:skip]`); continue; }
      if (!wb.Sheets[sn]) continue;
      if (type === "RTM") parseRtmSheet(wb.Sheets[sn], map);
      else parseDamSheet(wb.Sheets[sn], map);
      process.stdout.write(` ${sn}`);
      parsed++;
    }
    console.log(parsed === 0 ? " (all months already in DB)" : "");
  }
}

async function main() {
  console.log("=== ERCOT Hourly Price Seed ===");
  console.log("Source: CDR 13061 RTM + 13060 DAM — all 15 hub/zone settlement points\n");

  // Pre-flight: find which (year, month) combinations are already fully seeded
  // "Fully seeded" = all 15 nodes present with both DA and RT for that year-month
  const existingRes = await db.execute<{ year: number; month: number; node_count: number }>(sql`
    SELECT year, month, COUNT(DISTINCT node) AS node_count
    FROM ercot_hub_hourly
    WHERE da_price IS NOT NULL AND rt_price IS NOT NULL
    GROUP BY year, month
  `);
  const fullySeeded = new Map<number, Set<number>>();  // year → Set<month>
  for (const r of existingRes.rows) {
    const y = Number(r.year), m = Number(r.month), cnt = Number(r.node_count);
    if (cnt >= 15) {
      if (!fullySeeded.has(y)) fullySeeded.set(y, new Set());
      fullySeeded.get(y)!.add(m);
    }
  }
  for (const [y, months] of fullySeeded.entries()) {
    console.log(`  ${y}: ${months.size} months already fully seeded (skip)`);
  }

  const map = new Map<HourKey, HourAgg>();
  for (const year of [2024, 2025, 2026]) {
    const skipMonths = fullySeeded.get(year) ?? new Set<number>();
    // Skip entire year if all 12 months are covered
    if (skipMonths.size >= 12) {
      console.log(`[Year ${year}] — all months in DB, skipping.`);
      continue;
    }
    console.log(`[Year ${year}] — skipping ${skipMonths.size} covered months, parsing ${12 - skipMonths.size} new.`);
    try {
      await processYear(year, map, skipMonths);
    } catch (e) {
      console.warn(`  ⚠ Skipping year ${year}: ${(e as Error).message}`);
    }
  }

  console.log(`\nCollected ${map.size} node-hour combinations`);

  type Row = typeof ercotHubHourlyTable.$inferInsert;
  const rows: Row[] = [];
  for (const [k, agg] of map.entries()) {
    const parts = k.split("|");
    const sp = parts[0], year = Number(parts[1]), month = Number(parts[2]),
          day = Number(parts[3]), hour = Number(parts[4]);
    const daAvg = mean(agg.da), rtAvg = mean(agg.rt);
    if (daAvg === null && rtAvg === null) continue;
    rows.push({
      node: sp,
      nodeType: nodeType(sp),
      year, month, day, hour,
      daPrice: daAvg !== null ? daAvg.toFixed(4) : null,
      rtPrice: rtAvg !== null ? rtAvg.toFixed(4) : null,
    });
  }

  if (rows.length === 0) {
    console.log("Nothing new to insert — all data already in DB.");
    process.exit(0);
  }

  console.log(`Inserting ${rows.length} hourly rows (ON CONFLICT DO NOTHING)...`);

  const BATCH = 1000;
  const CONCURRENCY = 5;
  const batches: (typeof ercotHubHourlyTable.$inferInsert)[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

  let done = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(
      batches.slice(i, i + CONCURRENCY).map(batch =>
        db.insert(ercotHubHourlyTable).values(batch).onConflictDoNothing()
      )
    );
    done += Math.min(CONCURRENCY, batches.length - i);
    process.stdout.write(`\r  ${done * BATCH} / ${rows.length}`);
  }

  console.log(`\n✓ Inserted ${rows.length} hourly rows into ercot_hub_hourly.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
