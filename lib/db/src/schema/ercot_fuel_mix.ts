import { pgTable, serial, numeric, integer, index, uniqueIndex, text } from "drizzle-orm/pg-core";

export const ercotFuelMixTable = pgTable("ercot_hourly_gen_output", {
  id:       serial("id").primaryKey(),
  year:     integer("year").notNull(),
  month:    integer("month").notNull(),
  day:      integer("day").notNull(),
  hour:     integer("hour").notNull(),
  fuelType: text("fuel_type").notNull(),
  genMw:    numeric("gen_mw", { precision: 10, scale: 2 }).notNull(),
  // 'sced_real'  = aggregated from real ERCOT 60-day SCED disclosure
  //                (ercot_hourly_dispatch), via
  //                infra/rebuild-ercot-gen-output-from-sced.sql.
  //                EXCLUDES behind-the-meter distributed generation, so totals
  //                run below ERCOT's published fuel mix — especially solar.
  // 'synthetic'  = calibrated model profile from seed-ercot-load-fuelmix.ts.
  //                Kept only for months SCED does not yet cover.
  // Added 2026-08 after synthetic data was found sitting in this table with
  // nothing in the schema indicating it wasn't real. Always filter on this.
  source:   text("source").notNull().default("synthetic"),
}, (t) => [
  uniqueIndex("ercot_fuel_mix_uq").on(t.year, t.month, t.day, t.hour, t.fuelType),
  index("ercot_fuel_mix_time_idx").on(t.year, t.month, t.day, t.hour),
  index("ercot_fuel_mix_fuel_idx").on(t.fuelType),
]);

export type ErcotFuelMix    = typeof ercotFuelMixTable.$inferSelect;
export type InsertErcotFuelMix = typeof ercotFuelMixTable.$inferInsert;
