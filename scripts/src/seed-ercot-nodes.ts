/**
 * Seed ERCOT resource nodes into ercot_nodal_stats
 * Generates 900+ real-pattern settlement points with 2023-2024 monthly data
 */
import { db, ercotNodalStatsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Node definitions ─────────────────────────────────────────────────────────
// Each entry: [namePrefix, unitCount, region, baseDaPrice, rtBasis, negPricePct]
// basis = RT - DA (negative = RT lower than DA; renewable curtailment)
// region: west_wind | west_solar | gulf | north | south | houston | far_west

const ZONE_BASE: Record<string, number> = {
  west_wind:  26.5,
  west_solar: 27.5,
  far_west:   25.0,
  panhandle:  24.0,
  north:      32.5,
  south:      30.0,
  houston:    36.0,
  gulf:       34.0,
  central:    31.5,
  nuclear:    37.0,
  storage:    32.0,
};

const RT_BASIS: Record<string, number> = {
  west_wind:  -11.5,
  west_solar: -8.0,
  far_west:   -12.5,
  panhandle:  -13.0,
  north:       -1.5,
  south:       -2.5,
  houston:      2.5,
  gulf:         1.0,
  central:     -1.0,
  nuclear:      4.0,
  storage:     -0.5,
};

const NEG_PCT: Record<string, number> = {
  west_wind:  8.5,
  west_solar: 12.0,
  far_west:   10.0,
  panhandle:  14.0,
  north:       1.5,
  south:       2.0,
  houston:     0.8,
  gulf:        1.0,
  central:     2.5,
  nuclear:     0.3,
  storage:     3.0,
};

// Seasonal multiplier per month (1=Jan … 12=Dec)
const SEASON = [0.82, 0.85, 0.92, 0.94, 1.05, 1.18, 1.30, 1.32, 1.15, 1.05, 0.90, 0.80];
const WIND_SEASON = [1.15, 1.10, 1.05, 0.98, 0.90, 0.85, 0.82, 0.80, 0.88, 0.95, 1.05, 1.12];

type NodeDef = [prefix: string, units: number, region: string];

const WIND_WEST: NodeDef[] = [
  ["CAPRICORN_WIND",    8,  "west_wind"],
  ["HORSE_HOLLOW",      6,  "west_wind"],
  ["SWEETWATER",        8,  "west_wind"],
  ["NOTREES_WIND",      6,  "far_west"],
  ["CEDAR_CREEK_WIND",  6,  "west_wind"],
  ["ROSCOE_WIND",       6,  "west_wind"],
  ["STANTON_WIND",      4,  "far_west"],
  ["SNYDER_WIND",       4,  "west_wind"],
  ["COLORADO_WIND",     6,  "west_wind"],
  ["CONCHO_WIND",       5,  "west_wind"],
  ["BRADY_WIND",        4,  "west_wind"],
  ["HIGHLAND_WIND",     8,  "west_wind"],
  ["ROCK_WIND",         4,  "west_wind"],
  ["STERLING_WIND",     5,  "west_wind"],
  ["ODESSA_WIND",       4,  "far_west"],
  ["MIDLAND_WIND",      4,  "far_west"],
  ["PECOS_WIND",        6,  "far_west"],
  ["BIG_SPRING_WIND",   4,  "west_wind"],
  ["SAN_ANGELO_WIND",   5,  "west_wind"],
  ["CALLAHAN_WIND",     4,  "west_wind"],
  ["TAYLOR_WIND",       3,  "west_wind"],
  ["MCCULLOCH_WIND",    4,  "west_wind"],
  ["MENARD_WIND",       3,  "west_wind"],
  ["CRANE_WIND",        4,  "far_west"],
  ["UPTON_WIND",        4,  "far_west"],
  ["WINKLER_WIND",      3,  "far_west"],
  ["WARD_WIND",         4,  "far_west"],
  ["REEVES_WIND",       5,  "far_west"],
  ["JEFF_DAVIS_WIND",   3,  "far_west"],
  ["PRESIDIO_WIND",     3,  "far_west"],
  ["BREWSTER_WIND",     3,  "far_west"],
  ["TERRELL_WIND",      3,  "far_west"],
];

const WIND_PANHANDLE: NodeDef[] = [
  ["GULF_WIND",         6,  "panhandle"],
  ["TURKEY_TRACK_WIND", 5,  "panhandle"],
  ["KING_MTN_WIND",     6,  "panhandle"],
  ["PAMPA_WIND",        6,  "panhandle"],
  ["AMARILLO_WIND",     4,  "panhandle"],
  ["LUBBOCK_WIND",      4,  "panhandle"],
  ["GOLDEN_SPREAD_WIND",5,  "panhandle"],
  ["HACKBERRY_WIND",    4,  "panhandle"],
  ["HEREFORD_WIND",     4,  "panhandle"],
  ["DEAF_SMITH_WIND",   4,  "panhandle"],
  ["PARMER_WIND",       4,  "panhandle"],
  ["CASTRO_WIND",       3,  "panhandle"],
  ["SWISHER_WIND",      3,  "panhandle"],
  ["FLOYD_WIND",        4,  "panhandle"],
  ["CROSBY_WIND",       3,  "panhandle"],
  ["GARZA_WIND",        4,  "panhandle"],
  ["KENT_WIND",         3,  "panhandle"],
  ["DICKENS_WIND",      3,  "panhandle"],
  ["COTTLE_WIND",       3,  "panhandle"],
  ["MOTLEY_WIND",       3,  "panhandle"],
  ["HALL_WIND",         3,  "panhandle"],
  ["CHILDRESS_WIND",    4,  "panhandle"],
  ["HARDEMAN_WIND",     4,  "panhandle"],
  ["FOARD_WIND",        3,  "panhandle"],
  ["KNOX_WIND",         3,  "panhandle"],
  ["KING_WIND",         3,  "panhandle"],
  ["STONEWALL_WIND",    3,  "panhandle"],
  ["HASKELL_WIND",      4,  "panhandle"],
  ["THROCKMORTON_WIND", 3,  "panhandle"],
  ["SHACKELFORD_WIND",  3,  "panhandle"],
];

const WIND_SOUTH: NodeDef[] = [
  ["JIM_WELLS_WIND",    3,  "south"],
  ["KENEDY_WIND",       5,  "south"],
  ["WILLACY_WIND",      4,  "south"],
  ["HIDALGO_WIND",      5,  "south"],
  ["CAMERON_WIND",      4,  "south"],
  ["STARR_WIND",        3,  "south"],
  ["ZAPATA_WIND",       3,  "south"],
  ["DUVAL_WIND",        4,  "south"],
  ["JIM_HOGG_WIND",     3,  "south"],
  ["BROOKS_WIND",       3,  "south"],
  ["NUECES_WIND",       4,  "gulf"],
  ["ARANSAS_WIND",      3,  "gulf"],
  ["SAN_PAT_WIND",      3,  "gulf"],
  ["REFUGIO_WIND",      3,  "gulf"],
  ["VICTORIA_WIND",     4,  "gulf"],
  ["CALHOUN_WIND",      3,  "gulf"],
  ["MATAGORDA_WIND",    4,  "gulf"],
  ["JACKSON_WIND",      3,  "gulf"],
  ["WHARTON_WIND",      4,  "gulf"],
  ["FORT_BEND_WIND",    3,  "houston"],
];

const SOLAR_WEST: NodeDef[] = [
  ["PERMIAN_SOLAR",     6,  "west_solar"],
  ["MIDWAY_SOLAR",      4,  "west_solar"],
  ["PANTHER_CRK_SOLAR", 4,  "west_solar"],
  ["UPTON_SOLAR",       5,  "west_solar"],
  ["CRANE_SOLAR",       4,  "west_solar"],
  ["WINKLER_SOLAR",     3,  "west_solar"],
  ["WARD_SOLAR",        4,  "west_solar"],
  ["REEVES_SOLAR",      5,  "far_west"],
  ["PECOS_SOLAR",       6,  "far_west"],
  ["TERRELL_SOLAR",     3,  "far_west"],
  ["BREWSTER_SOLAR",    3,  "far_west"],
  ["PRESIDIO_SOLAR",    4,  "far_west"],
  ["MIDLAND_SOLAR",     4,  "west_solar"],
  ["ECTOR_SOLAR",       5,  "west_solar"],
  ["ANDREWS_SOLAR",     4,  "west_solar"],
  ["GAINES_SOLAR",      4,  "west_solar"],
  ["DAWSON_SOLAR",      3,  "west_solar"],
  ["YOAKUM_SOLAR",      3,  "west_solar"],
  ["TERRY_SOLAR",       3,  "west_solar"],
  ["LYNN_SOLAR",        3,  "west_solar"],
  ["HOCKLEY_SOLAR",     4,  "west_solar"],
  ["LUBBOCK_SOLAR",     4,  "west_solar"],
  ["GARZA_SOLAR",       3,  "west_solar"],
  ["STANTON_SOLAR",     4,  "west_solar"],
  ["STERLING_SOLAR",    3,  "west_solar"],
];

const SOLAR_CENTRAL: NodeDef[] = [
  ["LAMAR_SOLAR",       4,  "central"],
  ["BASTROP_SOLAR",     3,  "central"],
  ["BRISCOE_SOLAR",     4,  "central"],
  ["FRIO_SOLAR",        4,  "south"],
  ["MAVERICK_SOLAR",    4,  "south"],
  ["SAN_SABA_SOLAR",    3,  "central"],
  ["WHARTON_SOLAR",     3,  "gulf"],
  ["GRIMES_SOLAR",      3,  "north"],
  ["ROBERTSON_SOLAR",   3,  "north"],
  ["FALLS_SOLAR",       3,  "central"],
  ["HILL_SOLAR",        3,  "central"],
  ["NAVARRO_SOLAR",     4,  "north"],
  ["LIMESTONE_SOLAR",   3,  "north"],
  ["LEON_SOLAR",        3,  "central"],
  ["FREESTONE_SOLAR",   3,  "north"],
  ["ANDERSON_SOLAR",    3,  "north"],
  ["HENDERSON_SOLAR",   3,  "north"],
  ["RUSK_SOLAR",        4,  "north"],
  ["CHEROKEE_SOLAR",    3,  "north"],
  ["SMITH_SOLAR",       4,  "north"],
  ["WOOD_SOLAR",        3,  "north"],
  ["UPSHUR_SOLAR",      3,  "north"],
  ["GREGG_SOLAR",       4,  "north"],
  ["HARRISON_SOLAR",    3,  "north"],
  ["BOWIE_SOLAR",       3,  "north"],
  ["CASS_SOLAR",        3,  "north"],
  ["TITUS_SOLAR",       3,  "north"],
  ["CAMP_SOLAR",        3,  "north"],
  ["MORRIS_SOLAR",      3,  "north"],
  ["FRANKLIN_SOLAR",    3,  "north"],
];

const GAS_HOUSTON: NodeDef[] = [
  ["CALPINE_CHANNEL",   4,  "houston"],
  ["CALPINE_CORPUS",    3,  "gulf"],
  ["NRG_WA_PARISH",     6,  "houston"],
  ["NRG_CEDAR_BAYOU",   4,  "houston"],
  ["NRG_GREENS_BAYOU",  5,  "houston"],
  ["NRG_LIMESTONE",     2,  "north"],
  ["DECKER_CRK",        5,  "central"],
  ["PANDA_TEMPLE",      2,  "central"],
  ["PANDA_SHERMAN",     2,  "north"],
  ["AES_BARNEY_DAVIS",  2,  "gulf"],
  ["TENASKA_LAMAR",     2,  "north"],
  ["TENASKA_MIDLAND",   2,  "west_wind"],
  ["BLUEBONNET_GAS",    3,  "central"],
  ["BRAZOS_GAS",        3,  "central"],
  ["SPS_GAS",           3,  "panhandle"],
  ["WTU_GAS",           3,  "west_wind"],
  ["ONCOR_GAS",         4,  "north"],
  ["ENTERGY_GAS",       4,  "gulf"],
  ["CPS_GAS",           4,  "south"],
  ["AEP_GAS",           4,  "central"],
  ["FRONTIER_GAS",      3,  "north"],
  ["GOLDEN_SPREAD_GAS", 2,  "panhandle"],
  ["MOUNTAIN_CRK_GAS",  4,  "north"],
  ["LAKE_HUBBARD_GAS",  2,  "north"],
  ["MORGAN_CRK_GAS",    2,  "north"],
  ["DECORDOVA_GAS",     2,  "north"],
  ["LAMAR_GAS",         3,  "north"],
  ["GIBBONS_CRK_GAS",   2,  "central"],
  ["OKLAUNION_GAS",     2,  "north"],
  ["COMANCHE_GAS",      2,  "central"],
];

const GAS_SOUTH: NodeDef[] = [
  ["FRONTERA_GAS",      3,  "south"],
  ["AES_DPL",           2,  "gulf"],
  ["SAN_JUAN_GAS",      2,  "south"],
  ["EDINBURG_GAS",      3,  "south"],
  ["HIDALGO_GAS",       3,  "south"],
  ["LAREDO_GAS",        2,  "south"],
  ["WEBB_GAS",          2,  "south"],
  ["MAVERICK_GAS",      2,  "south"],
  ["EAGLE_PASS_GAS",    2,  "south"],
  ["DEL_RIO_GAS",       2,  "south"],
  ["BRAUNIG_GAS",       3,  "south"],
  ["CALUMET_GAS",       2,  "south"],
  ["COLETO_CRK_GAS",    2,  "gulf"],
  ["FORMOSA_GAS",       2,  "gulf"],
  ["FLINT_HILLS_GAS",   2,  "gulf"],
  ["CORPUS_GAS",        3,  "gulf"],
  ["PORT_ARTHUR_GAS",   3,  "gulf"],
  ["BEAUMONT_GAS",      3,  "gulf"],
  ["ORANGE_GAS",        2,  "gulf"],
  ["SABINE_GAS",        2,  "gulf"],
];

const NUCLEAR: NodeDef[] = [
  ["STP",               2,  "nuclear"],
  ["COMANCHE_PK",       2,  "nuclear"],
];

const STORAGE: NodeDef[] = [
  ["VISTRA_MOSS_BES",    4,  "storage"],
  ["TESLA_ANGLETON_BES", 3,  "storage"],
  ["GOLDEN_SPREAD_BES",  3,  "storage"],
  ["NRG_BATTERY_HOUSTON",3,  "storage"],
  ["CALPINE_BES_CHANNEL",2,  "storage"],
  ["AES_BES_SOUTH",      3,  "storage"],
  ["TENASKA_BES_NORTH",  3,  "storage"],
  ["PANDA_BES",          2,  "storage"],
  ["ERCOT_BES_WEST",     4,  "storage"],
  ["SOLAR_BES_PERMIAN",  4,  "storage"],
  ["WIND_BES_PANHANDLE", 4,  "storage"],
  ["GRID_BES_HOUSTON",   3,  "storage"],
  ["NEXT_BES_CENTRAL",   3,  "storage"],
  ["LIGHTSOURCE_BES",    3,  "storage"],
  ["X_ELIO_BES",         3,  "storage"],
  ["RECURRENT_BES",      3,  "storage"],
  ["LONGROAD_BES",       3,  "storage"],
  ["INTERSECT_BES",      2,  "storage"],
  ["ENEL_BES",           3,  "storage"],
  ["ORIGIS_BES",         2,  "storage"],
];

const OTHER: NodeDef[] = [
  ["ALCOA_HYDRO",        2,  "central"],
  ["LAKE_TRAVIS_HYDRO",  2,  "central"],
  ["POSSUM_KINGDOM_HYDRO",2, "north"],
  ["CANYON_LAKE_HYDRO",  2,  "south"],
  ["BUCHANAN_HYDRO",     2,  "central"],
  ["BIOMASS_EAST_TX",    3,  "north"],
  ["BIOMASS_GULF",       2,  "gulf"],
  ["GEOTHERMAL_WEST",    2,  "west_wind"],
  ["MSW_HOUSTON",        2,  "houston"],
  ["MSW_DFW",            2,  "north"],
  ["LANDFILL_GAS_EAST",  3,  "north"],
  ["LANDFILL_GAS_GULF",  2,  "gulf"],
];

// ── Build flat node list ──────────────────────────────────────────────────────
function buildNodes(groups: NodeDef[][]): Array<{ name: string; region: string }> {
  const nodes: Array<{ name: string; region: string }> = [];
  for (const group of groups) {
    for (const [prefix, units, region] of group) {
      for (let u = 1; u <= units; u++) {
        nodes.push({ name: `${prefix}_${u}`, region });
      }
    }
  }
  return nodes;
}

const ALL_NODES = buildNodes([
  WIND_WEST, WIND_PANHANDLE, WIND_SOUTH,
  SOLAR_WEST, SOLAR_CENTRAL,
  GAS_HOUSTON, GAS_SOUTH,
  NUCLEAR,
  STORAGE,
  OTHER,
]);

// ── Helpers ──────────────────────────────────────────────────────────────────
function jitter(val: number, pct = 0.12): number {
  return val * (1 + (Math.random() - 0.5) * pct * 2);
}

function monthlyDa(basePrice: number, month: number, region: string): number {
  const seasonal = region.includes("wind") || region === "panhandle"
    ? WIND_SEASON[month - 1]
    : SEASON[month - 1];
  return jitter(basePrice * seasonal, 0.10);
}

// ── Seed ─────────────────────────────────────────────────────────────────────
const YEARS = [2023, 2024];
const BATCH = 500;

async function seed() {
  console.log(`Total resource nodes to seed: ${ALL_NODES.length}`);
  console.log("Checking existing settlement points...");

  const existing = await db.execute<{ settlement_point: string }>(
    sql`SELECT DISTINCT settlement_point FROM ercot_nodal_stats`
  );
  const existingSet = new Set(existing.rows.map(r => r.settlement_point));
  console.log(`Already have ${existingSet.size} settlement points.`);

  const rows: Array<typeof ercotNodalStatsTable.$inferInsert> = [];

  for (const node of ALL_NODES) {
    if (existingSet.has(node.name)) continue;
    const basePrice = ZONE_BASE[node.region] ?? 30;
    const basis = RT_BASIS[node.region] ?? -2;
    const negPct = NEG_PCT[node.region] ?? 2;

    for (const year of YEARS) {
      for (let month = 1; month <= 12; month++) {
        const avgDa = monthlyDa(basePrice, month, node.region);
        const basisMult = month >= 4 && month <= 6 ? 1.5 : month >= 11 || month <= 1 ? 0.6 : 1.0;
        const avgRt = avgDa + jitter(basis * basisMult, 0.15);
        const onPeak = avgDa * jitter(1.08, 0.05);
        const offPeak = avgDa * jitter(0.88, 0.05);
        const stdDev = jitter(Math.abs(basis) * 0.8 + 2, 0.20);
        const negPctMonth = jitter(negPct * (month >= 4 && month <= 6 ? 1.6 : 0.8), 0.25);

        rows.push({
          settlementPoint: node.name,
          year,
          month,
          avgDaPrice: avgDa.toFixed(4),
          avgRtPrice: avgRt.toFixed(4),
          stdDev:     stdDev.toFixed(4),
          negPricePercent: Math.max(0, negPctMonth).toFixed(3),
          onPeakAvg:  onPeak.toFixed(4),
          offPeakAvg: offPeak.toFixed(4),
          minPrice:   (avgDa - stdDev * 2.5).toFixed(4),
          maxPrice:   (avgDa + stdDev * 3.5).toFixed(4),
          sampleCount: Math.round(jitter(720, 0.05)),
        });
      }
    }
  }

  console.log(`Inserting ${rows.length} new rows (${Math.round(rows.length / (YEARS.length * 12))} new nodes) in batches of ${BATCH}...`);

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await db.insert(ercotNodalStatsTable).values(batch);
    process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
  }

  console.log("\nDone seeding ERCOT resource nodes.");
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
