/**
 * score-caiso-congestion.ts
 *
 * Updates interconnection_score (congestion) for all CAISO candidates using real OASIS data.
 *
 * Signals from caiso_node_stats (real OASIS PRC_LMP, 2024-2026):
 *   NP15: avg DA $37.42/MWh, volatility 16.9  → strong NorCal demand, lower congestion
 *   SP15: avg DA $30.77/MWh, volatility 22.3  → LA Basin, solar overgen suppresses prices
 *   ZP26: avg DA $29.56/MWh, volatility 22.4  → Central Valley, constrained export, lowest DA
 *
 * Reference (system avg of 3 zones): $32.58/MWh
 *
 * Formula:
 *   basis_pct  = (zone_da - reference_da) / reference_da
 *   vol_penalty = (zone_vol - min_vol) / vol_range * vol_scale  (punishes high basis volatility)
 *   base_score = 50 + basis_pct * 100 - vol_penalty
 *   + asset-type adjustment
 *
 * Score 100 = no congestion; 0 = severe chronic discounting.
 * Solar in ZP26 scores ~30-35; gas in NP15 scores ~75-85.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Real zone stats — CAISO OASIS, 2024-2026 ─────────────────────────────────
const ZONE_STATS: Record<string, { da: number; vol: number; months: number }> = {
  NP15: { da: 37.42, vol: 16.90, months: 28 },
  SP15: { da: 30.77, vol: 22.30, months: 28 },
  ZP26: { da: 29.56, vol: 22.37, months: 14 }, // 14 months available
};

// System reference = avg DA across the three zones (weighted by months)
const totalMonths = Object.values(ZONE_STATS).reduce((s, z) => s + z.months, 0);
const REF_DA = Object.values(ZONE_STATS).reduce((s, z) => s + z.da * z.months, 0) / totalMonths;
const MIN_VOL = Math.min(...Object.values(ZONE_STATS).map(z => z.vol));
const MAX_VOL = Math.max(...Object.values(ZONE_STATS).map(z => z.vol));
const VOL_RANGE = MAX_VOL - MIN_VOL;

const BASIS_SCALE = 100;   // basis_pct * 100 → ±15 pts for ±15% basis
const VOL_SCALE   = 8;     // full vol range = 8 pts penalty

// ── Asset-type adjustments ─────────────────────────────────────────────────────
// CAISO congestion: DA congestion charges reduce generator revenue at constrained nodes.
// SP15/ZP26 solar faces mid-day export constraints (Path 26, Path 15).
// Dispatchable assets can avoid congested hours; storage arbitrages congestion.
const ASSET_ADJ: Record<string, Record<string, number>> = {
  solar:       { NP15: -3, SP15: -7, ZP26: -8 },
  wind:        { NP15: -2, SP15: -4, ZP26: -5 },
  storage:     { NP15: +6, SP15: +6, ZP26: +6 },  // benefits from spread
  natural_gas: { NP15:+12, SP15:+10, ZP26:+10 },  // dispatchable, captures scarcity
  hydro:       { NP15:+10, SP15: +8, ZP26: +8 },  // highly dispatchable
  geothermal:  { NP15:+12, SP15:+10, ZP26:+10 },  // baseload, no congestion exposure
  biomass:     { NP15: +6, SP15: +5, ZP26: +5 },
  nuclear:     { NP15:+12, SP15:+10, ZP26:+10 },
};

function getAssetAdj(assetType: string, zone: string): number {
  const m = ASSET_ADJ[assetType];
  if (!m) return 0;
  return m[zone] ?? 0;
}

// ── Zone mapping (same as curtailment) ───────────────────────────────────────
function mapToCaisoZone(lat: number, lon: number): string {
  if (lat >= 37.5) return "NP15";
  if (lat >= 36.5 && lon < -120.5) return "NP15";
  if (lat >= 35.0 && lon <= -118.5 && lon >= -122.0) return "ZP26";
  return "SP15";
}

function computeScore(zone: string, assetType: string): number {
  const stats = ZONE_STATS[zone] ?? ZONE_STATS.SP15;
  const basisPct = (stats.da - REF_DA) / REF_DA;
  const volPenalty = VOL_RANGE > 0 ? ((stats.vol - MIN_VOL) / VOL_RANGE) * VOL_SCALE : 0;
  const assetAdj = getAssetAdj(assetType, zone);
  const raw = 50 + basisPct * BASIS_SCALE - volPenalty + assetAdj;
  return Math.round(Math.min(98, Math.max(5, raw)) * 100) / 100;
}

async function main() {
  console.log("🔍 CAISO Congestion Scoring — real OASIS DA prices + volatility (2024-2026)");
  console.log(`   Reference DA: $${REF_DA.toFixed(2)}/MWh (weighted avg NP15/SP15/ZP26)`);
  for (const [zone, s] of Object.entries(ZONE_STATS)) {
    const bp = ((s.da - REF_DA) / REF_DA * 100).toFixed(1);
    console.log(`   ${zone}: $${s.da}/MWh (${bp}% basis), vol ${s.vol} (${s.months} months)`);
  }

  const candidates = await db.execute<{
    id: number; name: string; asset_type: string;
    latitude: number; longitude: number; pricing_hub_node: string | null;
  }>(sql`
    SELECT id, name, asset_type, latitude::float, longitude::float, pricing_hub_node
    FROM candidates WHERE market = 'CAISO' ORDER BY id
  `);

  console.log(`\n📊 Scoring ${candidates.rows.length} CAISO candidates...`);

  const updates: { id: number; score: number; zone: string }[] = [];

  for (const c of candidates.rows) {
    // Use pricing_hub_node if already set (from curtailment script), else re-derive
    const zone = c.pricing_hub_node ?? mapToCaisoZone(Number(c.latitude), Number(c.longitude));
    const score = computeScore(zone, c.asset_type);
    updates.push({ id: c.id, score, zone });
  }

  // Preview stats
  const byZone: Record<string, number[]> = {};
  const byType: Record<string, number[]> = {};
  for (const u of updates) {
    (byZone[u.zone] ??= []).push(u.score);
    const c = candidates.rows.find(r => r.id === u.id)!;
    (byType[c.asset_type] ??= []).push(u.score);
  }

  console.log("\n   Scores by zone (avg):");
  for (const [zone, scores] of Object.entries(byZone).sort()) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`     ${zone.padEnd(6)}: avg ${avg.toFixed(1)}, min ${Math.min(...scores).toFixed(1)}, max ${Math.max(...scores).toFixed(1)} (${scores.length})`);
  }
  console.log("\n   Scores by asset type (avg):");
  for (const [type, scores] of Object.entries(byType).sort()) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`     ${type.padEnd(14)}: avg ${avg.toFixed(1)} (${scores.length})`);
  }

  // Batch update
  console.log("\n💾 Writing interconnection_score to DB + recomputing overall_score...");
  const CHUNK = 100;
  let updated = 0;

  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await Promise.all(chunk.map(u =>
      db.execute(sql`
        UPDATE candidates
        SET interconnection_score = ${u.score.toFixed(2)}::numeric,
            updated_at = NOW()
        WHERE id = ${u.id}
      `)
    ));
    updated += chunk.length;
    process.stdout.write(`\r   ${updated}/${updates.length} updated...`);
  }

  await db.execute(sql`
    UPDATE candidates
    SET overall_score = ROUND((
      COALESCE(price_score::numeric,           50) * 0.20 +
      COALESCE(financial_score::numeric,        50) * 0.15 +
      COALESCE(regulatory_score::numeric,       50) * 0.15 +
      COALESCE(development_risk_score::numeric, 50) * 0.15 +
      COALESCE(interconnection_score::numeric,  50) * 0.10 +
      COALESCE(curtailment_score::numeric,      50) * 0.10 +
      COALESCE(location_score::numeric,         50) * 0.05 +
      COALESCE(grid_stability_score::numeric,   50) * 0.05 +
      COALESCE(environmental_score::numeric,    50) * 0.03 +
      COALESCE(demand_proximity_score::numeric, 50) * 0.02
    ), 2),
    updated_at = NOW()
    WHERE market = 'CAISO'
  `);

  console.log(`\n\n✅ Done — scored ${updated} CAISO candidates.`);
  console.log("   interconnection_score (congestion) now reflects:");
  console.log("     • Zone DA basis vs reference ($" + REF_DA.toFixed(2) + "/MWh) — real OASIS 2024-2026");
  console.log("     • Volatility penalty (NP15 16.9 vs ZP26/SP15 ~22.4) — real OASIS");
  console.log("     • Asset-type adjustment (gas/geo/nuclear +10-12; solar/wind penalised)");
  console.log("   overall_score recomputed.");

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
