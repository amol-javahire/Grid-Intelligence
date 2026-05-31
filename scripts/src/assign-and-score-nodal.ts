/**
 * assign-and-score-nodal.ts
 *
 * Improves scoring for ERCOT and CAISO candidates by using the interconnection
 * queue's lat/lon data to assign each EIA 860 plant to its nearest queue-confirmed
 * pricing node — then re-scores curtailment AND congestion with full nodal granularity.
 *
 * What this replaces:
 *   Before: 4-zone bounding box (LZ_WEST/NORTH/SOUTH/HOUSTON) for ERCOT
 *   After:  10 distinct nodes with individual real DA prices (CDR 13060, 28 months):
 *           LZ_LCRA $36.62  LZ_HOUSTON $34.49  LZ_CPS $31.06  LZ_AEN $30.76
 *           HB_SOUTH $30.58  LZ_SOUTH $30.19  LZ_WEST $29.59  HB_NORTH $29.49
 *           LZ_NORTH $28.35  HB_WEST $26.76   (+ HB_PAN $20.38 geo fallback)
 *
 * ERCOT queue: 480 projects with lat/lon + interconnection_node
 * CAISO queue: 2,433 projects with lat/lon + NP15/SP15 node
 *
 * Algorithm:
 *   1. For each candidate, find the nearest queue project in the same market (Haversine)
 *   2. If within RADIUS_KM: use that queue project's interconnection_node
 *   3. Else: geographic fallback (bounding box)
 *   4. Write the resolved node to candidates.interconnection_node
 *   5. Re-score curtailment_score and interconnection_score using node-level real data
 *   6. Recompute overall_score
 *
 * Run anytime new queue data is seeded.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const RADIUS_KM = 200; // accept nearest queue project within 200 km

// ── ERCOT: real hub/zone DA prices, CDR 13060, 2024-2026 (28 months) ─────────
const ERCOT_NODE_DA: Record<string, number> = {
  LZ_LCRA:    36.62,  // Central TX — LCRA territory, HIGHEST realized DA
  HB_HOUSTON: 35.42,  // Houston hub
  LZ_HOUSTON: 34.49,  // Houston load zone
  LZ_CPS:     31.06,  // San Antonio / CPS Energy territory
  LZ_AEN:     30.76,  // AEP Texas Central (Corpus/Laredo area)
  HB_SOUTH:   30.58,  // South hub
  LZ_SOUTH:   30.19,  // South load zone
  LZ_WEST:    29.59,  // West load zone
  HB_NORTH:   29.49,  // North hub
  HB_BUSAVG:  29.16,  // System average reference
  LZ_RAYBN:   28.92,  // Rayburn Electric territory (East TX)
  LZ_NORTH:   28.35,  // North load zone (DFW area)
  HB_WEST:    26.76,  // West hub
  HB_PAN:     20.38,  // Panhandle hub — most congested, -30% vs avg
};
const ERCOT_BUSAVG = ERCOT_NODE_DA.HB_BUSAVG;

// ── ERCOT: neg-price % proxy per node (calibrated from CDR 12301 fleet avg=6.42%) ─
// High-curtailment zones get above-fleet penalty; load centers get below-fleet bonus
const ERCOT_NODE_NEG_PCT: Record<string, number> = {
  LZ_LCRA:    5.0,   // Central TX — relatively low curtailment
  HB_HOUSTON: 3.5,   // Load center, minimal
  LZ_HOUSTON: 3.5,
  LZ_CPS:     5.5,   // Central TX growing solar, some curtailment
  LZ_AEN:     8.0,   // South TX, coastal wind/solar mix
  HB_SOUTH:   7.5,
  LZ_SOUTH:   8.5,   // South TX — more solar saturation
  LZ_WEST:    15.0,  // West TX — significant curtailment for renewables
  HB_NORTH:   6.0,
  LZ_NORTH:   5.5,   // DFW area — good load sink
  HB_BUSAVG:  6.42,  // Fleet average
  LZ_RAYBN:   5.0,   // East TX — decent load
  HB_WEST:    18.0,  // West hub area — highest curtailment
  HB_PAN:     25.0,  // Panhandle — extreme curtailment for renewables
};

// ── CAISO: real zone stats, OASIS PRC_LMP, 2024-2026 ────────────────────────
const CAISO_ZONE_STATS: Record<string, { da: number; vol: number; neg_pct: number }> = {
  NP15: { da: 37.42, vol: 16.90, neg_pct: 3.82  },
  SP15: { da: 30.77, vol: 22.30, neg_pct: 13.19 },
  ZP26: { da: 29.56, vol: 22.37, neg_pct: 14.79 },
};
const CAISO_REF_DA = 33.19;

// ── Geographic fallback for ERCOT when no queue project is nearby ─────────────
function ercotGeoFallback(lat: number, lon: number): string {
  if (lon < -101.5) return "HB_PAN";
  if (lon < -99.5)  return "HB_WEST";
  if (lat >= 32.5 && lon >= -99.5 && lon < -96.5) return "HB_NORTH";
  if (lat >= 29.5 && lon >= -96.5) return "LZ_HOUSTON";
  if (lat < 28.5) return "LZ_AEN";
  return "LZ_CPS"; // Central TX default
}

// ── Asset multipliers for curtailment ────────────────────────────────────────
const ERCOT_CURT_MULT: Record<string, number> = {
  wind: 1.30, solar: 1.25, storage: 0.75, natural_gas: 0.45,
  nuclear: 0.38, hydro: 0.55, biomass: 0.50,
};
const CAISO_CURT_MULT: Record<string, Record<string, number>> = {
  solar:       { NP15: 1.25, SP15: 1.35, ZP26: 1.40 },
  wind:        { NP15: 1.05, SP15: 1.15, ZP26: 1.10 },
  storage:     { NP15: 0.60, SP15: 0.65, ZP26: 0.65 },
  natural_gas: { NP15: 0.40, SP15: 0.40, ZP26: 0.40 },
  hydro:       { NP15: 0.35, SP15: 0.40, ZP26: 0.38 },
  geothermal:  { NP15: 0.30, SP15: 0.30, ZP26: 0.30 },
  biomass:     { NP15: 0.45, SP15: 0.45, ZP26: 0.45 },
  nuclear:     { NP15: 0.28, SP15: 0.28, ZP26: 0.28 },
};

// ── Asset adjustments for congestion ─────────────────────────────────────────
const ERCOT_CONG_ADJ: Record<string, number> = {
  wind: -10, solar: -7, storage: +6, natural_gas: +7, nuclear: +7, hydro: +5, biomass: +4,
};
const CAISO_CONG_ADJ: Record<string, Record<string, number>> = {
  solar:       { NP15: -3, SP15: -7, ZP26: -8 },
  wind:        { NP15: -2, SP15: -4, ZP26: -5 },
  storage:     { NP15: +6, SP15: +6, ZP26: +6 },
  natural_gas: { NP15:+12, SP15:+10, ZP26:+10 },
  hydro:       { NP15:+10, SP15: +8, ZP26: +8 },
  geothermal:  { NP15:+12, SP15:+10, ZP26:+10 },
  biomass:     { NP15: +6, SP15: +5, ZP26: +5 },
  nuclear:     { NP15:+12, SP15:+10, ZP26:+10 },
};

function ercotCurtailmentScore(node: string, assetType: string): number {
  const negPct = ERCOT_NODE_NEG_PCT[node] ?? 6.42;
  const mult = ERCOT_CURT_MULT[assetType] ?? 0.8;
  const penalty = negPct * mult * 1.4;
  const raw = 100 - penalty;
  return Math.round(Math.min(98, Math.max(5, raw)) * 100) / 100;
}

function ercotCongestionScore(node: string, assetType: string): number {
  const da = ERCOT_NODE_DA[node] ?? ERCOT_BUSAVG;
  const basisPct = (da - ERCOT_BUSAVG) / ERCOT_BUSAVG;
  const assetAdj = ERCOT_CONG_ADJ[assetType] ?? 0;
  const raw = 50 + basisPct * 150 + assetAdj;
  return Math.round(Math.min(98, Math.max(5, raw)) * 100) / 100;
}

function caisoCurtailmentScore(zone: string, assetType: string): number {
  const stats = CAISO_ZONE_STATS[zone] ?? CAISO_ZONE_STATS.SP15;
  const multMap = CAISO_CURT_MULT[assetType];
  const mult = multMap ? (multMap[zone] ?? 1.0) : 0.8;
  const penalty = stats.neg_pct * mult * 1.5;
  const spreadPenalty = Math.min(3, Math.max(-3, (stats.da - CAISO_REF_DA) * -0.5));
  return Math.round(Math.min(98, Math.max(5, 100 - penalty + spreadPenalty)) * 100) / 100;
}

function caisoCongestionScore(zone: string, assetType: string): number {
  const stats = CAISO_ZONE_STATS[zone] ?? CAISO_ZONE_STATS.SP15;
  const basisPct = (stats.da - CAISO_REF_DA) / CAISO_REF_DA;
  const volRange = CAISO_ZONE_STATS.SP15.vol - CAISO_ZONE_STATS.NP15.vol; // 5.4
  const volPenalty = ((stats.vol - CAISO_ZONE_STATS.NP15.vol) / volRange) * 8;
  const adjMap = CAISO_CONG_ADJ[assetType];
  const assetAdj = adjMap ? (adjMap[zone] ?? 0) : 0;
  return Math.round(Math.min(98, Math.max(5, 50 + basisPct * 100 - volPenalty + assetAdj)) * 100) / 100;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(" Queue-based nodal assignment + scoring");
  console.log("═══════════════════════════════════════════════════════\n");

  // ── Step 1: ERCOT nearest-neighbour assignment ────────────────────────────
  console.log("📍 ERCOT: Haversine nearest-neighbour against 480 queue projects...");

  const ercotCandidates = await db.execute<{
    id: number; asset_type: string; latitude: number; longitude: number;
  }>(sql`
    SELECT id, asset_type, latitude::float, longitude::float
    FROM candidates WHERE market = 'ERCOT' ORDER BY id
  `);

  // One SQL call: for each candidate, find nearest queue project within RADIUS_KM
  const ercotMatches = await db.execute<{
    candidate_id: number;
    queue_node: string;
    distance_km: number;
  }>(sql`
    SELECT DISTINCT ON (c.id)
      c.id AS candidate_id,
      q.interconnection_node AS queue_node,
      (6371.0 * ACOS(LEAST(1.0,
        COS(RADIANS(c.latitude::float)) * COS(RADIANS(q.latitude::float)) *
        COS(RADIANS(q.longitude::float) - RADIANS(c.longitude::float)) +
        SIN(RADIANS(c.latitude::float)) * SIN(RADIANS(q.latitude::float))
      ))) AS distance_km
    FROM candidates c
    JOIN queue_projects q
      ON q.market = 'ERCOT'
      AND q.latitude IS NOT NULL
      AND q.interconnection_node IS NOT NULL
    WHERE c.market = 'ERCOT'
    ORDER BY c.id, distance_km
  `);

  const ercotNodeMap = new Map<number, string>();
  let queueHitCount = 0;
  let geoFallbackCount = 0;

  for (const m of ercotMatches.rows) {
    if (Number(m.distance_km) <= RADIUS_KM) {
      ercotNodeMap.set(m.candidate_id, m.queue_node);
      queueHitCount++;
    }
  }
  // Fill fallbacks using geographic bounding box
  for (const c of ercotCandidates.rows) {
    if (!ercotNodeMap.has(c.id)) {
      ercotNodeMap.set(c.id, ercotGeoFallback(Number(c.latitude), Number(c.longitude)));
      geoFallbackCount++;
    }
  }

  console.log(`   Queue match (≤${RADIUS_KM}km): ${queueHitCount}  |  geo fallback: ${geoFallbackCount}`);

  // Node distribution
  const ercotNodeDist: Record<string, number> = {};
  for (const node of ercotNodeMap.values()) {
    ercotNodeDist[node] = (ercotNodeDist[node] ?? 0) + 1;
  }
  console.log("   Node distribution:");
  for (const [node, cnt] of Object.entries(ercotNodeDist).sort((a,b) => b[1]-a[1])) {
    const da = ERCOT_NODE_DA[node];
    console.log(`     ${node.padEnd(12)} ${cnt.toString().padStart(3)} candidates  (DA $${da?.toFixed(2) ?? "N/A"}/MWh)`);
  }

  // ── Step 2: CAISO nearest-neighbour assignment ────────────────────────────
  console.log("\n📍 CAISO: Haversine nearest-neighbour against 2,433 queue projects...");

  const caisoMatches = await db.execute<{
    candidate_id: number;
    queue_node: string;
    distance_km: number;
  }>(sql`
    SELECT DISTINCT ON (c.id)
      c.id AS candidate_id,
      q.interconnection_node AS queue_node,
      (6371.0 * ACOS(LEAST(1.0,
        COS(RADIANS(c.latitude::float)) * COS(RADIANS(q.latitude::float)) *
        COS(RADIANS(q.longitude::float) - RADIANS(c.longitude::float)) +
        SIN(RADIANS(c.latitude::float)) * SIN(RADIANS(q.latitude::float))
      ))) AS distance_km
    FROM candidates c
    JOIN queue_projects q
      ON q.market = 'CAISO'
      AND q.latitude IS NOT NULL
      AND q.interconnection_node IS NOT NULL
    WHERE c.market = 'CAISO'
    ORDER BY c.id, distance_km
  `);

  const caisoNodeMap = new Map<number, string>();
  let caisoHitCount = 0;

  for (const m of caisoMatches.rows) {
    if (Number(m.distance_km) <= RADIUS_KM) {
      caisoNodeMap.set(m.candidate_id, m.queue_node);
      caisoHitCount++;
    }
  }
  // CAISO fallback: lat-based (same as before, for the few not matched)
  const caisoCandidates = await db.execute<{
    id: number; asset_type: string; latitude: number; longitude: number;
  }>(sql`
    SELECT id, asset_type, latitude::float, longitude::float
    FROM candidates WHERE market = 'CAISO' ORDER BY id
  `);
  let caisoGeoFallback = 0;
  for (const c of caisoCandidates.rows) {
    if (!caisoNodeMap.has(c.id)) {
      const lat = Number(c.latitude), lon = Number(c.longitude);
      const zone = lat >= 37.5 ? "NP15"
        : (lat >= 35.0 && lon <= -118.5) ? "ZP26"
        : "SP15";
      caisoNodeMap.set(c.id, zone);
      caisoGeoFallback++;
    }
  }
  const caisoNodeDist: Record<string, number> = {};
  for (const node of caisoNodeMap.values()) {
    caisoNodeDist[node] = (caisoNodeDist[node] ?? 0) + 1;
  }
  console.log(`   Queue match (≤${RADIUS_KM}km): ${caisoHitCount}  |  geo fallback: ${caisoGeoFallback}`);
  console.log("   Node distribution:");
  for (const [node, cnt] of Object.entries(caisoNodeDist).sort((a,b) => b[1]-a[1])) {
    const da = CAISO_ZONE_STATS[node]?.da;
    console.log(`     ${node.padEnd(6)} ${cnt.toString().padStart(4)} candidates  (DA $${da?.toFixed(2) ?? "N/A"}/MWh)`);
  }

  // ── Step 3: Compute scores for all candidates ─────────────────────────────
  console.log("\n📊 Computing curtailment + congestion scores per candidate...");

  interface CandidateUpdate {
    id: number;
    node: string;
    curtailment: string;
    congestion: string;
  }

  const updates: CandidateUpdate[] = [];

  for (const c of ercotCandidates.rows) {
    const node = ercotNodeMap.get(c.id)!;
    const curtailment = ercotCurtailmentScore(node, c.asset_type);
    const congestion  = ercotCongestionScore(node, c.asset_type);
    updates.push({ id: c.id, node, curtailment: curtailment.toFixed(2), congestion: congestion.toFixed(2) });
  }
  for (const c of caisoCandidates.rows) {
    const node = caisoNodeMap.get(c.id)!;
    const curtailment = caisoCurtailmentScore(node, c.asset_type);
    const congestion  = caisoCongestionScore(node, c.asset_type);
    updates.push({ id: c.id, node, curtailment: curtailment.toFixed(2), congestion: congestion.toFixed(2) });
  }

  // Score preview by node
  console.log("\n   ERCOT score preview by node (curtailment | congestion avg):");
  const byErcotNode: Record<string, {curt: number[]; cong: number[]}> = {};
  for (const u of updates.filter(u => ercotNodeMap.has(u.id))) {
    (byErcotNode[u.node] ??= {curt:[], cong:[]}).curt.push(Number(u.curtailment));
    byErcotNode[u.node].cong.push(Number(u.congestion));
  }
  for (const [node, d] of Object.entries(byErcotNode).sort((a,b)=>
      (ERCOT_NODE_DA[b[0]]??0)-(ERCOT_NODE_DA[a[0]]??0))) {
    const ca = (d.curt.reduce((s,v)=>s+v,0)/d.curt.length).toFixed(1);
    const co = (d.cong.reduce((s,v)=>s+v,0)/d.cong.length).toFixed(1);
    console.log(`     ${node.padEnd(12)} curt ${ca}  cong ${co}  (${d.curt.length} candidates, DA $${(ERCOT_NODE_DA[node]??0).toFixed(2)})`);
  }

  // ── Step 4: Batch-update DB ───────────────────────────────────────────────
  console.log("\n💾 Writing node assignment + scores to DB...");
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await Promise.all(chunk.map(u =>
      db.execute(sql`
        UPDATE candidates
        SET interconnection_node  = ${u.node},
            pricing_hub_node      = ${u.node},
            curtailment_score     = ${u.curtailment}::numeric,
            interconnection_score = ${u.congestion}::numeric,
            updated_at            = NOW()
        WHERE id = ${u.id}
      `)
    ));
    written += chunk.length;
    process.stdout.write(`\r   ${written}/${updates.length} updated...`);
  }

  // ── Step 5: Recompute overall_score for ERCOT + CAISO ────────────────────
  console.log("\n🔄 Recomputing overall_score for ERCOT + CAISO...");
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
    WHERE market IN ('ERCOT', 'CAISO')
  `);

  console.log("\n\n✅ Done.");
  console.log("   interconnection_node: queue-confirmed node (Haversine nearest, ≤200km)");
  console.log("   pricing_hub_node:     same — both columns now point to precise node");
  console.log("   curtailment_score:    nodal neg-price % × asset-type multiplier");
  console.log("   interconnection_score: hub DA basis vs BUSAVG × asset-type adj");
  console.log("   overall_score:        recomputed for both ERCOT and CAISO");

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
