/**
 * assign-and-score-nodal.ts  (v5 — Real PJM Signals)
 *
 * What's new vs v4:
 *   - PJM Haversine nearest-neighbour zone assignment against queue_projects
 *     (same approach as ERCOT/CAISO — was previously all-WESTERN-HUB)
 *   - Loads real PJM hub/zone DA prices, volatility, and neg_price_percent
 *     from pjm_node_stats (12 zones: PSEG, BGE, PPL, DOM, Eastern Hub, etc.)
 *   - PJM scoring now uses real DB signals instead of hardcoded placeholder values
 *   - Queue zone names (AEP-DAYTON HUB, NI HUB, etc.) mapped to pjm_node_stats
 *     node names (AEP-Dayton Hub, NI Hub, etc.)
 *   - ERCOT/CAISO logic unchanged from v4
 *
 * Scoring dimension → DB column mapping:
 *   price_score            → Capture Price   (hub/resource DA × tech timing ratio)
 *   curtailment_score      → Curtailment      (real neg_price_percent from resource nodes)
 *   interconnection_score  → Congestion       (real DA basis + volatility)
 *   location_score         → Basis Risk       (real volatility)
 *   financial_score        → Mkt Revenue      (annual energy revenue, log-scaled)
 *   development_risk_score → Interconnect     (queue MW backlog by zone)
 *   environmental_score    → RECs / Yr        (annual REC value, log-scaled)
 *   demand_proximity_score → Capacity         (log-scaled MW)
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const RADIUS_KM = 200;

const CAPTURE_RATIO: Record<string, number> = {
  wind:        0.82,
  solar:       1.03,
  storage:     1.18,
  natural_gas: 1.00,
  nuclear:     0.97,
  hydro:       0.98,
  biomass:     0.99,
  geothermal:  0.99,
  coal:        0.94,
};

const CF: Record<string, Record<string, number>> = {
  solar:       { ERCOT: 0.27, CAISO: 0.29, PJM: 0.22 },
  wind:        { ERCOT: 0.40, CAISO: 0.32, PJM: 0.35 },
  storage:     { ERCOT: 0.18, CAISO: 0.18, PJM: 0.18 },
  natural_gas: { ERCOT: 0.60, CAISO: 0.55, PJM: 0.58 },
  nuclear:     { ERCOT: 0.92, CAISO: 0.92, PJM: 0.92 },
  hydro:       { ERCOT: 0.40, CAISO: 0.42, PJM: 0.38 },
  biomass:     { ERCOT: 0.65, CAISO: 0.65, PJM: 0.65 },
  geothermal:  { ERCOT: 0.88, CAISO: 0.88, PJM: 0.88 },
  coal:        { ERCOT: 0.55, CAISO: 0.55, PJM: 0.55 },
};

const REC_PRICES: Record<string, Record<string, number>> = {
  solar:       { ERCOT: 1.50, CAISO: 12.00, PJM: 15.00 },
  wind:        { ERCOT: 1.50, CAISO: 10.00, PJM:  3.50 },
  hydro:       { ERCOT: 1.50, CAISO:  7.00, PJM:  2.00 },
  geothermal:  { ERCOT: 1.50, CAISO: 10.00, PJM:  5.00 },
  biomass:     { ERCOT: 1.50, CAISO:  8.00, PJM:  3.00 },
};
const REC_ELIGIBLE = new Set(["solar", "wind", "hydro", "geothermal", "biomass"]);

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
const PJM_CONG_ADJ: Record<string, number> = {
  wind: -8, solar: -6, storage: +5, natural_gas: +8, nuclear: +8, hydro: +6, biomass: +4, coal: +2,
};

// Map PJM queue zone names → pjm_node_stats node names
// Queue uses: AEP-DAYTON HUB, NI HUB, WESTERN HUB, EASTERN HUB (uppercase), JCPL, APS
// pjm_node_stats uses: AEP-Dayton Hub, NI Hub, Western Hub, Eastern Hub, PSEG, PENELEC, PPL, BGE, DOM
const PJM_QUEUE_ZONE_TO_NODE: Record<string, string> = {
  "AEP-DAYTON HUB": "AEP-Dayton Hub",
  "NI HUB":         "NI Hub",
  "WESTERN HUB":    "Western Hub",
  "EASTERN HUB":    "Eastern Hub",
  "PSEG":           "PSEG",
  "PENELEC":        "PENELEC",
  "PPL":            "PPL",
  "BGE":            "BGE",
  "DOM":            "DOM",
  // No direct pjm_node_stats equivalent — map to nearest hub
  "JCPL":           "PSEG",   // Jersey Central Power & Light → PSEG zone
  "APS":            "Western Hub", // Allegheny Power System → Western Hub area
};

function ercotGeoFallback(lat: number, lon: number): string {
  if (lon < -101.5) return "HB_PAN";
  if (lon < -99.5)  return "HB_WEST";
  if (lat >= 32.5 && lon >= -99.5 && lon < -96.5) return "HB_NORTH";
  if (lat >= 29.5 && lon >= -96.5) return "LZ_HOUSTON";
  if (lat < 28.5) return "LZ_AEN";
  return "LZ_CPS";
}

interface NodeStats { avg_da: number; avg_rt: number; avg_vol: number; avg_neg_pct: number; source: "resource" | "hub_zone"; }

// ─────────────────────────────────────────────────────────────────────────────
// Scoring functions — all use signalStats (resource-node-weighted zone avg when
// available, hub/zone CDR stats as fallback)
// ─────────────────────────────────────────────────────────────────────────────

function curtailmentScore(
  signalStats: NodeStats, assetType: string, market: string,
  ercotFleetAvgNegPct: number,
): number {
  if (market === "ERCOT") {
    const negPct = signalStats.avg_neg_pct;
    const mult = ERCOT_CURT_MULT[assetType] ?? 0.80;
    return Math.round(Math.min(98, Math.max(5, 100 - negPct * mult * 1.4)) * 100) / 100;
  }
  if (market === "CAISO") {
    const mult = 1.0; // CAISO adj handled via zone mapping
    const penalty = signalStats.avg_neg_pct * mult * 1.5;
    const spreadPenalty = Math.min(3, Math.max(-3, (signalStats.avg_da - 33.25) * -0.5));
    return Math.round(Math.min(98, Math.max(5, 100 - penalty + spreadPenalty)) * 100) / 100;
  }
  if (market === "PJM") {
    // Real neg_price_percent from pjm_node_stats; PJM rarely goes negative (<2%)
    // Asset-type multiplier applied (wind and solar have higher exposure)
    const pjmCurtMult: Record<string, number> = {
      wind: 1.20, solar: 1.15, storage: 0.60, natural_gas: 0.35,
      nuclear: 0.30, hydro: 0.50, biomass: 0.45, coal: 0.40,
    };
    const mult = pjmCurtMult[assetType] ?? 0.70;
    const negPct = signalStats.avg_neg_pct;
    return Math.round(Math.min(98, Math.max(40, 100 - negPct * mult * 12)) * 100) / 100;
  }
  return 72;
}

function congestionScore(
  signalStats: NodeStats, assetType: string, market: string,
  queueZone: string,
  ercotBusAvg: number, ercotSysVol: number,
  pjmBusAvg: number, pjmSysVol: number,
): number {
  if (market === "ERCOT") {
    const da = signalStats.avg_da;
    const vol = signalStats.avg_vol;
    const basisPct = (da - ercotBusAvg) / ercotBusAvg;
    const volPenalty = ((vol - ercotSysVol) / ercotSysVol) * 8;
    const assetAdj = ERCOT_CONG_ADJ[assetType] ?? 0;
    return Math.round(Math.min(98, Math.max(5, 50 + basisPct * 150 - volPenalty + assetAdj)) * 100) / 100;
  }
  if (market === "CAISO") {
    const caRefDA = 33.25;
    const caRefVol = 13.6;
    const basisPct = (signalStats.avg_da - caRefDA) / caRefDA;
    const volPenalty = ((signalStats.avg_vol - caRefVol) / caRefVol) * 8;
    const adjMap = CAISO_CONG_ADJ[assetType];
    const zone = queueZone in CAISO_CONG_ADJ[assetType] ? queueZone : (queueZone === "NP15" || queueZone === "ZP26" ? queueZone : "SP15");
    const assetAdj = adjMap?.[zone] ?? 0;
    return Math.round(Math.min(98, Math.max(5, 50 + basisPct * 100 - volPenalty + assetAdj)) * 100) / 100;
  }
  if (market === "PJM") {
    // Real DA basis vs PJM weighted average + volatility penalty
    const basisPct = (signalStats.avg_da - pjmBusAvg) / pjmBusAvg;
    const volPenalty = ((signalStats.avg_vol - pjmSysVol) / pjmSysVol) * 6;
    const assetAdj = PJM_CONG_ADJ[assetType] ?? 0;
    return Math.round(Math.min(98, Math.max(15, 55 + basisPct * 120 - volPenalty + assetAdj)) * 100) / 100;
  }
  return 62;
}

function basisRiskScore(
  signalStats: NodeStats, market: string,
  ercotSysVol: number,
  pjmSysVol: number,
): number {
  if (market === "ERCOT") {
    const vol = signalStats.avg_vol;
    const raw = 70 - ((vol - ercotSysVol) / ercotSysVol) * 22;
    return Math.round(Math.min(90, Math.max(20, raw)) * 100) / 100;
  }
  if (market === "CAISO") {
    const caRefVol = 13.6;
    const raw = 62 - ((signalStats.avg_vol - caRefVol) / caRefVol) * 20;
    return Math.round(Math.min(85, Math.max(15, raw)) * 100) / 100;
  }
  if (market === "PJM") {
    // PJM hub/zone volatility from pjm_node_stats (std dev of monthly DA)
    const raw = 65 - ((signalStats.avg_vol - pjmSysVol) / pjmSysVol) * 18;
    return Math.round(Math.min(88, Math.max(30, raw)) * 100) / 100;
  }
  return 58;
}

function capturePriceScore(
  signalStats: NodeStats, assetType: string, market: string,
  ercotBusAvg: number,
  pjmBusAvg: number,
): number {
  let da: number;
  let sysAvg: number;
  if (market === "ERCOT") {
    da = signalStats.avg_da;
    sysAvg = ercotBusAvg;
  } else if (market === "CAISO") {
    da = signalStats.avg_da;
    sysAvg = 33.25;
  } else {
    // PJM: real DA from pjm_node_stats; basis vs real PJM weighted avg
    da = signalStats.avg_da;
    sysAvg = pjmBusAvg;
  }
  const ratio = CAPTURE_RATIO[assetType] ?? 0.90;
  const captureDA = da * ratio;
  const raw = (captureDA / sysAvg) * 50;
  return Math.round(Math.min(95, Math.max(10, raw)) * 100) / 100;
}

function marketRevenueScore(
  capacityMw: number, assetType: string, market: string,
  signalStats: NodeStats, ercotBusAvg: number,
): number {
  // Use real DA from signalStats for all markets (PJM now uses real pjm_node_stats)
  const da = signalStats.avg_da;
  const cf = CF[assetType]?.[market] ?? 0.30;
  const captureRatio = CAPTURE_RATIO[assetType] ?? 0.90;
  const annualRevM = (capacityMw * cf * 8760 * da * captureRatio) / 1_000_000;
  const logRev = annualRevM > 0 ? Math.log10(annualRevM) : -2;
  const raw = 20 + ((logRev + 2) / 4.3) * 75;
  return Math.round(Math.min(95, Math.max(15, raw)) * 100) / 100;
}

function interconnectRiskScore(
  queueZone: string, market: string,
  ercotQueueMap: Map<string, number>, caisoQueueMap: Map<string, number>, pjmQueueMap: Map<string, number>,
  ercotMaxMw: number, caisoMaxMw: number, pjmMaxMw: number,
): number {
  if (market === "ERCOT") {
    const queueMw = ercotQueueMap.get(queueZone) ?? 0;
    const raw = 85 - (queueMw / ercotMaxMw) * 60;
    return Math.round(Math.min(85, Math.max(22, raw)) * 100) / 100;
  }
  if (market === "CAISO") {
    const queueMw = caisoQueueMap.get(queueZone) ?? 0;
    const raw = 85 - (queueMw / caisoMaxMw) * 60;
    return Math.round(Math.min(85, Math.max(22, raw)) * 100) / 100;
  }
  if (market === "PJM") {
    // Real queue MW from queue_projects by zone; same formula as ERCOT/CAISO
    const queueMw = pjmQueueMap.get(queueZone) ?? 0;
    const raw = 85 - (queueMw / pjmMaxMw) * 60;
    return Math.round(Math.min(85, Math.max(22, raw)) * 100) / 100;
  }
  return 48;
}

function recScore(assetType: string, market: string, capacityMw: number): number {
  if (!REC_ELIGIBLE.has(assetType) || capacityMw <= 0) return 12;
  const cf = CF[assetType]?.[market] ?? 0.30;
  const recPrice = REC_PRICES[assetType]?.[market] ?? 2.00;
  const annualValueK = (capacityMw * cf * 8760 * recPrice) / 1000;
  const logVal = annualValueK > 0 ? Math.log10(annualValueK) : -2;
  const raw = 18 + ((logVal + 3) / 7) * 77;
  return Math.round(Math.min(95, Math.max(10, raw)) * 100) / 100;
}

function capacityScore(capacityMw: number): number {
  const logMw = Math.log10(Math.max(1, capacityMw));
  const raw = 25 + (logMw / 3.3) * 68;
  return Math.round(Math.min(93, Math.max(10, raw)) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(" Nodal scoring v5 — Real PJM Signals + Resource Node LMPs");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── Step 0a: Load hub/zone CDR stats (fallback reference) ─────────────────
  console.log("📡 Loading hub/zone CDR stats (fallback + queue reference)...");

  const hubZoneRaw = await db.execute<{
    node: string; avg_da: string; avg_rt: string; avg_vol: string; avg_neg_pct: string;
  }>(sql`
    SELECT node,
      AVG(avg_da_price)::float      AS avg_da,
      AVG(avg_rt_price)::float      AS avg_rt,
      AVG(volatility)::float        AS avg_vol,
      AVG(neg_price_percent)::float AS avg_neg_pct
    FROM ercot_node_stats
    WHERE node_type IN ('hub', 'load_zone')
    GROUP BY node
  `);

  const hubZoneNodes = new Map<string, NodeStats>(
    hubZoneRaw.rows.map(r => [r.node, {
      avg_da: Number(r.avg_da), avg_rt: Number(r.avg_rt),
      avg_vol: Number(r.avg_vol), avg_neg_pct: Number(r.avg_neg_pct),
      source: "hub_zone" as const,
    }])
  );

  // ── Step 0b: Load per-zone resource node averages ─────────────────────────
  // Join ercot_node_stats (resource nodes) with ercot_node_locations (zone label)
  // to compute zone-weighted injection-point prices. These reflect actual LMPs
  // at generator nodes — more accurate than the CDR zone settlement point.
  console.log("📡 Loading per-zone resource node averages (real injection-point LMPs)...");

  const ercotZoneResourceRaw = await db.execute<{
    zone: string; node_count: string;
    avg_da: string; avg_rt: string; avg_vol: string; avg_neg_pct: string;
  }>(sql`
    SELECT
      enl.load_zone                           AS zone,
      COUNT(DISTINCT ens.node)::text          AS node_count,
      AVG(ens.avg_da_price)::float            AS avg_da,
      AVG(ens.avg_rt_price)::float            AS avg_rt,
      AVG(ens.volatility)::float              AS avg_vol,
      AVG(ens.neg_price_percent)::float       AS avg_neg_pct
    FROM ercot_node_stats ens
    JOIN ercot_node_locations enl ON ens.node = enl.node_name
    WHERE ens.node_type = 'resource_node'
      AND ens.avg_da_price IS NOT NULL
      AND enl.load_zone IS NOT NULL
    GROUP BY enl.load_zone
    HAVING COUNT(DISTINCT ens.node) >= 5
  `);

  const ercotZoneResource = new Map<string, NodeStats>(
    ercotZoneResourceRaw.rows.map(r => [r.zone, {
      avg_da: Number(r.avg_da), avg_rt: Number(r.avg_rt),
      avg_vol: Number(r.avg_vol), avg_neg_pct: Number(r.avg_neg_pct),
      source: "resource" as const,
    }])
  );

  // ── Step 0c: Load per-zone CAISO resource node averages ───────────────────
  const caisoZoneResourceRaw = await db.execute<{
    zone: string; node_count: string;
    avg_da: string; avg_vol: string; avg_neg_pct: string;
  }>(sql`
    SELECT
      cnl.caiso_zone                          AS zone,
      COUNT(DISTINCT cns.node)::text          AS node_count,
      AVG(cns.avg_da_price)::float            AS avg_da,
      AVG(cns.volatility)::float              AS avg_vol,
      AVG(cns.neg_price_percent)::float       AS avg_neg_pct
    FROM caiso_node_stats cns
    JOIN caiso_node_locations cnl ON cns.node = cnl.node_name
    WHERE cns.avg_da_price IS NOT NULL
      AND cnl.caiso_zone IS NOT NULL
    GROUP BY cnl.caiso_zone
    HAVING COUNT(DISTINCT cns.node) >= 3
  `);

  const caisoZoneResource = new Map<string, NodeStats>(
    caisoZoneResourceRaw.rows.map(r => [r.zone, {
      avg_da: Number(r.avg_da), avg_rt: 0,
      avg_vol: Number(r.avg_vol), avg_neg_pct: Number(r.avg_neg_pct),
      source: "resource" as const,
    }])
  );

  // Fallback CAISO zone stats from caiso_node_stats (zone-level)
  const caisoZoneRaw = await db.execute<{
    node: string; avg_da: string; avg_vol: string; avg_neg_pct: string;
  }>(sql`
    SELECT node,
      AVG(avg_da_price)::float      AS avg_da,
      AVG(volatility)::float        AS avg_vol,
      AVG(neg_price_percent)::float AS avg_neg_pct
    FROM caiso_node_stats
    GROUP BY node
  `);
  const caisoZoneFallback = new Map<string, NodeStats>(
    caisoZoneRaw.rows.map(r => [r.node, {
      avg_da: Number(r.avg_da), avg_rt: 0,
      avg_vol: Number(r.avg_vol), avg_neg_pct: Number(r.avg_neg_pct),
      source: "hub_zone" as const,
    }])
  );

  // ── Step 0d: Queue depth maps ─────────────────────────────────────────────
  const ercotQueueRaw = await db.execute<{ zone: string; total_mw: string }>(sql`
    SELECT interconnection_node AS zone, SUM(capacity_mw::float) AS total_mw
    FROM queue_projects
    WHERE market = 'ERCOT' AND interconnection_node IS NOT NULL AND capacity_mw IS NOT NULL
    GROUP BY interconnection_node
  `);
  const caisoQueueRaw = await db.execute<{ zone: string; total_mw: string }>(sql`
    SELECT interconnection_node AS zone, SUM(capacity_mw::float) AS total_mw
    FROM queue_projects
    WHERE market = 'CAISO' AND interconnection_node IS NOT NULL AND capacity_mw IS NOT NULL
    GROUP BY interconnection_node
  `);

  const ercotQueueMap = new Map<string, number>(ercotQueueRaw.rows.map(r => [r.zone, Number(r.total_mw)]));
  const caisoQueueMap = new Map<string, number>(caisoQueueRaw.rows.map(r => [r.zone, Number(r.total_mw)]));
  const ercotMaxMw = Math.max(...ercotQueueMap.values(), 1);
  const caisoMaxMw = Math.max(...caisoQueueMap.values(), 1);

  // ── Step 0e: PJM hub/zone stats from pjm_node_stats ─────────────────────
  console.log("📡 Loading PJM hub/zone stats from pjm_node_stats (real DA/vol/neg-pct)...");
  const _PJM_HUB_ZONES = ["Western Hub", "Eastern Hub", "NI Hub", "AEP-Dayton Hub",
    "PSEG", "PPL", "DOM", "BGE", "PECO", "PENELEC", "ATSI", "COMED"];
  void _PJM_HUB_ZONES; // used in SQL literal below

  const pjmHubRaw = await db.execute<{
    node: string; avg_da: string; avg_rt: string; avg_vol: string; avg_neg_pct: string;
  }>(sql`
    SELECT node,
      AVG(avg_da_price)::float      AS avg_da,
      AVG(avg_rt_price)::float      AS avg_rt,
      AVG(volatility)::float        AS avg_vol,
      AVG(neg_price_percent)::float AS avg_neg_pct
    FROM pjm_node_stats
    WHERE node IN (
      'Western Hub', 'Eastern Hub', 'NI Hub', 'AEP-Dayton Hub',
      'PSEG', 'PPL', 'DOM', 'BGE', 'PECO', 'PENELEC', 'ATSI', 'COMED'
    )
    GROUP BY node
  `);

  const pjmHubNodes = new Map<string, NodeStats>(
    pjmHubRaw.rows.map(r => [r.node, {
      avg_da: Number(r.avg_da), avg_rt: Number(r.avg_rt),
      avg_vol: Number(r.avg_vol), avg_neg_pct: Number(r.avg_neg_pct),
      source: "hub_zone" as const,
    }])
  );

  // PJM queue depth by zone (raw queue zone names, e.g. "WESTERN HUB")
  const pjmQueueRaw = await db.execute<{ zone: string; total_mw: string }>(sql`
    SELECT interconnection_node AS zone, SUM(capacity_mw::float) AS total_mw
    FROM queue_projects
    WHERE market = 'PJM' AND interconnection_node IS NOT NULL AND capacity_mw IS NOT NULL
    GROUP BY interconnection_node
  `);
  const pjmQueueMap = new Map<string, number>(pjmQueueRaw.rows.map(r => [r.zone, Number(r.total_mw)]));
  const pjmMaxMw = Math.max(...pjmQueueMap.values(), 1);

  // PJM reference values from hub/zone data
  const pjmHubVals = [...pjmHubNodes.values()];
  // Weighted average: use major liquid hubs (Western Hub, Eastern Hub, NI Hub, AEP-Dayton Hub) + zones
  const pjmBusAvg = pjmHubVals.reduce((s, r) => s + r.avg_da, 0) / pjmHubVals.length;
  const pjmSysVol = pjmHubVals.reduce((s, r) => s + r.avg_vol, 0) / pjmHubVals.length;

  console.log(`   PJM hub/zones loaded: ${pjmHubNodes.size}  |  PJM BusAvg DA: $${pjmBusAvg.toFixed(2)}  |  sys vol: ${pjmSysVol.toFixed(2)}`);
  for (const [node, s] of [...pjmHubNodes.entries()].sort((a, b) => b[1].avg_da - a[1].avg_da)) {
    console.log(`     ${node.padEnd(18)} DA $${s.avg_da.toFixed(2)}  vol ${s.avg_vol.toFixed(2)}  neg% ${s.avg_neg_pct.toFixed(2)}%`);
  }

  // Reference values from hub/zone data
  const ercotBusAvg = hubZoneNodes.get("HB_BUSAVG")?.avg_da ?? 29.11;
  const hubVals = [...hubZoneNodes.values()];
  const ercotSysVol = hubVals.reduce((s, r) => s + r.avg_vol, 0) / hubVals.length;
  const ercotFleetAvgNegPct = hubVals.reduce((s, r) => s + r.avg_neg_pct, 0) / hubVals.length;

  console.log(`\n   Hub/zone nodes: ${hubZoneNodes.size}  |  ERCOT BusAvg DA: $${ercotBusAvg.toFixed(2)}  |  sys vol: ${ercotSysVol.toFixed(2)}`);
  console.log(`\n   ERCOT zones with resource node data (v4 real signal):`);
  for (const [zone, s] of [...ercotZoneResource.entries()].sort((a, b) => b[1].avg_da - a[1].avg_da)) {
    const hubStats = hubZoneNodes.get(zone);
    const delta = hubStats ? (s.avg_da - hubStats.avg_da).toFixed(2) : "n/a";
    console.log(`     ${zone.padEnd(14)} resource DA $${s.avg_da.toFixed(2)}  hub DA $${hubStats?.avg_da.toFixed(2) ?? "n/a"}  Δ${delta}  neg% ${s.avg_neg_pct.toFixed(2)}%`);
  }
  if (ercotZoneResource.size === 0) {
    console.log("   ⚠  No resource node zone data yet — full seed may still be running.");
    console.log("      Scoring will use hub/zone CDR stats (v3 behavior) as fallback.");
  }

  console.log(`\n   CAISO zones with resource node data:`);
  for (const [zone, s] of caisoZoneResource.entries()) {
    console.log(`     ${zone.padEnd(6)} resource DA $${s.avg_da.toFixed(2)}  neg% ${s.avg_neg_pct.toFixed(2)}%`);
  }

  // ── Helper: resolve signal stats for a zone ───────────────────────────────
  function ercotSignalStats(zone: string): NodeStats {
    return ercotZoneResource.get(zone) ?? hubZoneNodes.get(zone) ?? {
      avg_da: ercotBusAvg, avg_rt: ercotBusAvg, avg_vol: ercotSysVol,
      avg_neg_pct: ercotFleetAvgNegPct, source: "hub_zone",
    };
  }

  function caisoSignalStats(zone: string): NodeStats {
    return caisoZoneResource.get(zone) ?? caisoZoneFallback.get(zone) ?? caisoZoneFallback.get("SP15") ?? {
      avg_da: 33.25, avg_rt: 0, avg_vol: 13.6, avg_neg_pct: 2.0, source: "hub_zone",
    };
  }

  function pjmSignalStats(queueZone: string): NodeStats {
    // Map queue zone name (e.g. "WESTERN HUB") → pjm_node_stats node name ("Western Hub")
    const nodeName = PJM_QUEUE_ZONE_TO_NODE[queueZone] ?? "Western Hub";
    return pjmHubNodes.get(nodeName) ?? {
      avg_da: pjmBusAvg, avg_rt: pjmBusAvg, avg_vol: pjmSysVol,
      avg_neg_pct: 0.35, source: "hub_zone",
    };
  }

  // ── Step 1: ERCOT Haversine nearest-neighbour (queue zone assignment) ──────
  console.log("\n📍 ERCOT: Haversine nearest-neighbour (queue zone assignment)...");

  const ercotCandidates = await db.execute<{
    id: number; asset_type: string; capacity_mw: string; latitude: string; longitude: string;
  }>(sql`
    SELECT id, asset_type, capacity_mw::text, latitude::float::text, longitude::float::text
    FROM candidates WHERE market = 'ERCOT' ORDER BY id
  `);

  const ercotMatches = await db.execute<{
    candidate_id: number; queue_node: string; distance_km: string;
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

  const ercotQueueZoneMap = new Map<number, string>();
  let ercotHit = 0, ercotFall = 0;
  for (const m of ercotMatches.rows) {
    if (Number(m.distance_km) <= RADIUS_KM) {
      ercotQueueZoneMap.set(m.candidate_id, m.queue_node);
      ercotHit++;
    }
  }
  for (const c of ercotCandidates.rows) {
    if (!ercotQueueZoneMap.has(c.id)) {
      ercotQueueZoneMap.set(c.id, ercotGeoFallback(Number(c.latitude), Number(c.longitude)));
      ercotFall++;
    }
  }
  console.log(`   Queue match (≤${RADIUS_KM}km): ${ercotHit}  |  geo fallback: ${ercotFall}`);

  // ── Step 2: CAISO Haversine ────────────────────────────────────────────────
  console.log("\n📍 CAISO: Haversine nearest-neighbour (queue zone assignment)...");

  const caisoCandidates = await db.execute<{
    id: number; asset_type: string; capacity_mw: string; latitude: string; longitude: string;
  }>(sql`
    SELECT id, asset_type, capacity_mw::text, latitude::float::text, longitude::float::text
    FROM candidates WHERE market = 'CAISO' ORDER BY id
  `);

  const caisoMatches = await db.execute<{
    candidate_id: number; queue_node: string; distance_km: string;
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

  const caisoQueueZoneMap = new Map<number, string>();
  let caisoHit = 0, caisoFall = 0;
  for (const m of caisoMatches.rows) {
    if (Number(m.distance_km) <= RADIUS_KM) {
      caisoQueueZoneMap.set(m.candidate_id, m.queue_node);
      caisoHit++;
    }
  }
  for (const c of caisoCandidates.rows) {
    if (!caisoQueueZoneMap.has(c.id)) {
      const lat = Number(c.latitude), lon = Number(c.longitude);
      const zone = lat >= 37.5 ? "NP15" : (lat >= 35.0 && lon <= -118.5) ? "ZP26" : "SP15";
      caisoQueueZoneMap.set(c.id, zone);
      caisoFall++;
    }
  }
  console.log(`   Queue match (≤${RADIUS_KM}km): ${caisoHit}  |  geo fallback: ${caisoFall}`);

  // ── Step 3: PJM Haversine nearest-neighbour (queue zone assignment) ────────
  console.log("\n📍 PJM: Haversine nearest-neighbour (queue zone assignment)...");

  const pjmCandidates = await db.execute<{
    id: number; asset_type: string; capacity_mw: string; latitude: string; longitude: string;
  }>(sql`
    SELECT id, asset_type, capacity_mw::text, latitude::float::text, longitude::float::text
    FROM candidates WHERE market = 'PJM' ORDER BY id
  `);

  const pjmMatches = await db.execute<{
    candidate_id: number; queue_node: string; distance_km: string;
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
      ON q.market = 'PJM'
      AND q.latitude IS NOT NULL
      AND q.interconnection_node IS NOT NULL
    WHERE c.market = 'PJM'
    ORDER BY c.id, distance_km
  `);

  const pjmQueueZoneMap = new Map<number, string>();
  let pjmHit = 0, pjmFall = 0;
  for (const m of pjmMatches.rows) {
    if (Number(m.distance_km) <= RADIUS_KM) {
      pjmQueueZoneMap.set(m.candidate_id, m.queue_node);
      pjmHit++;
    }
  }
  // Geo fallback: PJM east → EASTERN HUB; mid-atlantic → PSEG/BGE; midwest → NI HUB
  for (const c of pjmCandidates.rows) {
    if (!pjmQueueZoneMap.has(c.id)) {
      const lat = Number(c.latitude), lon = Number(c.longitude);
      let zone: string;
      if (lon >= -75.0) zone = "EASTERN HUB";  // NJ/NY coastal
      else if (lon >= -77.5 && lat >= 38.0) zone = "BGE"; // DC/MD
      else if (lon >= -79.5 && lat >= 39.0) zone = "PPL"; // PA east
      else if (lat >= 41.0) zone = "NI HUB";  // Illinois/Indiana
      else if (lon <= -82.0) zone = "AEP-DAYTON HUB"; // Ohio/WV
      else zone = "WESTERN HUB";
      pjmQueueZoneMap.set(c.id, zone);
      pjmFall++;
    }
  }
  console.log(`   Queue match (≤${RADIUS_KM}km): ${pjmHit}  |  geo fallback: ${pjmFall}`);

  // ── Step 4: Compute all 8 scores per candidate ────────────────────────────
  console.log("\n📊 Computing all 8 dimensions per candidate (v5 real PJM signals)...");

  interface Update {
    id: number; node: string;
    curtailment: string; congestion: string; basis: string; capturePrice: string;
    mktRevenue: string; interconnectRisk: string; recScore: string; capScore: string;
  }

  const updates: Update[] = [];

  const computeAll = (
    id: number, queueZone: string, assetType: string, market: string, capacityMw: number
  ): Update => {
    let signal: NodeStats;
    if (market === "ERCOT") {
      signal = ercotSignalStats(queueZone);
    } else if (market === "CAISO") {
      signal = caisoSignalStats(queueZone);
    } else {
      // PJM: real hub/zone stats from pjm_node_stats via pjmSignalStats()
      signal = pjmSignalStats(queueZone);
    }

    return {
      id, node: queueZone,
      curtailment:      curtailmentScore(signal, assetType, market, ercotFleetAvgNegPct).toFixed(2),
      congestion:       congestionScore(signal, assetType, market, queueZone, ercotBusAvg, ercotSysVol, pjmBusAvg, pjmSysVol).toFixed(2),
      basis:            basisRiskScore(signal, market, ercotSysVol, pjmSysVol).toFixed(2),
      capturePrice:     capturePriceScore(signal, assetType, market, ercotBusAvg, pjmBusAvg).toFixed(2),
      mktRevenue:       marketRevenueScore(capacityMw, assetType, market, signal, ercotBusAvg).toFixed(2),
      interconnectRisk: interconnectRiskScore(queueZone, market, ercotQueueMap, caisoQueueMap, pjmQueueMap, ercotMaxMw, caisoMaxMw, pjmMaxMw).toFixed(2),
      recScore:         recScore(assetType, market, capacityMw).toFixed(2),
      capScore:         capacityScore(capacityMw).toFixed(2),
    };
  };

  for (const c of ercotCandidates.rows)
    updates.push(computeAll(c.id, ercotQueueZoneMap.get(c.id)!, c.asset_type, "ERCOT", Number(c.capacity_mw)));
  for (const c of caisoCandidates.rows)
    updates.push(computeAll(c.id, caisoQueueZoneMap.get(c.id)!, c.asset_type, "CAISO", Number(c.capacity_mw)));
  for (const c of pjmCandidates.rows)
    updates.push(computeAll(c.id, pjmQueueZoneMap.get(c.id)!, c.asset_type, "PJM", Number(c.capacity_mw)));

  // Score preview by zone
  console.log("\n   ERCOT score preview by zone (signal source):");
  const ercotByZone: Record<string, { curt: number[]; cong: number[]; source: string }> = {};
  for (const u of updates.filter(u => ercotQueueZoneMap.has(u.id))) {
    const d = (ercotByZone[u.node] ??= { curt: [], cong: [], source: ercotSignalStats(u.node).source });
    d.curt.push(Number(u.curtailment));
    d.cong.push(Number(u.congestion));
  }
  const avg = (arr: number[]) => arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : "—";
  for (const [zone, d] of Object.entries(ercotByZone).sort((a, b) => b[1].cong.length - a[1].cong.length)) {
    const s = ercotSignalStats(zone);
    console.log(`     ${zone.padEnd(14)} [${d.source.padEnd(9)}] curt ${avg(d.curt)}  cong ${avg(d.cong)}  DA $${s.avg_da.toFixed(2)}  neg% ${s.avg_neg_pct.toFixed(1)}%  n=${d.curt.length}`);
  }

  // PJM score preview by zone
  console.log("\n   PJM score preview by zone (real pjm_node_stats signals):");
  const pjmByZone: Record<string, { curt: number[]; cong: number[]; capturePrice: number[] }> = {};
  for (const u of updates.filter(u => pjmQueueZoneMap.has(u.id))) {
    const d = (pjmByZone[u.node] ??= { curt: [], cong: [], capturePrice: [] });
    d.curt.push(Number(u.curtailment));
    d.cong.push(Number(u.congestion));
    d.capturePrice.push(Number(u.capturePrice));
  }
  for (const [zone, d] of Object.entries(pjmByZone).sort((a, b) => b[1].cong.length - a[1].cong.length)) {
    const s = pjmSignalStats(zone);
    console.log(`     ${zone.padEnd(18)} curt ${avg(d.curt)}  cong ${avg(d.cong)}  cap$ ${avg(d.capturePrice)}  DA $${s.avg_da.toFixed(2)}  neg% ${s.avg_neg_pct.toFixed(2)}%  n=${d.curt.length}`);
  }

  // ── Step 5: Batch-update DB ────────────────────────────────────────────────
  console.log("\n💾 Writing all scores to DB...");
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await Promise.all(chunk.map(u =>
      db.execute(sql`
        UPDATE candidates
        SET interconnection_node    = ${u.node},
            pricing_hub_node        = ${u.node},
            curtailment_score       = ${u.curtailment}::numeric,
            interconnection_score   = ${u.congestion}::numeric,
            location_score          = ${u.basis}::numeric,
            price_score             = ${u.capturePrice}::numeric,
            financial_score         = ${u.mktRevenue}::numeric,
            development_risk_score  = ${u.interconnectRisk}::numeric,
            environmental_score     = ${u.recScore}::numeric,
            demand_proximity_score  = ${u.capScore}::numeric,
            updated_at              = NOW()
        WHERE id = ${u.id}
      `)
    ));
    written += chunk.length;
    process.stdout.write(`\r   ${written}/${updates.length} updated...`);
  }

  // ── Step 6: Recompute overall_score ───────────────────────────────────────
  console.log("\n🔄 Recomputing overall_score for all markets...");
  await db.execute(sql`
    UPDATE candidates
    SET overall_score = ROUND((
      COALESCE(price_score::numeric,            50) * 0.18 +
      COALESCE(curtailment_score::numeric,      50) * 0.18 +
      COALESCE(interconnection_score::numeric,  50) * 0.15 +
      COALESCE(location_score::numeric,         50) * 0.12 +
      COALESCE(financial_score::numeric,        50) * 0.12 +
      COALESCE(development_risk_score::numeric, 50) * 0.10 +
      COALESCE(demand_proximity_score::numeric, 50) * 0.08 +
      COALESCE(environmental_score::numeric,    50) * 0.05 +
      COALESCE(grid_stability_score::numeric,   50) * 0.02
    ), 2),
    updated_at = NOW()
  `);

  // ── Step 7: Summary stats ──────────────────────────────────────────────────
  const summary = await db.execute<{ market: string; avg_score: string; min_score: string; max_score: string; cnt: string }>(sql`
    SELECT market,
      ROUND(AVG(overall_score::float)::numeric, 1) AS avg_score,
      ROUND(MIN(overall_score::float)::numeric, 1) AS min_score,
      ROUND(MAX(overall_score::float)::numeric, 1) AS max_score,
      COUNT(*)::text AS cnt
    FROM candidates GROUP BY market ORDER BY market
  `);

  console.log("\n\n✅ Done. Score summary:");
  for (const r of summary.rows)
    console.log(`   ${r.market.padEnd(7)}  n=${r.cnt.padStart(5)}  avg=${r.avg_score}  range [${r.min_score} – ${r.max_score}]`);

  const resourceZones = ercotZoneResource.size;
  console.log(`\n   Signal source: ${resourceZones > 0 ? `${resourceZones} ERCOT zones used resource node LMPs` : "hub/zone CDR fallback (seed pending)"}`);
  console.log(`   PJM: ${pjmHubNodes.size} hub/zone nodes from pjm_node_stats (DA $${pjmBusAvg.toFixed(2)} avg, range $${Math.min(...pjmHubVals.map(v=>v.avg_da)).toFixed(2)}–$${Math.max(...pjmHubVals.map(v=>v.avg_da)).toFixed(2)})`);
  console.log("\n   Dimension mapping:");
  console.log("   price_score            → Capture Price   (DA × tech timing ratio)");
  console.log("   curtailment_score      → Curtailment      (resource node neg_price_percent)");
  console.log("   interconnection_score  → Congestion       (resource node DA basis + vol)");
  console.log("   location_score         → Basis Risk       (resource node volatility)");
  console.log("   financial_score        → Mkt Revenue      (annual energy revenue, log-scaled)");
  console.log("   development_risk_score → Interconnect     (queue MW backlog by zone)");
  console.log("   environmental_score    → RECs / Yr        (annual REC value, log-scaled)");
  console.log("   demand_proximity_score → Capacity         (log-scaled MW)");

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
