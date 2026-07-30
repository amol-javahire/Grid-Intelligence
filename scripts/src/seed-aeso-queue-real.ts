/**
 * Real AESO interconnection queue seeder.
 *
 * Source: AESO Connection Project List (published monthly, public, free).
 *   Page:  https://www.aeso.ca/grid/transmission-projects/connection-project-reporting/
 *   File:  https://www.aeso.ca/assets/Uploads/project-reporting/{Month}-{Year}-Project-List.xlsx
 *   Guide: https://www.aeso.ca/assets/AESO-Connection-Project-List-Guide-v2.pdf (V1.5-2025-02-25)
 *
 * This replaces the fully-synthetic Math.random() queue in seed-aeso-data.ts's
 * seedQueue() (fake project names, fake dates, fake substations — never real
 * AESO data). That function is now unused; do not call it.
 *
 * Column layout per the AESO guide (confirmed against the doc, NOT against a
 * downloaded file — this sandbox cannot reach aeso.ca, only the VM can). The
 * guide documents: "Project Number and Name", "Planning Area", "Cluster",
 * "Project Type", "MW Type", "Stage", "CA Modelled", "Inclusion", "Applied On",
 * plus up to three repeated Energization blocks (EN1/EN2/EN3), each with its
 * own "STS MW", "DTS MW", "ISD" columns, and a Status grouping (Cluster /
 * Active / ISD Under Review / On Hold / Recently Energized / Recently
 * Cancelled) that may appear as a column, as separate sheets, or both.
 *
 * Because the exact header layout (one row vs. two-row grouped headers with
 * merged cells) has NOT been visually confirmed, this script:
 *   1. Detects the header row(s) dynamically by keyword match, expanding
 *      merged header cells via ws['!merges'] rather than assuming a fixed
 *      column layout.
 *   2. Refuses to insert if it can't confidently find a project-name column
 *      AND at least one of (planning area / MW type / status) — it will
 *      print what it found and exit non-zero instead of seeding garbage.
 *   3. Supports `--inspect` to print the detected column map + first 5 parsed
 *      rows and exit WITHOUT touching the DB. Run this first after any AESO
 *      template change and eyeball it before doing a real run — per
 *      CLAUDE.md convention: verify every seeder immediately after it runs.
 *
 * Usage (on the VM, which has real internet — this sandbox does not):
 *   pnpm --filter @workspace/scripts seed-aeso-queue-real -- --inspect
 *   pnpm --filter @workspace/scripts seed-aeso-queue-real
 *   pnpm --filter @workspace/scripts seed-aeso-queue-real -- --month=June-2026
 */
import https from "https";
import { db, aesoQueueProjectsTable } from "@workspace/db";

const args = process.argv.slice(2);
const INSPECT = args.includes("--inspect");
const monthArg = args.find((a) => a.startsWith("--month="))?.split("=")[1] ?? null;

// ── Low-level HTTPS fetch → Buffer, following redirects ─────────────────────
async function fetchBuf(url: string, redirects = 0): Promise<{ status: number; buf: Buffer }> {
  if (redirects > 8) throw new Error(`Too many redirects: ${url}`);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || 443,
      headers: {
        "User-Agent": "Mozilla/5.0 (GridOriginationPlatform/1.0; energy-data-research)",
        Accept: "application/octet-stream,*/*",
      },
    };
    https
      .get(opts, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location.startsWith("http")
            ? res.headers.location
            : `https://${parsed.hostname}${res.headers.location}`;
          resolve(fetchBuf(loc, redirects + 1));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// ── Month-Year URL builder, with automatic previous-month fallback ──────────
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthUrl(monthLabel: string): string {
  return `https://www.aeso.ca/assets/Uploads/project-reporting/${monthLabel}-Project-List.xlsx`;
}

async function fetchLatestProjectList(): Promise<{ buf: Buffer; monthLabel: string }> {
  const candidates: string[] = [];
  if (monthArg) {
    candidates.push(monthArg);
  } else {
    const now = new Date();
    for (let back = 0; back < 3; back++) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      candidates.push(`${MONTH_NAMES[d.getMonth()]}-${d.getFullYear()}`);
    }
  }

  for (const label of candidates) {
    const url = monthUrl(label);
    console.log(`  Trying ${url} ...`);
    try {
      const { status, buf } = await fetchBuf(url);
      const isXlsx = buf.slice(0, 4).toString("hex") === "504b0304"; // PK.. zip magic
      if (status === 200 && isXlsx) {
        console.log(`  ✓ Downloaded ${label} Project List (${(buf.length / 1024).toFixed(0)} KB)`);
        return { buf, monthLabel: label };
      }
      console.log(`  ✗ ${label}: HTTP ${status}, xlsx=${isXlsx} — trying earlier month`);
    } catch (e) {
      console.log(`  ✗ ${label}: ${(e as Error).message} — trying earlier month`);
    }
  }
  throw new Error(
    "Could not download any recent AESO Connection Project List. Check " +
      "https://www.aeso.ca/grid/transmission-projects/connection-project-reporting/ " +
      "for the current filename and pass it explicitly via --month=Month-YYYY.",
  );
}

