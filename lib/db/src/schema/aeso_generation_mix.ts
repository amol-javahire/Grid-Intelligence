import { pgTable, serial, date, integer, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aesoGenerationMixTable = pgTable("aeso_hourly_gen_output", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  hourEnding: integer("hour_ending").notNull(),
  gasMw: numeric("gas_mw", { precision: 10, scale: 2 }),
  coalMw: numeric("coal_mw", { precision: 10, scale: 2 }),
  windMw: numeric("wind_mw", { precision: 10, scale: 2 }),
  solarMw: numeric("solar_mw", { precision: 10, scale: 2 }),
  hydroMw: numeric("hydro_mw", { precision: 10, scale: 2 }),
  storageMw: numeric("storage_mw", { precision: 10, scale: 2 }),
  otherMw: numeric("other_mw", { precision: 10, scale: 2 }),
  totalMw: numeric("total_mw", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [unique().on(t.date, t.hourEnding)]);

export const insertAesoGenerationMixSchema = createInsertSchema(aesoGenerationMixTable).omit({ id: true, createdAt: true });
export type InsertAesoGenerationMix = z.infer<typeof insertAesoGenerationMixSchema>;
export type AesoGenerationMix = typeof aesoGenerationMixTable.$inferSelect;
