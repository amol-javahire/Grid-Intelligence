/**
 * ##########################  DEPRECATED — DO NOT RUN  ######################
 *
 * SUPERSEDED 2026-08-04 by infra/2026-08-04-build-caiso-node-stats.sql, which
 * aggregates caiso_node_stats from REAL CAISO OASIS prices in
 * caiso_nodal_da_rt_hourly — 2,032 resource nodes, Jan 2025 onward.
 *
 * This file writes SYNTHETIC data to that same table: hardcoded per-zone base
 * prices with Math.random() noise applied (see ZONE_BASE below and the noise
 * terms around lines 228-244). Nothing in the table name, the schema, or the
 * original header ("Generates real-pattern settlement points") indicated that.
 * The header's phrase "real-pattern" meant "shaped to look plausible", not
 * "derived from real data" — which is exactly how synthetic rows have twice
 * been mistaken for real ones in this project.
 *
 * RUNNING THIS DESTROYS THE REAL AGGREGATION. It would replace measured basis
 * and negative-price percentages — the spread that makes CAISO candidates
 * rankable at all — with numbers generated from a random number generator.
 *
 * Before this was fixed, caiso_node_stats held 3 nodes and all 2,311 CAISO
 * candidates were scored off hub averages. Do not undo that.
 * ###########################################################################
 *
 * Seed CAISO resource nodes into caiso_node_stats
 * Generates real-pattern settlement points with 2022-2025 monthly data
 */
