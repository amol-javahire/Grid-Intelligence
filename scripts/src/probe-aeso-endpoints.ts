/**
 * Read-only probe of AESO API endpoints, to find real generator LOCATIONS and
 * real merit-order OFFER PRICES for the 9-bus PyPSA congestion model.
 *
 * WHY: inspect-aeso-assets showed the two things that model needs are both
 * missing from the DB —
 *   • aeso_asset_registry.location is EMPTY for all 3,728 rows (so assets
 *     cannot be assigned to planning-region buses)
 *   • aeso_merit_order has ZERO rows (so there are no real per-unit offer
 *     prices, leaving only ~6 flat carrier assumptions — which is why LMP is
 *     identical at every bus and never moves with load)
 *
 * Before writing seeders for either, find out what the API actually returns.
 * Nothing here writes to the database.
 *
 * Probes:
 *   1. assetlist-api/v1/assetlist — dump EVERY field on a sample record. The
 *      current seeder only stores a handful; a location/substation/area field
 *      may already be in the payload and simply not persisted.
 *   2. api.aeso.ca/report/v1/meritOrder/energy — different host from the
 *      apimgw.aeso.ca/public base this repo uses everywhere else. If it
 *      answers with the same key, real offer prices are available.
 *   3. currentsupplydemand-api — the CSD asset list, which AESO documents
 *      separately and which may carry richer asset metadata.
 *
 * Run: AESO_API_KEY=<key> pnpm --filter @workspace/scripts probe-aeso-endpoints
 */

const KEY = process.env.AESO_API_KEY;
if (!KEY) {
  console.error("❌  AESO_API_KEY not set. Register free at https://developer-apim.aeso.ca");
  process.exit(1);
}

type Probe = { label: string; url: string; headerName: string };

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const recent = new Date(Date.now() - 3 * 86_400_000);

const PROBES: Probe[] = [
  {
    label: "1. Asset list (apimgw) — looking for a location/area/substation field",
    url: "https://apimgw.aeso.ca/public/assetlist-api/v1/assetlist",
    headerName: "API-KEY",
  },
  {
    label: "2. Merit order energy (api.aeso.ca report host) — real offer prices",
    url: `https://api.aeso.ca/report/v1/meritOrder/energy?startDate=${ymd(recent)}&endDate=${ymd(recent)}`,
    headerName: "X-API-Key",
  },
  {
    label: "2b. Merit order energy (apimgw host variant)",
    url: `https://apimgw.aeso.ca/public/meritorder-api/v1/meritOrder/energy?startDate=${ymd(recent)}&endDate=${ymd(recent)}`,
    headerName: "API-KEY",
  },
  {
    label: "3. Current supply/demand — richer asset metadata?",
    url: "https://apimgw.aeso.ca/public/currentsupplydemand-api/v1/csd/generation/assets/current",
    headerName: "API-KEY",
  },
];

/** Walk a nested object and report leaf key paths, so no field is missed. */
function keyPaths(obj: unknown, prefix = "", out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 4 || obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    if (obj.length) keyPaths(obj[0], `${prefix}[]`, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") keyPaths(v, path, out, depth + 1);
    else out.add(`${path} = ${JSON.stringify(v)?.slice(0, 60)}`);
  }
  return out;
}

async function probe(p: Probe): Promise<void> {
  console.log(`\n${"=".repeat(70)}\n${p.label}\n  ${p.url}`);
  try {
    const res = await fetch(p.url, { headers: { [p.headerName]: KEY!, Accept: "application/json" } });
    console.log(`  HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!res.ok) {
      console.log(`  body: ${text.slice(0, 300)}`);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`  non-JSON response: ${text.slice(0, 300)}`);
      return;
    }

    // AESO wraps payloads inconsistently: {return: {...}} or {responseCode,...}
    const root = json as Record<string, unknown>;
    const inner = (root["return"] ?? root) as Record<string, unknown>;
    const arrayKey = Object.keys(inner).find((k) => Array.isArray(inner[k]));
    const rows = arrayKey ? (inner[arrayKey] as unknown[]) : Array.isArray(inner) ? inner : [];

    console.log(`  top-level keys: ${Object.keys(root).join(", ")}`);
    if (arrayKey) console.log(`  array field: "${arrayKey}" with ${rows.length} rows`);

    if (rows.length) {
      console.log(`  --- ALL fields on first record ---`);
      for (const line of [...keyPaths(rows[0])].sort()) console.log(`      ${line}`);
    } else {
      console.log(`  --- no array rows; full shape ---`);
      for (const line of [...keyPaths(root)].sort().slice(0, 40)) console.log(`      ${line}`);
    }
  } catch (e) {
    console.log(`  ✗ request failed: ${(e as Error).message}`);
  }
}

async function main() {
  console.log("=== AESO endpoint probe (read-only, no DB writes) ===");
  for (const p of PROBES) await probe(p);
  console.log(`\n${"=".repeat(70)}`);
  console.log("Looking for: any field naming a substation, planning area, region,");
  console.log("municipality, or lat/lon on the asset records; and whether merit");
  console.log("order returns per-asset offer prices.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
