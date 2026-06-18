import { pgTable, serial, text, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ercotBusesTable = pgTable("ercot_buses", {
  id:            serial("id").primaryKey(),
  busName:       text("bus_name").notNull(),
  psseBusName:   text("psse_bus_name"),
  psseBusNumber: integer("psse_bus_number"),
  voltageKv:     numeric("voltage_kv", { precision: 8, scale: 2 }).notNull(),
  substation:    text("substation"),
  loadZone:      text("load_zone"),
  resourceNode:  text("resource_node"),
  hub:           text("hub"),
  lat:           numeric("lat", { precision: 10, scale: 6 }),
  lon:           numeric("lon", { precision: 10, scale: 6 }),
  locationSource: text("location_source"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

export const insertErcotBusSchema = createInsertSchema(ercotBusesTable).omit({ id: true, createdAt: true });
export type InsertErcotBus = z.infer<typeof insertErcotBusSchema>;
export type ErcotBus = typeof ercotBusesTable.$inferSelect;
