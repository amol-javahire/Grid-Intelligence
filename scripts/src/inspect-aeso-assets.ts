/**
 * Read-only survey of aeso_asset_registry, to design the asset → bus mapping
 * for the 9-bus PyPSA congestion model (aeso_network_regional.py).
 *
 * WHY: that model currently aggregates generation into ~30 (region, carrier)
 * blocks taken from the AESO 2025 LTP, each with ONE flat marginal cost from
 * CARRIER_MC. With a supply stack that coarse the marginal unit almost never
 * changes, so LMP is identical at every bus across a wide load range and
 * congestion never appears. Replacing it with ~230 real units at real
 * locations is what makes nodal prices actually move.
 *
 * The registry has a free-text `location` column and NO lat/lon, so the
 * mapping has to be derived. This script reports exactly what's in there
 * before any parser is written — same verify-first approach used on the AESO
 * queue xlsx and the Alberta major-projects CSV, both of which turned up
 * surprises that would have silently corrupted the load.
 *
 * Run: pnpm --filter @workspace/scripts inspect-aeso-assets
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== aeso_asset_registry survey ===\n");

  const totals = await db.execute<{ n: string; with_loc: string; with_cap: string; mw: string }>(sql`
    SELECT COUNT(*)::text AS n,
           COUNT(NULLIF(TRIM(COALESCE(location, '')), ''))::text AS with_loc,
           COUNT(max_capability_mw)::text AS with_cap,
           ROUND(SUM(max_capability_mw)::numeric, 0)::text AS mw
    FROM aeso_asset_registry
  `);
  const t = totals.rows[0];
  console.log(`Assets: ${t.n} | with location: ${t.with_loc} | with capacity: ${t.with_cap} | total ${t.mw} MW`);
  console.log(`(AESO installed capacity is ~23,000 MW — a total far below that means`);
  console.log(` the registry is partial, or capacity is null for big units.)\n`);

  console.log("=== by fuel_type ===");
  const byFuel = await db.execute<{ fuel_type: string; n: string; mw: string }>(sql`
    SELECT COALESCE(fuel_type, '(null)') AS fuel_type, COUNT(*)::text AS n,
           ROUND(SUM(max_capability_mw)::numeric, 0)::text AS mw
    FROM aeso_asset_registry GROUP BY 1 ORDER BY SUM(max_capability_mw) DESC NULLS LAST
  `);
  for (const r of byFuel.rows) console.log(`  ${String(r.fuel_type).padEnd(18)} ${String(r.n).padStart(5)} assets  ${String(r.mw ?? "-").padStart(8)} MW`);

  console.log("\n=== by sub_fuel_type ===");
  const bySub = await db.execute<{ sub_fuel_type: string; n: string; mw: string }>(sql`
    SELECT COALESCE(sub_fuel_type, '(null)') AS sub_fuel_type, COUNT(*)::text AS n,
           ROUND(SUM(max_capability_mw)::numeric, 0)::text AS mw
    FROM aeso_asset_registry GROUP BY 1 ORDER BY SUM(max_capability_mw) DESC NULLS LAST
  `);
  for (const r of bySub.rows) console.log(`  ${String(r.sub_fuel_type).padEnd(22)} ${String(r.n).padStart(5)}  ${String(r.mw ?? "-").padStart(8)} MW`);

  console.log("\n=== DISTINCT location values (the whole point of this script) ===");
  const locs = await db.execute<{ location: string; n: string; mw: string }>(sql`
    SELECT COALESCE(NULLIF(TRIM(location), ''), '(empty)') AS location, COUNT(*)::text AS n,
           ROUND(SUM(max_capability_mw)::numeric, 0)::text AS mw
    FROM aeso_asset_registry GROUP BY 1 ORDER BY COUNT(*) DESC
  `);
  console.log(`  ${locs.rows.length} distinct values:`);
  for (const r of locs.rows) console.log(`    ${String(r.location).padEnd(40)} ${String(r.n).padStart(4)}  ${String(r.mw ?? "-").padStart(8)} MW`);

  console.log("\n=== 15 largest assets (name / fuel / location / MW) ===");
  const big = await db.execute<{ asset_id: string; asset_name: string; fuel_type: string; location: string; mw: string }>(sql`
    SELECT asset_id, COALESCE(asset_name,'') AS asset_name, COALESCE(fuel_type,'') AS fuel_type,
           COALESCE(location,'') AS location, ROUND(max_capability_mw::numeric,1)::text AS mw
    FROM aeso_asset_registry WHERE max_capability_mw IS NOT NULL
    ORDER BY max_capability_mw DESC LIMIT 15
  `);
  for (const r of big.rows) {
    console.log(`  ${r.asset_id.padEnd(12)} ${r.asset_name.slice(0, 30).padEnd(32)} ${r.fuel_type.padEnd(12)} ${r.location.slice(0, 24).padEnd(26)} ${r.mw.padStart(8)} MW`);
  }

  console.log("\n=== status values ===");
  const st = await db.execute<{ status: string; n: string }>(sql`
    SELECT COALESCE(status,'(null)') AS status, COUNT(*)::text AS n
    FROM aeso_asset_registry GROUP BY 1 ORDER BY COUNT(*) DESC
  `);
  for (const r of st.rows) console.log(`  ${String(r.status).padEnd(20)} ${r.n}`);

  // Do the merit-order offers exist? They'd give a REAL per-unit supply curve,
  // which is far better than CARRIER_MC's 6 flat prices — the actual reason
  // LMPs don't move today.
  console.log("\n=== aeso_merit_order coverage (real per-unit offer prices?) ===");
  try {
    const mo = await db.execute<{ n: string; assets: string; lo: string; hi: string }>(sql`
      SELECT COUNT(*)::text AS n, COUNT(DISTINCT asset_id)::text AS assets,
             MIN(date)::text AS lo, MAX(date)::text AS hi FROM aeso_merit_order
    `);
    const m = mo.rows[0];
    console.log(`  ${m.n} rows | ${m.assets} distinct assets | ${m.lo} → ${m.hi}`);
    if (Number(m.n) > 0) {
      const linked = await db.execute<{ matched: string; unmatched: string }>(sql`
        SELECT COUNT(*) FILTER (WHERE r.asset_id IS NOT NULL)::text AS matched,
               COUNT(*) FILTER (WHERE r.asset_id IS NULL)::text AS unmatched
        FROM (SELECT DISTINCT asset_id FROM aeso_merit_order) m
        LEFT JOIN aeso_asset_registry r ON r.asset_id = m.asset_id
      `);
      console.log(`  join to registry — matched: ${linked.rows[0].matched}, unmatched: ${linked.rows[0].unmatched}`);
    }
  } catch (e) {
    console.log(`  aeso_merit_order unavailable: ${(e as Error).message.slice(0, 80)}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
