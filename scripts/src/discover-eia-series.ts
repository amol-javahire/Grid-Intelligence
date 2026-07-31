/**
 * One-off discovery tool — NOT a seeder. Prints candidate EIA API v2 series
 * IDs so the real forward/gas seeders can be built against confirmed
 * identifiers instead of guesses.
 *
 * Why this exists: this session found two real, free EIA data sources worth
 * adding —
 *   1. STEO wholesale power price forecast, which exists per-region
 *      including "ERCOT North hub" (confirmed via web search, exact series
 *      ID NOT confirmed) and presumably a CAISO/California region too.
 *   2. Natural gas citygate price for California (confirmed the state-level
 *      series exists; NOT confirmed whether EIA splits SoCal vs PG&E
 *      Citygate specifically, or only publishes one blended state average —
 *      the "CALSCG"/"CALPGCG" codes found via search belong to Natural Gas
 *      Intelligence's paid index product, NOT to EIA, and are NOT available
 *      through the OilPriceAPI connector checked this session either).
 *
 * The dev sandbox this was researched from cannot reach api.eia.gov with a
 * real key (only DEMO_KEY, which the STEO facet-browse endpoint rejects with
 * an empty body). This script must be run on the VM, which has a real
 * EIA_API_KEY in .env already used by seed-gas-forwards.ts / seed-gas-prices.ts.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   cd scripts && pnpm tsx src/discover-eia-series.ts
 *
 * Paste the FULL output back — the next step (building the real seeders)
 * depends on reading the actual series IDs and descriptions, not guessing.
 */
import { execSync } from "child_process";

const apiKey = process.env.EIA_API_KEY;
if (!apiKey) {
  console.error("EIA_API_KEY not set — did you `source .env`?");
  process.exit(1);
}

function curlGet(url: string, timeoutSec = 30): { status: number; body: string } {
  // -w appends "\n<http_code>" so we can separate status from body without
  // curl's -o juggling; -s keeps progress output out of the body.
  const raw = execSync(
    `curl -s -w "\\n__HTTP_STATUS__%{http_code}" --connect-timeout 10 --max-time ${timeoutSec} --compressed -L "${url}"`,
    { maxBuffer: 20 * 1024 * 1024, timeout: (timeoutSec + 10) * 1000 },
  ).toString("utf8");
  const marker = "__HTTP_STATUS__";
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) return { status: 0, body: raw };
  return { status: parseInt(raw.slice(idx + marker.length).trim(), 10), body: raw.slice(0, idx) };
}

function tryJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return null; }
}

function section(title: string) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

// ── 1. STEO: list all seriesId facets, filter client-side ───────────────────
// The facet-browse endpoint returns EVERY seriesId + description in one call
// (a few thousand rows) — cheaper and more reliable than guessing query
// params one at a time. We filter locally for anything that looks like a
// wholesale electricity price.
async function discoverSteoPowerSeries() {
  section("1. EIA STEO — candidate wholesale electricity price series");
  const url = `https://api.eia.gov/v2/steo/data/facet/seriesId?api_key=${apiKey}`;
  const { status, body } = curlGet(url);
  console.log(`GET /v2/steo/data/facet/seriesId → HTTP ${status}, ${body.length} bytes`);

  const parsed = tryJson(body) as { response?: { facets?: Array<{ id: string; name: string }> } } | null;
  const facets = parsed?.response?.facets ?? [];
  if (!facets.length) {
    console.log("No facets returned. Raw body (first 500 chars):");
    console.log(body.slice(0, 500));
    return;
  }
  console.log(`Total STEO series available: ${facets.length}`);

  const keywords = ["wholesale", "electricity price", "ercot", "caiso", "california", "power price"];
  const candidates = facets.filter((f) =>
    keywords.some((kw) => (f.name ?? "").toLowerCase().includes(kw) || (f.id ?? "").toLowerCase().includes(kw)),
  );
  console.log(`\nMatches for [${keywords.join(", ")}]: ${candidates.length}`);
  for (const c of candidates) console.log(`  ${c.id}  —  ${c.name}`);

  if (candidates.length === 0) {
    console.log("\nNo keyword matches — dumping any series with 'WPR' or 'ELEC' in the id, as a fallback:");
    for (const f of facets.filter((f) => /WPR|ELEC/i.test(f.id ?? ""))) {
      console.log(`  ${f.id}  —  ${f.name}`);
    }
  }
}

// ── 2. Natural gas price — California citygate ──────────────────────────────
// Tries the plausible v2 route for state-level summary prices, and separately
// checks whether EIA has utility-level (SoCal / PG&E) series rather than one
// blended state figure. Tries a couple of route shapes since the exact v2
// path for this dataset was not confirmed from the dev sandbox.
async function discoverGasCitygateSeries() {
  section("2. EIA Natural Gas — California citygate price series");

  const routes = [
    "natural-gas/pri/sum/data/facet/series",
    "natural-gas/pri/sum/data/facet/duoarea",
  ];
  for (const route of routes) {
    const url = `https://api.eia.gov/v2/${route}?api_key=${apiKey}`;
    const { status, body } = curlGet(url);
    console.log(`\nGET /v2/${route} → HTTP ${status}, ${body.length} bytes`);
    const parsed = tryJson(body) as { response?: { facets?: Array<{ id: string; name: string }> } } | null;
    const facets = parsed?.response?.facets ?? [];
    if (!facets.length) {
      console.log("  (no facets — raw body first 300 chars:)");
      console.log("  " + body.slice(0, 300).replace(/\n/g, " "));
      continue;
    }
    const matches = facets.filter((f) =>
      /calif|socal|pg&e|pge|citygate|CA$/i.test(f.name ?? "") || /^SCA|^CA/i.test(f.id ?? ""),
    );
    console.log(`  ${facets.length} total facets, ${matches.length} California/citygate matches:`);
    for (const m of matches.slice(0, 30)) console.log(`    ${m.id}  —  ${m.name}`);
  }

  // Directly test the one series ID found via web search for the classic
  // (v1-style) state-average California citygate price, ported to the v2
  // "seriesid" convenience route the existing Henry Hub seeder already uses.
  console.log("\nDirect check of NG.N3050CA3.M (California citygate, state avg, monthly):");
  const direct = curlGet(`https://api.eia.gov/v2/seriesid/NG.N3050CA3.M?api_key=${apiKey}&length=6`);
  console.log(`  HTTP ${direct.status}`);
  console.log("  " + direct.body.slice(0, 600).replace(/\n/g, " "));
}

async function main() {
  await discoverSteoPowerSeries();
  await discoverGasCitygateSeries();
  console.log("\nDone. Paste this entire output back.");
}

main().catch((err) => {
  console.error("Discovery script failed:", err);
  process.exit(1);
});
