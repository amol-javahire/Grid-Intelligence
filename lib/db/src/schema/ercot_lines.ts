import { pgTable, serial, text, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ercotLinesTable = pgTable("ercot_lines", {
  id:        serial("id").primaryKey(),
  fromBus:   text("from_bus").notNull(),
  toBus:     text("to_bus").notNull(),
  voltageKv: numeric("voltage_kv", { precision: 8, scale: 2 }).notNull(),
  lengthKm:  numeric("length_km", { precision: 10, scale: 3 }),
  xPu:       numeric("x_pu", { precision: 12, scale: 8 }).notNull(),
  sNomMw:    numeric("s_nom_mw", { precision: 10, scale: 2 }).notNull(),
  hifldId:   integer("hifld_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertErcotLineSchema = createInsertSchema(ercotLinesTable).omit({ id: true, createdAt: true });
export type InsertErcotLine = z.infer<typeof insertErcotLineSchema>;
export type ErcotLine = typeof ercotLinesTable.$inferSelect;
