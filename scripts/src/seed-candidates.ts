import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, candidatesTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const CSV_PATHS = [
  // When pnpm runs this script, CWD = scripts/ package dir
  path.join(process.cwd(), "data", "candidates-seed.csv"),
  // Relative to this source file: scripts/src/ → scripts/data/
  path.resolve(__dirname, "..", "data", "candidates-seed.csv"),
  // When spawned from workspace root (production)
  path.join(process.cwd(), "scripts", "data", "candidates-seed.csv"),
];

function findCsv(): string {
  for (const p of CSV_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`candidates-seed.csv not found. Tried:\n${CSV_PATHS.join("\n")}`);
}

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.split("\n").filter(l => l.trim());
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const vals: string[] = [];
    let inQ = false;
    let cur = "";
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { vals.push(cur); cur = ""; continue; }
      cur += ch;
    }
    vals.push(cur);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? "").trim(); });
    return row;
  });
}

function nullish(v: string): string | null {
  return v === "" || v === "NULL" || v === "null" ? null : v;
}

async function seed() {
  const csvPath = findCsv();
  console.log(`Reading candidates from: ${csvPath}`);
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(raw);
  console.log(`Parsed ${rows.length} rows — clearing existing candidates...`);

  await db.execute(sql`TRUNCATE TABLE candidates RESTART IDENTITY CASCADE`);
  console.log("Table cleared. Inserting...");

  const BATCH = 200;
  let total = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map(r => ({
      name: r.name,
      market: r.market as "ERCOT" | "CAISO" | "PJM",
      assetType: r.asset_type as "solar" | "wind" | "storage" | "solar_storage" | "wind_storage" | "hydro" | "biomass" | "geothermal" | "natural_gas" | "nuclear",
      status: (r.status || "active") as "active" | "inactive" | "under_review" | "contracted",
      capacityMw: r.capacity_mw,
      latitude: r.latitude,
      longitude: r.longitude,
      county: nullish(r.county),
      state: nullish(r.state),
      interconnectionNode: nullish(r.interconnection_node),
      pricingHubNode: nullish(r.pricing_hub_node),
      estimatedLcoe: nullish(r.estimated_lcoe),
      offtakePriceMwh: nullish(r.offtake_price_mwh),
      overallScore: nullish(r.overall_score) ?? "50",
      priceScore: nullish(r.price_score),
      locationScore: nullish(r.location_score),
      curtailmentScore: nullish(r.curtailment_score),
      interconnectionScore: nullish(r.interconnection_score),
      regulatoryScore: nullish(r.regulatory_score),
      financialScore: nullish(r.financial_score),
      environmentalScore: nullish(r.environmental_score),
      gridStabilityScore: nullish(r.grid_stability_score),
      demandProximityScore: nullish(r.demand_proximity_score),
      developmentRiskScore: nullish(r.development_risk_score),
      commissioningYear: nullish(r.commissioning_year) ? Number(nullish(r.commissioning_year)) : null,
    }));

    await db.insert(candidatesTable).values(values);
    total += batch.length;
    process.stdout.write(`\r  Progress: ${total}/${rows.length}`);
  }

  console.log(`\nDone. ${total} candidates inserted.`);
}

seed().catch(err => { console.error(err); process.exit(1); });
