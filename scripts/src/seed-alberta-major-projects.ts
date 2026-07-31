/**
 * Inventory of Major Alberta Projects seeder.
 *
 * Source: Government of Alberta open data (Open Government Licence – Alberta).
 *   Portal: https://majorprojects.alberta.ca/
 *   CSV:    open.alberta.ca .../download/majorprojects.csv
 *   Dataset last modified 2026-06-17 per the open.canada.ca CKAN record, so
 *   this is live despite the open.alberta.ca HTML page showing a stale 2015
 *   "Updated" date. Do not trust that page's date.
 *
 * Every Alberta project ≥ C$5M: recently completed, under construction, or
 * expected to start construction within two years.
 *
 * Why this sits alongside the AESO Connection Project List rather than merging
 * into it: this has capital cost, developer and construction stage but NO MW;
 * the AESO list has MW and interconnection status but NO cost. Names differ
 * between the two ("Caroline Solar Project (Sundre 575S DER Solar)" here vs
 * "P#### ..." there), so a reliable join does not exist. Kept separate on
 * purpose — do not fabricate a join key.
 *
 * The exact CSV column headers have NOT been confirmed (the file could not be
 * read from the dev sandbox). This script therefore detects columns by keyword
 * and refuses to write anything if it cannot find a project-name column.
 *
 * ALWAYS run --inspect first and eyeball the output:
 *   pnpm --filter @workspace/scripts seed-alberta-major-projects -- --inspect
 *   pnpm --filter @workspace/scripts seed-alberta-major-projects
 */
import https from "https";
import { parse } from "csv-parse/sync";
import { db, albertaMajorProjectsTable } from "@workspace/db";

const args = process.argv.slice(2);
const INSPECT = args.includes("--inspect");

const CSV_URL =
  "https://open.alberta.ca/dataset/3e4efd44-7a00-46d1-9c7c-171028a01066/resource/b69a4239-06fb-4e02-b011-7de59ced8fa3/download/majorprojects.csv";

async function fetchText(url: string, redirects = 0): Promise<string> {
  if (redirects > 8) throw new Error(`Too many redirects: ${url}`);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https
      .get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          port: parsed.port || 443,
          headers: {
            "User-Agent": "Mozilla/5.0 (GridOriginationPlatform/1.0; energy-data-research)",
            Accept: "text/csv,application/octet-stream,*/*",
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const loc = res.headers.location.startsWith("http")
              ? res.headers.location
              : `https://${parsed.hostname}${res.headers.location}`;
            resolve(fetchText(loc, redirects + 1));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          res.on("error", reject);
        },
      )
      .on("error", reject);
  });
}

// ── Column detection ─────────────────────────────────────────────────────────
function findCol(headers: string[], ...keywords: string[]): number {
  for (const kw of keywords) {
    const i = headers.findIndex((h) => h.includes(kw));
    if (i >= 0) return i;
  }
  return -1;
}

// ── Cost parsing ─────────────────────────────────────────────────────────────
// Published as a $-millions figure, but formatting varies ("1,200", "$1.2B",
// "1200.00"). Anything that doesn't parse cleanly becomes null rather than a
// guess — a wrong capital cost is worse than a missing one.
function parseCost(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || /^(n\/?a|tbd|unknown|-)$/i.test(s)) return null;
  const isBillions = /b(illion)?\s*$/i.test(s);
  const cleaned = s.replace(/[$,\s]/g, "").replace(/[bm](illion)?$/i, "");
  const n = parseFloat(cleaned);
  if (isNaN(n) || n < 0) return null;
  return isBillions ? n * 1000 : n;
}

function parseDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseNum(raw: unknown): string | null {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = parseFloat(String(raw));
  return isNaN(n) ? null : String(n);
}

// ── Power relevance ──────────────────────────────────────────────────────────
// Flags the subset an origination team cares about: generation, storage,
// transmission, and data centres (the load driving Alberta's current queue).
// Deliberately broad — the UI filters further; better to over-flag than to
// silently drop a wind farm because its sector string was unexpected.
const POWER_KEYWORDS = [
  "power", "electric", "generation", "solar", "wind", "hydro", "geothermal",
  "nuclear", "cogeneration", "cogen", "turbine", "battery", "storage",
  "transmission", "substation", "grid", "energy storage", "data cent",
  "data center", "data centre", "renewable",
];

function isPowerRelated(...fields: (string | null | undefined)[]): boolean {
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return POWER_KEYWORDS.some((kw) => hay.includes(kw));
}

