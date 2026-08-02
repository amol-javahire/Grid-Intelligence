import { pgTable, serial, date, integer, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aesoPoolPriceTable = pgTable("aeso_hourly_pool_price", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  hourEnding: integer("hour_ending").notNull(),
  poolPrice: numeric("pool_price", { precision: 10, scale: 4 }),
  forecastPoolPrice: numeric("forecast_pool_price", { precision: 10, scale: 4 }),
  ailMw: numeric("ail_mw", { precision: 10, scale: 2 }),
  netGenMw: numeric("net_gen_mw", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [unique().on(t.date, t.hourEnding)]);

export const insertAesoPoolPriceSchema = createInsertSchema(aesoPoolPriceTable).omit({ id: true, createdAt: true });
export type InsertAesoPoolPrice = z.infer<typeof insertAesoPoolPriceSchema>;
export type AesoPoolPrice = typeof aesoPoolPriceTable.$inferSelect;