// ── Excel serial-date / string → 'YYYY-MM-DD' ────────────────────────────────
function xlDateStr(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const n = Number(v);
  if (!isNaN(n) && n > 1000 && n < 100000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

// ── Header detection with merged-cell expansion ──────────────────────────────
type SheetJSModule = typeof import("xlsx");

function expandHeaderRow(XLSX: SheetJSModule, ws: any, rowIdx: number, numCols: number): (string | null)[] {
  const merges: any[] = ws["!merges"] || [];
  const vals: (string | null)[] = new Array(numCols).fill(null);
  for (let c = 0; c < numCols; c++) {
    const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
    const cell = ws[addr];
    vals[c] = cell && cell.v !== undefined && cell.v !== null ? String(cell.v).trim() : null;
  }
  for (const m of merges) {
    if (m.s.r <= rowIdx && m.e.r >= rowIdx) {
      const addr = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c });
      const cell = ws[addr];
      const val = cell && cell.v !== undefined && cell.v !== null ? String(cell.v).trim() : null;
      if (val) for (let c = m.s.c; c <= m.e.c; c++) vals[c] = val;
    }
  }
  return vals;
}

const HEADER_KEYWORDS = ["project", "planning area", "mw type", "status", "applied on", "sts mw", "isd"];

function scoreHeaderRow(vals: (string | null)[]): number {
  const joined = vals.filter(Boolean).join(" | ").toLowerCase();
  return HEADER_KEYWORDS.reduce((acc, kw) => acc + (joined.includes(kw) ? 1 : 0), 0);
}

interface ParsedProject {
  projectName: string;
  fuelType: string | null;
  capacityMw: number;
  region: string | null;
  status: string | null;
  queueDate: string | null;
  expectedOnline: string | null;
}

async function parseSheet(
  XLSX: SheetJSModule,
  ws: any,
  sheetName: string,
): Promise<{ rows: ParsedProject[]; colMap: Record<string, number[]> }> {
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
  const numCols = range.e.c + 1;
  const numRows = range.e.r + 1;

  let bestRow = -1;
  let bestScore = -1;
  let bestVals: (string | null)[] = [];
  let bestIsTwoRow = false;

  for (let r = 0; r < Math.min(numRows, 10); r++) {
    const single = expandHeaderRow(XLSX, ws, r, numCols);
    const singleScore = scoreHeaderRow(single);
    if (singleScore > bestScore) {
      bestScore = singleScore;
      bestRow = r;
      bestVals = single;
      bestIsTwoRow = false;
    }
    if (r + 1 < numRows) {
      const next = expandHeaderRow(XLSX, ws, r + 1, numCols);
      const combined = single.map((s, i) => [s, next[i]].filter(Boolean).join(" ").trim() || null);
      const combinedScore = scoreHeaderRow(combined);
      if (combinedScore > bestScore) {
        bestScore = combinedScore;
        bestRow = r;
        bestVals = combined;
        bestIsTwoRow = true;
      }
    }
  }

  if (bestRow < 0 || bestScore < 2) {
    console.warn(`    [${sheetName}] no confident header row found (best score ${bestScore}) — skipping sheet`);
    return { rows: [], colMap: {} };
  }

  const headers = bestVals.map((h) => (h ?? "").toLowerCase().replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim());
  const ciAll = (kw: string) => headers.reduce<number[]>((acc, h, i) => (h.includes(kw) ? [...acc, i] : acc), []);
  const ci1 = (kw: string) => ciAll(kw)[0] ?? -1;

  const nameCol = ci1("project number and name") >= 0 ? ci1("project number and name") : ci1("project name");
  const planningAreaCol = ci1("planning area");
  const mwTypeCol = ci1("mw type");
  const projectTypeCol = ci1("project type");
  const statusCol = ci1("status");
  const appliedOnCol = ci1("applied on");
  const stsCols = ciAll("sts mw");
  const dtsCols = ciAll("dts mw");
  const isdCols = ciAll("isd");

  const colMap = {
    nameCol: [nameCol], planningAreaCol: [planningAreaCol], mwTypeCol: [mwTypeCol],
    statusCol: [statusCol], appliedOnCol: [appliedOnCol], stsCols, dtsCols, isdCols,
  };

  if (nameCol < 0) {
    console.warn(`    [${sheetName}] no "project name" column found among headers: ${JSON.stringify(headers)}`);
    return { rows: [], colMap };
  }

  const dataStartRow = bestIsTwoRow ? bestRow + 2 : bestRow + 1;
  const rows: ParsedProject[] = [];
  const seen = new Set<string>();

  for (let r = dataStartRow; r < numRows; r++) {
    const rowVals: unknown[] = [];
    for (let c = 0; c < numCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      rowVals.push(ws[addr]?.v ?? null);
    }
    const rawName = rowVals[nameCol];
    if (!rawName) continue;
    const projectName = String(rawName).trim();
    if (!projectName || /^project (number|name)/i.test(projectName)) continue;
    if (seen.has(projectName)) continue;
    seen.add(projectName);

    const stsSum = stsCols.reduce((acc, c) => acc + num(rowVals[c]), 0);
    const dtsSum = dtsCols.reduce((acc, c) => acc + num(rowVals[c]), 0);
    const capacityMw = stsSum > 0 ? stsSum : dtsSum;

    const isdDates = isdCols.map((c) => xlDateStr(rowVals[c])).filter((d): d is string => !!d).sort();
    const expectedOnline = isdDates[0] ?? null;

    const status =
      statusCol >= 0 && rowVals[statusCol]
        ? String(rowVals[statusCol]).trim()
        : /cancel/i.test(sheetName)
          ? "Recently Cancelled"
          : /energiz/i.test(sheetName)
            ? "Recently Energized"
            : /hold/i.test(sheetName)
              ? "On Hold"
              : /cluster/i.test(sheetName)
                ? "Cluster"
                : sheetName;

    rows.push({
      projectName,
      fuelType: mwTypeCol >= 0 ? (rowVals[mwTypeCol] ? String(rowVals[mwTypeCol]).trim() : null) : projectTypeCol >= 0 ? String(rowVals[projectTypeCol] ?? "").trim() || null : null,
      capacityMw,
      region: planningAreaCol >= 0 && rowVals[planningAreaCol] ? String(rowVals[planningAreaCol]).trim() : null,
      status,
      queueDate: appliedOnCol >= 0 ? xlDateStr(rowVals[appliedOnCol]) : null,
      expectedOnline,
    });
  }

  console.log(`    [${sheetName}] header row ${bestRow}${bestIsTwoRow ? " (+1, merged)" : ""}, score ${bestScore} → ${rows.length} projects`);
  return { rows, colMap };
}

