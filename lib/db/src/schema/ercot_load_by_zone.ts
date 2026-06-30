import { pgTable, serial, numeric, integer, index, uniqueIndex, text } from "drizzle-orm/pg-core";

export const ercotLoadByZoneTable = pgTable("ercot_load_by_zone", {
  id:      serial("id").primaryKey(),
  year:    integer("year").notNull(),
  month:   integer("month").notNull(),
  day:     integer("day").notNull(),
  hour:    integer("hour").notNull(),
  zone:    text("zone").notNull(),
  loadMw:  numeric("load_mw", { precision: 10, scale: 2 }).notNull(),
}, (t) => [
  uniqueIndex("ercot_load_zone_uq").on(t.year, t.month, t.day, t.hour, t.zone),
  index("ercot_load_zone_time_idx").on(t.year, t.month, t.day, t.hour),
  index("ercot_load_zone_zone_idx").on(t.zone),
]);

export type ErcotLoadByZone    = typeof ercotLoadByZoneTable.$inferSelect;
export type InsertErcotLoadByZone = typeof ercotLoadByZoneTable.$inferInsert;
