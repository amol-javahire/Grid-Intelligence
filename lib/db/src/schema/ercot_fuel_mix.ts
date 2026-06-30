import { pgTable, serial, numeric, integer, index, uniqueIndex, text } from "drizzle-orm/pg-core";

export const ercotFuelMixTable = pgTable("ercot_fuel_mix", {
  id:       serial("id").primaryKey(),
  year:     integer("year").notNull(),
  month:    integer("month").notNull(),
  day:      integer("day").notNull(),
  hour:     integer("hour").notNull(),
  fuelType: text("fuel_type").notNull(),
  genMw:    numeric("gen_mw", { precision: 10, scale: 2 }).notNull(),
}, (t) => [
  uniqueIndex("ercot_fuel_mix_uq").on(t.year, t.month, t.day, t.hour, t.fuelType),
  index("ercot_fuel_mix_time_idx").on(t.year, t.month, t.day, t.hour),
  index("ercot_fuel_mix_fuel_idx").on(t.fuelType),
]);

export type ErcotFuelMix    = typeof ercotFuelMixTable.$inferSelect;
export type InsertErcotFuelMix = typeof ercotFuelMixTable.$inferInsert;