async function seed() {
  console.log("=== AESO Real Interconnection Queue Seed ===");
  console.log("Source: AESO Connection Project List (aeso.ca, public, monthly)\n");

  const { buf, monthLabel } = await fetchLatestProjectList();
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });

  console.log(`\nSheets found: ${wb.SheetNames.join(", ")}`);

  const all: ParsedProject[] = [];
  let firstColMap: Record<string, number[]> | null = null;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws["!ref"]) continue;
    const { rows, colMap } = await parseSheet(XLSX, ws, sheetName);
    if (!firstColMap && Object.keys(colMap).length) firstColMap = colMap;
    all.push(...rows);
  }

  console.log(`\nTotal parsed: ${all.length} projects from ${monthLabel} Project List`);

  if (INSPECT) {
    console.log("\n--- INSPECT MODE: column map (first sheet with a match) ---");
    console.log(JSON.stringify(firstColMap, null, 2));
    console.log("\n--- INSPECT MODE: first 5 parsed rows ---");
    console.log(JSON.stringify(all.slice(0, 5), null, 2));
    console.log("\nNo DB writes made (--inspect). Re-run without --inspect once this looks right.");
    process.exit(0);
  }

  if (all.length === 0) {
    console.error("\nParsed 0 projects — refusing to wipe the existing queue table. Re-run with --inspect to debug.");
    process.exit(1);
  }

  console.log("\nClearing existing aeso_queue_projects (monthly full-refresh, matches AESO's publishing model)...");
  await db.delete(aesoQueueProjectsTable);

  console.log(`Inserting ${all.length} projects in chunks...`);
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200).map((p) => ({
      projectName: p.projectName,
      fuelType: p.fuelType,
      capacityMw: p.capacityMw > 0 ? String(p.capacityMw.toFixed(2)) : null,
      region: p.region,
      county: null,
      status: p.status,
      queueDate: p.queueDate,
      expectedOnline: p.expectedOnline,
      transmissionConnection: null, // not published in this file — do not fabricate
      lat: null, // requires the separate GIS shapefile; not parsed here (see project TODO)
      lng: null,
    }));
    await db.insert(aesoQueueProjectsTable).values(chunk);
    process.stdout.write(`  ${Math.min(i + 200, all.length)}/${all.length}\r`);
  }
  console.log(`\nDone ✓ — ${all.length} real AESO queue projects from ${monthLabel}.`);
  console.log("Note: lat/lng and transmission POI are not in this file — Project Map tab still needs the GIS shapefile pass.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
