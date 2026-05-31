/**
 * score-caiso-curtailment.ts
 *
 * Updates curtailment_score for all CAISO candidates using real OASIS data:
 *   1. Maps each candidate to a CAISO pricing zone by lat/lon (NP15 / ZP26 / SP15)
 *   2. Uses real neg_price_percent and DA-RT spread from caiso_node_stats (28 months, 2024-2026)
 *   3. Applies asset-type curtailment multipliers (solar >> wind > storage > gas/hydro)
 *   4. Updates candidates.curtailment_score (0-100) and pricing_hub_node
 *
 * Real signal from CAISO OASIS PRC_LMP (public):
 *   NP15 (Northern CA):  3.82% neg-price hours — hydro-balanced, low curtailment
 *   SP15 (Southern CA): 13.19% neg-price hours — heavy solar saturation
 *   ZP26 (Central CA):  14.79% neg-price hours — highest, San Joaquin Valley solar
 *
 * Score: 100 = no curtailment risk, 0 = severe exposure
 * Solar in ZP26/SP15 scores lowest (~70-75); gas/nuclear everywhere scores ~90+
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── CAISO zone lat/lon mapping ─────────────────────────────────────────────────
// Based on CAISO Path 15 / Path 26 transmission boundaries (approximate)
// NP15: North of Path 15 — Northern CA, Bay Area, Sacramento, Sierra Nevada
// ZP26: Between Path 15 and 26 — Central Valley, San Joaquin, Bakersfield area
// SP15: South of Path 26 — LA Basin, San Diego, Inland Empire, Desert Southwest
function mapToCaisoZone(lat: number, lon: number): string {
  // Northern California — unambiguously NP15
  if (lat >= 37.5) return "NP15";
  // Bay Area / North Coast shoulder (lat 36.5-37.5, well west of Sierras)
  if (lat >= 36.5 && lon < -120.5) return "NP15";
  // Central Valley / San Joaquin (ZP26) — inland belt between the ranges
  if (lat >= 35.0 && lon <= -118.5 && lon >= -122.0) return "ZP26";
  // Southern California + Desert Southwest
  return "SP15";
}

// ── Asset-type curtailment multipliers ────────────────────────────────────────
// Solar faces the sharpest curtailment in CAISO — duck curve forces mid-day
// oversupply, especially in SP15 (LA) and ZP26 (Central Valley).
// Wind is moderate; Tehachapi and Altamont have some curtailment but less than solar.
// Storage benefits from curtailment (charge cheap, discharge peak) — low penalty.
// Dispatchable assets (gas, hydro, geothermal) are not curtailed.
const ASSET_MULT: Record<string, Record<string, number>> = {
  solar:       { NP15: 1.25, ZP26: 1.40, SP15: 1.35 },
  wind:        { NP15: 1.05, ZP26: 1.10, SP15: 1.15 },
  storage:     { NP15: 0.60, ZP26: 0.65, SP15: 0.65 }, // benefits from price spread
  natural_gas: { NP15: 0.40, ZP26: 0.40, SP15: 0.40 },
  hydro:       { NP15: 0.35, ZP26: 0.38, SP15: 0.40 }, // highly dispatchable
  geothermal:  { NP15: 0.30, ZP26: 0.30, SP15: 0.30 }, // baseload, essentially zero curtailment
  biomass:     { NP15: 0.45, ZP26: 0.45, SP15: 0.45 },
  nuclear:     { NP15: 0.28, ZP26: 0.28, SP15: 0.28 }, // Diablo Canyon — baseload
};

function getAssetMult(assetType: string, zone: string): number {
  const m = ASSET_MULT[assetType];
  if (!m) return 0.8; // unknown asset — moderate default
  return m[zone] ?? m["NP15"] ?? 0.8;
}

// ── Score formula ─────────────────────────────────────────────────────────────
// primary signal: neg_price_percent (real OASIS, 28 months avg)
// secondary: DA-RT spread (DA > RT in CAISO = normal; higher spread = less RT captured)
// scale: each 1% neg_price × asset_mult contributes ~2.0 penalty points
//        → solar in ZP26: 14.79 × 1.40 × 2.0 ≈ 41.4 → score ≈ 58 (high risk)
//          Wait, let me recalibrate — use 1.5 scale
//        → solar in ZP26: 14.79 × 1.40 × 1.5 ≈ 31.1 → score ≈ 69 ✓
//        → solar in SP15: 13.19 × 1.35 × 1.5 ≈ 26.7 → score ≈ 73 ✓
//        → solar in NP15: 3.82 × 1.25 × 1.5 ≈ 7.2  → score ≈ 93 ✓
//        → wind in SP15:  13.19 × 1.15 × 1.5 ≈ 22.8 → score ≈ 77 ✓
//        → gas anywhere:  13.19 × 0.40 × 1.5 ≈ 7.9  → score ≈ 92 ✓
const SCALE = 1.5;

function computeScore(
  zone: string,
  assetType: string,
  nodeNegPct: number,   // real avg neg_price_percent for this CAISO zone (28 months)
  nodeDaSpread: number, // avg DA - RT spread for this zone (positive = DA premium)
): number {
  const mult = getAssetMult(assetType, zone);
  const primaryPenalty = nodeNegPct * mult * SCALE;
  // DA-RT spread bonus: higher spread means worse RT realization → small penalty
  // In CAISO all spreads positive ($0.89-$1.12). Adjust by ±3 max.
  const spreadPenalty = Math.min(3, Math.max(-3, nodeDaSpread * 0.5));
  const rawScore = 100 - primaryPenalty - spreadPenalty;
  return Math.round(Math.min(98, Math.max(5, rawScore)) * 100) / 100;
}

async function main() {
  console.log("🔍 Fetching CAISO zone stats from real OASIS data (2024-2026)...");

  // Aggregate per node over all available months (2024-2026 real data)
  const nodeStats = await db.execute<{
    node: string;
    avg_neg_pct: number;
    avg_spread: number;
    months: number;
  }>(sql`
    SELECT node,
           AVG(neg_price_percent::numeric) AS avg_neg_pct,
           AVG(avg_da_price::numeric - COALESCE(avg_rt_price::numeric, avg_da_price::numeric)) AS avg_spread,
           COUNT(*) AS months
    FROM caiso_node_stats
    WHERE avg_da_price IS NOT NULL
    GROUP BY node
  `);

  const zoneMap: Record<string, { neg_pct: number; spread: number; months: number }> = {};
  for (const row of nodeStats.rows) {
    zoneMap[row.node] = {
      neg_pct: Number(row.avg_neg_pct ?? 8),
      spread: Number(row.avg_spread ?? 1.0),
      months: Number(row.months),
    };
  }

  console.log("   CAISO zone signals (real OASIS data):");
  for (const [node, stats] of Object.entries(zoneMap)) {
    console.log(`     ${node}: neg_price ${stats.neg_pct.toFixed(2)}%, DA-RT spread $${stats.spread.toFixed(3)}/MWh (${stats.months} months)`);
  }

  // Fetch all CAISO candidates
  const candidates = await db.execute<{
    id: number;
    name: string;
    asset_type: string;
    latitude: number;
    longitude: number;
  }>(sql`
    SELECT id, name, asset_type, latitude::float, longitude::float
    FROM candidates WHERE market = 'CAISO'
    ORDER BY id
  `);

  console.log(`\n📊 Scoring ${candidates.rows.length} CAISO candidates...`);

  const updates: { id: number; score: number; zone: string }[] = [];

  for (const c of candidates.rows) {
    const zone = mapToCaisoZone(Number(c.latitude), Number(c.longitude));
    const stats = zoneMap[zone] ?? { neg_pct: 8.0, spread: 1.0 }; // safe fallback
    const score = computeScore(zone, c.asset_type, stats.neg_pct, stats.spread);
    updates.push({ id: c.id, score, zone });
  }

  // Stats preview
  const byZone: Record<string, number[]> = {};
  const byType: Record<string, number[]> = {};
  for (const u of updates) {
    (byZone[u.zone] ??= []).push(u.score);
    const c = candidates.rows.find(r => r.id === u.id)!;
    (byType[c.asset_type] ??= []).push(u.score);
  }

  console.log("\n   Scores by zone (avg):");
  for (const [zone, scores] of Object.entries(byZone).sort()) {
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    console.log(`     ${zone}: avg ${avg.toFixed(1)}, min ${Math.min(...scores).toFixed(1)}, max ${Math.max(...scores).toFixed(1)} (${scores.length} candidates)`);
  }
  console.log("\n   Scores by asset type (avg):");
  for (const [type, scores] of Object.entries(byType).sort()) {
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    console.log(`     ${type}: avg ${avg.toFixed(1)} (${scores.length} candidates)`);
  }

  // Batch update
  console.log("\n💾 Writing curtailment_score + pricing_hub_node to DB...");
  const CHUNK = 100;
  let updated = 0;

  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await Promise.all(chunk.map(u =>
      db.execute(sql`
        UPDATE candidates
        SET curtailment_score = ${u.score.toFixed(2)}::numeric,
            pricing_hub_node  = ${u.zone},
            updated_at        = NOW()
        WHERE id = ${u.id}
      `)
    ));
    updated += chunk.length;
    process.stdout.write(`\r   ${updated}/${updates.length} updated...`);
  }

  // Recompute overall_score for all CAISO candidates (risk_adjusted_value weights)
  console.log("\n🔄 Recomputing overall_score for CAISO candidates...");
  await db.execute(sql`
    UPDATE candidates
    SET overall_score = ROUND((
      COALESCE(price_score::numeric,          50) * 0.20 +
      COALESCE(financial_score::numeric,       50) * 0.15 +
      COALESCE(regulatory_score::numeric,      50) * 0.15 +
      COALESCE(development_risk_score::numeric,50) * 0.15 +
      COALESCE(interconnection_score::numeric, 50) * 0.10 +
      COALESCE(curtailment_score::numeric,     50) * 0.10 +
      COALESCE(location_score::numeric,        50) * 0.05 +
      COALESCE(grid_stability_score::numeric,  50) * 0.05 +
      COALESCE(environmental_score::numeric,   50) * 0.03 +
      COALESCE(demand_proximity_score::numeric,50) * 0.02
    ), 2),
    updated_at = NOW()
    WHERE market = 'CAISO'
  `);

  console.log(`\n✅ Done — scored ${updated} CAISO candidates.`);
  console.log("   curtailment_score now reflects:");
  console.log("     • CAISO zone by lat/lon (NP15/ZP26/SP15)");
  console.log("     • Real OASIS neg_price_percent per zone (28 months, 2024-2026)");
  console.log("     • Asset-type curtailment multipliers (solar >> wind > storage > gas/hydro)");
  console.log("     • DA-RT spread adjustment (real OASIS)");
  console.log("   pricing_hub_node records the mapped CAISO zone.");
  console.log("   overall_score recomputed (risk_adjusted_value weights).");

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