async function seed() {
  console.log("=== Inventory of Major Alberta Projects ===");
  console.log("Source: Government of Alberta open data (OGL–Alberta)\n");

  console.log(`Downloading ${CSV_URL} ...`);
  const csv = await fetchText(CSV_URL);
  console.log(`  ✓ ${(csv.length / 1024).toFixed(0)} KB`);

  const records: string[][] = parse(csv, {
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  if (records.length < 2) throw new Error("CSV had fewer than 2 rows — nothing to parse");

  // Header row is usually first, but tolerate a title/blurb line above it.
  let hdrIdx = 0;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(records.length, 5); i++) {
    const cand = records[i].map((h) => h.toLowerCase().replace(/\s+/g, " ").trim());
    if (cand.some((h) => h.includes("name") || h.includes("project"))) {
      hdrIdx = i;
      headers = cand;
      break;
    }
  }
  if (headers.length === 0) headers = records[0].map((h) => h.toLowerCase().trim());

  const cols = {
    name: findCol(headers, "project name", "name"),
    municipality: findCol(headers, "municipality", "location", "city"),
    region: findCol(headers, "region"),
    sector: findCol(headers, "sector"),
    type: findCol(headers, "type", "category", "sub-sector", "subsector"),
    stage: findCol(headers, "stage"),
    status: findCol(headers, "status"),
    cost: findCol(headers, "cost", "value", "estimated cost", "budget"),
    developer: findCol(headers, "developer", "company", "owner", "proponent"),
    start: findCol(headers, "start", "construction start"),
    completion: findCol(headers, "completion", "finish", "end date"),
    lat: findCol(headers, "latitude", "lat"),
    lng: findCol(headers, "longitude", "long", "lng"),
  };

  if (cols.name < 0) {
    console.error("\nNo project-name column found. Headers were:");
    console.error(JSON.stringify(headers, null, 2));
    process.exit(1);
  }

  const at = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() || null : null);

  const rows = [];
  const seen = new Set<string>();
  let powerCount = 0;

  for (const row of records.slice(hdrIdx + 1)) {
    const projectName = at(row, cols.name);
    if (!projectName) continue;
    const dedupeKey = `${projectName}|${at(row, cols.municipality) ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const sector = at(row, cols.sector);
    const projectType = at(row, cols.type);
    const power = isPowerRelated(projectName, sector, projectType);
    if (power) powerCount++;

    const cost = parseCost(cols.cost >= 0 ? row[cols.cost] : null);

    rows.push({
      projectName,
      municipality: at(row, cols.municipality),
      region: at(row, cols.region),
      sector,
      projectType,
      stage: at(row, cols.stage),
      status: at(row, cols.status),
      costMillions: cost !== null ? String(cost.toFixed(2)) : null,
      developer: at(row, cols.developer),
      startDate: parseDate(cols.start >= 0 ? row[cols.start] : null),
      completionDate: parseDate(cols.completion >= 0 ? row[cols.completion] : null),
      lat: parseNum(cols.lat >= 0 ? row[cols.lat] : null),
      lng: parseNum(cols.lng >= 0 ? row[cols.lng] : null),
      isPowerRelated: power ? "true" : "false",
      sourceUpdated: new Date().toISOString().slice(0, 10),
    });
  }

  console.log(`\nParsed ${rows.length} projects (${powerCount} flagged power-related)`);

  if (INSPECT) {
    console.log("\n--- INSPECT: detected headers ---");
    console.log(JSON.stringify(headers, null, 2));
    console.log("\n--- INSPECT: column map (-1 = not found) ---");
    console.log(JSON.stringify(cols, null, 2));
    console.log("\n--- INSPECT: first 5 rows ---");
    console.log(JSON.stringify(rows.slice(0, 5), null, 2));
    console.log("\n--- INSPECT: first 5 power-related rows ---");
    console.log(JSON.stringify(rows.filter((r) => r.isPowerRelated === "true").slice(0, 5), null, 2));
    console.log("\nNo DB writes made (--inspect).");
    process.exit(0);
  }

  if (rows.length === 0) {
    console.error("Parsed 0 projects — refusing to wipe the table. Re-run with --inspect.");
    process.exit(1);
  }

  console.log("\nClearing alberta_major_projects (full refresh, matches source publishing model)...");
  await db.delete(albertaMajorProjectsTable);

  console.log(`Inserting ${rows.length} projects...`);
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(albertaMajorProjectsTable).values(rows.slice(i, i + 200));
    process.stdout.write(`  ${Math.min(i + 200, rows.length)}/${rows.length}\r`);
  }
  console.log(`\nDone ✓ — ${rows.length} projects, ${powerCount} power-related.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
