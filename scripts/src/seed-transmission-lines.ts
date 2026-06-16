import https from "https";
import http from "http";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const HIFLD_BASE =
  "https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services" +
  "/Electric_Power_Transmission_Lines/FeatureServer/0/query";

interface HifldFeature {
  properties: Record<string, unknown>;
  geometry: { coordinates: [number, number][] } | null;
}

interface HifldResponse {
  features?: HifldFeature[];
  exceededTransferLimit?: boolean;
  error?: { message: string };
}

async function fetchJson(url: string): Promise<HifldResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers: { "User-Agent": "GridOriginationPlatform/1.0" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as HifldResponse); }
        catch (e) { reject(e); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function voltClass(kv: number): string {
  if (kv >= 765) return "735 KV AND ABOVE";
  if (kv >= 500) return "500 KV";
  if (kv >= 345) return "345 KV";
  if (kv >= 230) return "230 KV";
  if (kv >= 115) return "115 KV";
  return "UNDER 100 KV";
}

// Regions: fetch in chunks to stay within HIFLD's 2000-record limit per page
const REGIONS = [
  { label: "Texas (ERCOT)", where: "STATE_ = 'TX' AND VOLTAGE >= 115", iso: "ERCOT" },
  { label: "California (CAISO)", where: "STATE_ = 'CA' AND VOLTAGE >= 115", iso: "CAISO" },
  { label: "PJM Northeast", where: "STATE_ IN ('PA','NJ','MD','DE','VA','WV','DC') AND VOLTAGE >= 230", iso: "PJM" },
  { label: "PJM Midwest", where: "STATE_ IN ('OH','IN','MI','IL','NC','KY') AND VOLTAGE >= 230", iso: "PJM" },
  { label: "High voltage national", where: "VOLTAGE >= 500", iso: "NATIONAL" },
];

async function fetchRegion(region: typeof REGIONS[0]): Promise<HifldFeature[]> {
  const all: HifldFeature[] = [];
  let offset = 0;
  let more = true;

  while (more) {
    const params = new URLSearchParams({
      where: region.where,
      outFields: "OBJECTID,TYPE,STATUS,VOLTAGE,VOLT_CLASS,OWNER,SUB_1,SUB_2,SHAPE_LEN",
      outSR: "4326",
      geometryType: "esriGeometryPolyline",
      f: "geojson",
      resultOffset: String(offset),
      resultRecordCount: "2000",
    });
    const url = `${HIFLD_BASE}?${params}`;
    const data = await fetchJson(url);

    if (data.error) {
      console.warn(`  HIFLD error for ${region.label}: ${data.error.message}`);
      break;
    }

    const features = data.features ?? [];
    all.push(...features);
    process.stdout.write(`\r  ${region.label}: ${all.length} lines fetched...`);

    more = !!data.exceededTransferLimit && features.length > 0;
    offset += 2000;
    if (more) await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\r  ${region.label}: ${all.length} lines fetched       `);
  return all;
}

async function seed() {
  console.log("Seeding transmission lines from HIFLD ArcGIS...");
  console.log("Clearing existing transmission lines...");
  await db.execute(sql`TRUNCATE TABLE transmission_lines RESTART IDENTITY`);

  let totalInserted = 0;
  const seenIds = new Set<string>();

  for (const region of REGIONS) {
    console.log(`\nFetching ${region.label}...`);
    const features = await fetchRegion(region);

    if (features.length === 0) {
      console.log(`  No features returned for ${region.label}`);
      continue;
    }

    // Build rows — skip features with no/short geometry
    const rows: Array<{
      hifld_id: string; line_type: string; status: string; voltage_kv: number | null;
      volt_class: string; owner: string; sub_from: string; sub_to: string;
      iso: string; line_length_km: number | null; coordinates: string;
    }> = [];

    for (const f of features) {
      if (!f.geometry?.coordinates || f.geometry.coordinates.length < 2) continue;
      const rawId = String(f.properties["OBJECTID"] ?? "");
      const uniqueId = `${region.iso}-${rawId}`;
      if (seenIds.has(uniqueId)) continue;
      seenIds.add(uniqueId);

      const kv = Number(f.properties["VOLTAGE"]) || null;
      const shapeLen = Number(f.properties["SHAPE_LEN"]) || null;
      rows.push({
        hifld_id: uniqueId,
        line_type: String(f.properties["TYPE"] ?? ""),
        status: String(f.properties["STATUS"] ?? ""),
        voltage_kv: kv,
        volt_class: String(f.properties["VOLT_CLASS"] ?? (kv ? voltClass(kv) : "")),
        owner: String(f.properties["OWNER"] ?? ""),
        sub_from: String(f.properties["SUB_1"] ?? ""),
        sub_to: String(f.properties["SUB_2"] ?? ""),
        iso: region.iso,
        line_length_km: shapeLen ? shapeLen * 0.001 : null,
        coordinates: JSON.stringify(f.geometry.coordinates),
      });
    }

    if (rows.length === 0) { console.log(`  All ${features.length} features skipped (no valid geometry)`); continue; }

    // Insert in batches of 500
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await db.execute(sql`
        INSERT INTO transmission_lines
          (hifld_id, line_type, status, voltage_kv, volt_class, owner,
           sub_from, sub_to, iso, line_length_km, coordinates)
        SELECT
          r.hifld_id, r.line_type, r.status,
          NULLIF(r.voltage_kv, 'null')::numeric,
          r.volt_class, r.owner, r.sub_from, r.sub_to, r.iso,
          NULLIF(r.line_length_km, 'null')::numeric,
          r.coordinates::jsonb
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS r(
          hifld_id text, line_type text, status text, voltage_kv text,
          volt_class text, owner text, sub_from text, sub_to text,
          iso text, line_length_km text, coordinates text
        )
      `);
      totalInserted += batch.length;
      process.stdout.write(`\r  Inserted ${totalInserted} lines...`);
    }
    console.log(`\r  ${region.label}: inserted ${rows.length} lines`);
  }

  console.log(`\n\nDone. Total transmission lines inserted: ${totalInserted}`);
}

seed().catch(err => { console.error(err); process.exit(1); });
