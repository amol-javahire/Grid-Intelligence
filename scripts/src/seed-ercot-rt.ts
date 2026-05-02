import { db, ercotNodalStatsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// RT basis relative to DA price ($/MWh) — based on typical ERCOT nodal congestion patterns
// Negative = RT lower than DA (common for renewable nodes in West Texas)
const NODE_RT_BASIS: Record<string, number> = {
  "BES_DALLAS":      -0.8,   // near load center, small negative basis
  "BES_HOUSTON_N":   -1.2,
  "BES_HOUSTON_S":   -0.9,
  "HB_HOUSTON":      -0.5,   // hub, fairly liquid
  "HB_NORTH":        -0.6,
  "HB_WEST":         -3.2,   // West hub, renewable curtailment
  "LZ_HOUSTON":      -0.7,
  "LZ_NORTH":        -0.8,
  "LZ_SOUTH":        -1.1,
  "LZ_WEST":         -4.5,   // most constrained zone
  "SUN_MIDLAND":     -6.8,   // solar in Permian, congested
  "SUN_PERMIAN":     -7.5,
  "SUN_RIO_GRANDE":  -5.2,
  "WTG_ABILENE":     -9.2,   // wind nodes, significant curtailment
  "WTG_AMARILLO":    -11.5,
  "WTG_LUBBOCK":     -8.8,
  "WTG_ODESSA":      -10.4,
};

// Month-based multiplier for basis (spring curtailment peaks)
const MONTH_MULT = [0.6, 0.7, 1.2, 1.5, 1.3, 0.8, 0.7, 0.7, 0.9, 1.1, 0.8, 0.6];

function jitter(base: number, pct = 0.15): number {
  return base * (1 + (Math.random() - 0.5) * pct * 2);
}

async function seed() {
  console.log("Seeding RT prices for ERCOT nodal stats...");

  const rows = await db.select({
    id: ercotNodalStatsTable.id,
    settlementPoint: ercotNodalStatsTable.settlementPoint,
    month: ercotNodalStatsTable.month,
    avgDaPrice: ercotNodalStatsTable.avgDaPrice,
  }).from(ercotNodalStatsTable);

  console.log(`Found ${rows.length} rows to update with RT prices`);

  for (const row of rows) {
    const basis = NODE_RT_BASIS[row.settlementPoint] ?? -1.5;
    const mult = MONTH_MULT[row.month - 1];
    const adjustedBasis = jitter(basis * mult, 0.2);
    const rtPrice = Number(row.avgDaPrice) + adjustedBasis;

    await db.execute(
      sql`UPDATE ercot_nodal_stats SET avg_rt_price = ${rtPrice.toFixed(4)} WHERE id = ${row.id}`
    );
  }

  console.log("Done seeding RT prices.");
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
