import { pgTable, serial, text, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const ercotBusShiftFactorsTable = pgTable("ercot_bus_shift_factors", {
  id:                    serial("id").primaryKey(),
  busName:               text("bus_name").notNull(),
  ercotZone:             text("ercot_zone"),
  eiaZone:               text("eia_zone").notNull(),
  shiftFactor:           numeric("shift_factor",            { precision: 14, scale: 10 }),
  electricalParticipation: numeric("electrical_participation", { precision: 14, scale: 4 }),
  busLat:                numeric("bus_lat",                 { precision: 10, scale: 6 }),
  busLon:                numeric("bus_lon",                 { precision: 10, scale: 6 }),
  method:                text("method").default("ptdf"),
  createdAt:             timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("ercot_bus_sf_uq").on(t.busName),
  index("ercot_bus_sf_zone_idx").on(t.eiaZone),
  index("ercot_bus_sf_ercot_zone_idx").on(t.ercotZone),
]);

export type ErcotBusShiftFactor = typeof ercotBusShiftFactorsTable.$inferSelect;
export type InsertErcotBusShiftFactor = typeof ercotBusShiftFactorsTable.$inferInsert;