import { db, caisoNodeStatsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Zone base prices ($/MWh DA) ───────────────────────────────────────────────
// SP15 (SoCal) highest, ZP26 (Central) mid, NP15 (NorCal) variable
const ZONE_BASE: Record<string, number> = {
  np15_wind:      44.0,
  np15_solar:     42.0,
  np15_geo:       48.0,
  np15_nuclear:   51.0,
  np15_gas:       52.0,
  sp15_wind:      53.0,
  sp15_solar:     49.0,
  sp15_gas:       61.0,
  sp15_storage:   54.0,
  zp26_wind:      47.0,
  zp26_solar:     45.0,
  zp26_gas:       55.0,
};

// RT basis = RT - DA (negative = curtailment / oversupply)
const RT_BASIS: Record<string, number> = {
  np15_wind:     -6.5,
  np15_solar:   -10.0,
  np15_geo:       1.5,
  np15_nuclear:   3.0,
  np15_gas:       4.5,
  sp15_wind:     -5.5,
  sp15_solar:   -13.0,
  sp15_gas:       5.0,
  sp15_storage:  -2.0,
  zp26_wind:     -7.0,
  zp26_solar:   -11.5,
  zp26_gas:       3.5,
};

// Negative price % (solar/wind have more)
const NEG_PCT: Record<string, number> = {
  np15_wind:     3.5,
  np15_solar:   14.0,
  np15_geo:      0.5,
  np15_nuclear:  0.3,
  np15_gas:      0.8,
  sp15_wind:     2.5,
  sp15_solar:   18.0,
  sp15_gas:      0.5,
  sp15_storage:  2.0,
  zp26_wind:     4.5,
  zp26_solar:   16.0,
  zp26_gas:      0.8,
};

// Seasonal multiplier: CA has high prices in summer/fall (heat + AC) and lower in spring
const SEASON =      [0.85, 0.87, 0.92, 0.90, 0.95, 1.12, 1.30, 1.35, 1.25, 1.10, 0.88, 0.82];
const SOLAR_SEASON = [0.92, 0.95, 1.05, 1.08, 1.10, 1.04, 1.02, 1.00, 0.98, 0.95, 0.88, 0.84];
const WIND_SEASON =  [1.10, 1.05, 1.00, 0.98, 0.95, 0.90, 0.88, 0.88, 0.92, 0.97, 1.05, 1.12];

// Year-over-year price drift
const YEAR_MULT: Record<number, number> = { 2022: 1.20, 2023: 0.95, 2024: 1.02, 2025: 1.05 };

type NodeDef = [prefix: string, units: number, region: string];

// ── NP15 (North California) ───────────────────────────────────────────────────
const NP15_WIND: NodeDef[] = [
  ["ALTAMONT_WIND",     6, "np15_wind"],
  ["SOLANO_WIND",       8, "np15_wind"],
  ["SHASTA_WIND",       4, "np15_wind"],
  ["MONTEZUMA_WIND",    5, "np15_wind"],
  ["HIGH_WINDS",        6, "np15_wind"],
  ["VAQUERO_WIND",      4, "np15_wind"],
  ["GOLDEN_HILLS_WIND", 5, "np15_wind"],
  ["PACHECO_WIND",      4, "np15_wind"],
  ["BUENA_VISTA_WIND",  3, "np15_wind"],
  ["DIABLO_WIND",       4, "np15_wind"],
];

const NP15_SOLAR: NodeDef[] = [
  ["FRESNO_SOLAR",         4, "np15_solar"],
  ["SACRAMENTO_SOLAR",     5, "np15_solar"],
  ["SAN_JOAQUIN_SOLAR",    6, "np15_solar"],
  ["LODI_SOLAR",           3, "np15_solar"],
  ["WOODLAND_SOLAR",       4, "np15_solar"],
  ["MODESTO_SOLAR",        5, "np15_solar"],
  ["TURLOCK_SOLAR",        4, "np15_solar"],
  ["MERCED_SOLAR",         4, "np15_solar"],
  ["HANFORD_SOLAR",        5, "np15_solar"],
  ["VISALIA_SOLAR",        4, "np15_solar"],
  ["CHICO_SOLAR",          3, "np15_solar"],
  ["REDDING_SOLAR",        3, "np15_solar"],
  ["STOCKTON_SOLAR",       4, "np15_solar"],
  ["YUBA_SOLAR",           3, "np15_solar"],
];

const NP15_GEO: NodeDef[] = [
  ["GEYSERS_GEO",         6, "np15_geo"],
  ["CALPINE_GEO",         4, "np15_geo"],
  ["SONOMA_GEO",          3, "np15_geo"],
];

const NP15_NUCLEAR: NodeDef[] = [
  ["DIABLO_CANYON_NUC",   2, "np15_nuclear"],
];

const NP15_GAS: NodeDef[] = [
  ["GEOTHERMAL_BAY",      3, "np15_gas"],
  ["PITTSBURG_GAS",       4, "np15_gas"],
  ["CONTRA_COSTA_GAS",    3, "np15_gas"],
  ["RICHMOND_GAS",        3, "np15_gas"],
  ["HAYWARD_GAS",         2, "np15_gas"],
  ["ALAMEDA_GAS",         3, "np15_gas"],
  ["HELMS_PUMP",          2, "np15_geo"],
];

// ── SP15 (South California) ───────────────────────────────────────────────────
const SP15_WIND: NodeDef[] = [
  ["TEHACHAPI_WIND",      8, "sp15_wind"],
  ["SAN_GORGONIO_WIND",   6, "sp15_wind"],
  ["PALM_SPRINGS_WIND",   5, "sp15_wind"],
  ["CABAZON_WIND",        4, "sp15_wind"],
  ["WHITEWATER_WIND",     5, "sp15_wind"],
  ["BANNING_WIND",        4, "sp15_wind"],
  ["COACHELLA_WIND",      3, "sp15_wind"],
  ["MOJAVE_WIND",         6, "sp15_wind"],
  ["ANTELOPE_WIND",       5, "sp15_wind"],
  ["ALTA_WIND",           8, "sp15_wind"],
  ["PINE_TREE_WIND",      4, "sp15_wind"],
  ["OAK_CREEK_WIND",      4, "sp15_wind"],
];

const SP15_SOLAR: NodeDef[] = [
  ["DESERT_SUNLIGHT",     3, "sp15_solar"],
  ["IVANPAH_SOLAR",       3, "sp15_solar"],
  ["GENESIS_SOLAR",       2, "sp15_solar"],
  ["MOJAVE_SOLAR",        3, "sp15_solar"],
  ["IMPERIAL_SOLAR",      5, "sp15_solar"],
  ["BLYTHE_SOLAR",        4, "sp15_solar"],
  ["COPPER_MOUNTAIN",     4, "sp15_solar"],
  ["SILVER_STATE_SOUTH",  3, "sp15_solar"],
  ["ANTELOPE_SOLAR",      5, "sp15_solar"],
  ["CALIFORNIA_VALLEY",   3, "sp15_solar"],
  ["TOPAZ_SOLAR",         3, "sp15_solar"],
  ["SUNBIRD_SOLAR",       4, "sp15_solar"],
  ["PALEN_SOLAR",         3, "sp15_solar"],
  ["BORREGO_SOLAR",       4, "sp15_solar"],
  ["OCOTILLO_SOLAR",      4, "sp15_solar"],
  ["COACHELLA_SOLAR",     3, "sp15_solar"],
  ["INDIO_SOLAR",         4, "sp15_solar"],
];

const SP15_GAS: NodeDef[] = [
  ["ALISO_CANYON_GAS",    4, "sp15_gas"],
  ["ENCINA_GAS",          3, "sp15_gas"],
  ["ORMOND_BEACH_GAS",    3, "sp15_gas"],
  ["ETIWANDA_GAS",        4, "sp15_gas"],
  ["LONG_BEACH_GAS",      3, "sp15_gas"],
  ["ALAMITOS_GAS",        3, "sp15_gas"],
  ["REDONDO_GAS",         3, "sp15_gas"],
  ["HUNTINGTON_GAS",      3, "sp15_gas"],
  ["EL_SEGUNDO_GAS",      4, "sp15_gas"],
  ["SOUTH_BAY_GAS",       3, "sp15_gas"],
  ["MANDALAY_GAS",        3, "sp15_gas"],
  ["COLTON_GAS",          2, "sp15_gas"],
];

const SP15_STORAGE: NodeDef[] = [
  ["MIRA_LOMA_BESS",      3, "sp15_storage"],
  ["GATEWAY_BESS",        3, "sp15_storage"],
  ["VISTRA_MOSS_BESS",    2, "sp15_storage"],
  ["MOSS_LANDING_BESS",   2, "sp15_storage"],
  ["ELLWOOD_BESS",        2, "sp15_storage"],
];

// ── ZP26 (Central California) ─────────────────────────────────────────────────
const ZP26_WIND: NodeDef[] = [
  ["KERN_WIND",           6, "zp26_wind"],
  ["LOMPOC_WIND",         4, "zp26_wind"],
  ["MANZANA_WIND",        5, "zp26_wind"],
  ["WINDRIDGE_WIND",      4, "zp26_wind"],
  ["PAINTED_HILLS_WIND",  5, "zp26_wind"],
  ["TEMBLOR_WIND",        4, "zp26_wind"],
  ["TAFT_WIND",           3, "zp26_wind"],
];

const ZP26_SOLAR: NodeDef[] = [
  ["KERN_SOLAR",          5, "zp26_solar"],
  ["ATWATER_SOLAR",       4, "zp26_solar"],
  ["TULARE_SOLAR",        4, "zp26_solar"],
  ["LOST_HILLS_SOLAR",    3, "zp26_solar"],
  ["BUTTONWILLOW_SOLAR",  3, "zp26_solar"],
  ["DELANO_SOLAR",        4, "zp26_solar"],
  ["WASCO_SOLAR",         4, "zp26_solar"],
  ["SHAFTER_SOLAR",       3, "zp26_solar"],
  ["ARVIN_SOLAR",         4, "zp26_solar"],
  ["BAKERSFIELD_SOLAR",   5, "zp26_solar"],
  ["MARICOPA_SOLAR",      3, "zp26_solar"],
];

const ZP26_GAS: NodeDef[] = [
  ["MIDWAY_GAS",          3, "zp26_gas"],
  ["KERN_RIVER_GAS",      3, "zp26_gas"],
  ["CALPEAK_GAS",         2, "zp26_gas"],
  ["BLACKWELL_GAS",       2, "zp26_gas"],
];

// ── Generation ────────────────────────────────────────────────────────────────
function seasonMult(region: string, month: number): number {
  const m = month - 1;
  if (region.includes("solar")) return SOLAR_SEASON[m];
  if (region.includes("wind"))  return WIND_SEASON[m];
  return SEASON[m];
}

function generateRows(
  nodeName: string,
  region: string,
  years: number[],
): typeof caisoNodeStatsTable.$inferInsert[] {
  const base = ZONE_BASE[region] ?? 48;
  const rtBasis = RT_BASIS[region] ?? -3;
  const negPct = NEG_PCT[region] ?? 2;
  const rows: typeof caisoNodeStatsTable.$inferInsert[] = [];
  for (const year of years) {
    const ym = YEAR_MULT[year] ?? 1.0;
    const noise = 1 + (Math.random() * 0.06 - 0.03);
    for (let month = 1; month <= 12; month++) {
      const sm = seasonMult(region, month);
      const mnoise = 1 + (Math.random() * 0.08 - 0.04);
      const da = base * sm * ym * noise * mnoise;
      const rtNoise = 1 + (Math.random() * 0.12 - 0.06);
      const rt = da + rtBasis * sm * rtNoise;
      const vol = Math.abs(rtBasis) * 0.35 * sm + Math.random() * 2;
      const negP = region.includes("solar") ? negPct * (month >= 4 && month <= 9 ? 1.4 : 0.7) : negPct;
      rows.push({
        node: nodeName,
        year,
        month,
        avgDaPrice: String(da.toFixed(4)),
        avgRtPrice: String(rt.toFixed(4)),
        volatility: String(vol.toFixed(4)),
        negPricePercent: String(Math.min(negP + Math.random() * 1.5, 35).toFixed(3)),
        onPeakAvg: String((da * 1.12).toFixed(4)),
        offPeakAvg: String((da * 0.86).toFixed(4)),
      });
    }
  }
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const ALL_DEFS: NodeDef[] = [
  ...NP15_WIND, ...NP15_SOLAR, ...NP15_GEO, ...NP15_NUCLEAR, ...NP15_GAS,
  ...SP15_WIND, ...SP15_SOLAR, ...SP15_GAS, ...SP15_STORAGE,
  ...ZP26_WIND, ...ZP26_SOLAR, ...ZP26_GAS,
];

const YEARS = [2022, 2023, 2024, 2025];

async function main() {
  // expand defs → individual unit nodes
  const nodeDefs: Array<{ name: string; region: string }> = [];
  for (const [prefix, units, region] of ALL_DEFS) {
    for (let i = 1; i <= units; i++) {
      nodeDefs.push({ name: `${prefix}_${i}`, region });
    }
  }

  console.log(`Total CAISO resource nodes to seed: ${nodeDefs.length}`);

  // check existing
  const existing = await db.execute<{ node: string }>(
    sql`SELECT DISTINCT node FROM caiso_node_stats WHERE node NOT IN ('NP15','SP15','ZP26')`
  );
  const existingSet = new Set(existing.rows.map(r => r.node));
  console.log(`Already have ${existingSet.size} resource nodes.`);

  const newNodes = nodeDefs.filter(n => !existingSet.has(n.name));
  if (newNodes.length === 0) {
    console.log("Nothing new to seed.");
    process.exit(0);
  }

  const rows: typeof caisoNodeStatsTable.$inferInsert[] = [];
  for (const { name, region } of newNodes) {
    rows.push(...generateRows(name, region, YEARS));
  }

  console.log(`Inserting ${rows.length} new rows (${newNodes.length} new nodes) in batches of 500…`);
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(caisoNodeStatsTable).values(rows.slice(i, i + BATCH));
    process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
  }
  console.log("\nDone seeding CAISO resource nodes.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
