/**
 * score-ercot-congestion.ts
 *
 * Updates interconnection_score (congestion) for all ERCOT candidates using real CDR data.
 *
 * Signal: nodal basis discount vs system average — real hub DA prices (2024-2026, CDR 13060)
 *   HB_BUSAVG (system avg):  $29.16/MWh  ← reference
 *   HB_HOUSTON:              $35.42/MWh  (+21.5% vs avg) → best generator location
 *   HB_SOUTH:                $30.58/MWh  (+4.9%)
 *   HB_NORTH:                $29.49/MWh  (+1.1%)
 *   HB_WEST:                 $26.76/MWh  (-8.2%)  → constrained exit for west TX generation
 *   HB_PAN (Panhandle):      $20.38/MWh  (-30.1%) → severe congestion, heaviest discounting
 *
 * Formula: basis_pct = (hub_da - busavg_da) / busavg_da
 *          base_score = 50 + basis_pct * 150  (scale so HB_HOUSTON → ~82, HB_PAN → ~5)
 *          + asset-type adjustment (renewables in constrained zones get extra penalty)
 *
 * Score 100 = no congestion; score 0 = severe chronic discounting.
 * Wind in Panhandle scores ~5-20; gas in LZ_HOUSTON scores ~85-92.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Real hub DA prices — CDR 13060, 2024-2026 (28 months each) ────────────────
// These are computed as constants to avoid a DB round-trip — they come from the
// ercot_node_stats table, hub rows, avg(avg_da_price) WHERE year >= 2024.
const HUB_PRICES: Record<string, number> = {
  HB_BUSAVG:  29.16,   // system average (reference)
  HB_HOUSTON: 35.42,   // load center — premium location for generators
  HB_SOUTH:   30.58,
  HB_NORTH:   29.49,
  HB_WEST:    26.76,   // west TX — generation constrained exit
  HB_PAN:     20.38,   // Panhandle — severe congestion, lowest realized prices
};

const HUB_VOLATILITY: Record<string, number> = {
  HB_HOUSTON: 2.993,
  HB_NORTH:   2.922,
  HB_WEST:    2.706,
  HB_SOUTH:   2.654,
};

const BUSAVG_DA = HUB_PRICES.HB_BUSAVG;
const SCALE = 150; // basis_pct * 150 → ±30 pts for ±20% basis

// ── Zone → hub mapping ─────────────────────────────────────────────────────────
// For candidates in LZ_WEST and deep in the panhandle, use HB_PAN as proxy.
// This matches the geographic congestion reality: Panhandle wind faces the most
// constrained path to load centers (despite CREZ build-out, chronic congestion remains).
function getHubForCandidate(zone: string, lon: number): string {
  if (zone === "LZ_HOUSTON") return "HB_HOUSTON";
  if (zone === "LZ_NORTH")   return "HB_NORTH";
  if (zone === "LZ_SOUTH")   return "HB_SOUTH";
  if (zone === "LZ_WEST") {
    // Deep Panhandle (Amarillo area): lon < -101.5 → HB_PAN (worst congestion)
    // West TX transition zone: lon < -100.5 → blend of HB_WEST / HB_PAN
    if (lon < -101.5) return "HB_PAN";
    return "HB_WEST";
  }
  return "HB_BUSAVG"; // fallback
}

// ── Asset-type congestion adjustments ────────────────────────────────────────
// Renewables in constrained zones face the worst congestion: they cannot ramp down
// and must accept whatever nodal price clears, including near-zero/negative events.
// Dispatchable assets avoid worst congestion hours; storage can arbitrage it.
const ASSET_ADJ: Record<string, Record<string, number>> = {
  wind:        { LZ_WEST:-12, LZ_NORTH:-4, LZ_SOUTH:-2, LZ_HOUSTON: 0, default:-5 },
  solar:       { LZ_WEST: -9, LZ_NORTH:-3, LZ_SOUTH:-3, LZ_HOUSTON:-1, default:-3 },
  storage:     { LZ_WEST: +6, LZ_NORTH:+5, LZ_SOUTH:+5, LZ_HOUSTON:+5, default:+5 },
  natural_gas: { LZ_WEST: +7, LZ_NORTH:+5, LZ_SOUTH:+5, LZ_HOUSTON:+7, default:+5 },
  nuclear:     { LZ_WEST: +7, LZ_NORTH:+6, LZ_SOUTH:+6, LZ_HOUSTON:+7, default:+6 },
  hydro:       { LZ_WEST: +5, LZ_NORTH:+4, LZ_SOUTH:+4, LZ_HOUSTON:+5, default:+4 },
  biomass:     { LZ_WEST: +4, LZ_NORTH:+4, LZ_SOUTH:+4, LZ_HOUSTON:+4, default:+4 },
};

function getAssetAdj(assetType: string, zone: string): number {
  const m = ASSET_ADJ[assetType];
  if (!m) return 0;
  return m[zone] ?? m["default"] ?? 0;
}

function computeScore(hub: string, zone: string, assetType: string): number {
  const hubDa = HUB_PRICES[hub] ?? BUSAVG_DA;
  const basisPct = (hubDa - BUSAVG_DA) / BUSAVG_DA;
  const baseScore = 50 + basisPct * SCALE;
  const assetAdj = getAssetAdj(assetType, zone);
  const raw = baseScore + assetAdj;
  return Math.round(Math.min(98, Math.max(5, raw)) * 100) / 100;
}

async function main() {
  console.log("🔍 ERCOT Congestion Scoring — real hub DA prices (CDR 13060, 2024-2026)");
  console.log("   Hub prices used:");
  for (const [hub, price] of Object.entries(HUB_PRICES)) {
    const basisPct = ((price - BUSAVG_DA) / BUSAVG_DA * 100).toFixed(1);
    console.log(`     ${hub.padEnd(12)} $${price.toFixed(2)}/MWh  (${basisPct}% vs BUSAVG)`);
  }

  const candidates = await db.execute<{
    id: number; name: string; asset_type: string;
    pricing_hub_node: string | null; longitude: number;
  }>(sql`
    SELECT id, name, asset_type, pricing_hub_node, longitude::float
    FROM candidates WHERE market = 'ERCOT' ORDER BY id
  `);

  console.log(`\n📊 Scoring ${candidates.rows.length} ERCOT candidates...`);

  const updates: { id: number; score: number; hub: string; zone: string }[] = [];

  for (const c of candidates.rows) {
    // pricing_hub_node was set to the load zone by score-ercot-curtailment
    const zone = c.pricing_hub_node ?? "LZ_WEST";
    const hub  = getHubForCandidate(zone, Number(c.longitude));
    const score = computeScore(hub, zone, c.asset_type);
    updates.push({ id: c.id, score, hub, zone });
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
    console.log(`     ${zone.padEnd(12)}: avg ${avg.toFixed(1)}, min ${Math.min(...scores).toFixed(1)}, max ${Math.max(...scores).toFixed(1)} (${scores.length})`);
  }
  console.log("\n   Scores by asset type (avg):");
  for (const [type, scores] of Object.entries(byType).sort()) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`     ${type.padEnd(14)}: avg ${avg.toFixed(1)} (${scores.length})`);
  }

  // Batch update + recompute overall_score
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

  // Recompute overall_score (risk_adjusted_value weights, interconnection_score = 10%)
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
    WHERE market = 'ERCOT'
  `);

  console.log(`\n\n✅ Done — scored ${updated} ERCOT candidates.`);
  console.log("   interconnection_score (congestion) now reflects:");
  console.log("     • Hub DA price basis vs HB_BUSAVG ($29.16) — real CDR 13060, 2024-2026");
  console.log("     • Panhandle (lon < -101.5) mapped to HB_PAN ($20.38/MWh, -30% basis discount)");
  console.log("     • LZ_WEST mapped to HB_WEST ($26.76/MWh, -8% basis discount)");
  console.log("     • LZ_HOUSTON mapped to HB_HOUSTON ($35.42/MWh, +21.5% premium)");
  console.log("     • Asset-type adjustment: renewables penalised in constrained zones");
  console.log("   overall_score recomputed.");

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
