import { pgTable, serial, text, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ercotNodalStatsTable = pgTable("ercot_nodal_stats", {
  id: serial("id").primaryKey(),
  settlementPoint: text("settlement_point").notNull(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  avgDaPrice: numeric("avg_da_price", { precision: 10, scale: 4 }).notNull(),
  avgRtPrice: numeric("avg_rt_price", { precision: 10, scale: 4 }),
  stdDev: numeric("std_dev", { precision: 10, scale: 4 }),
  negPricePercent: numeric("neg_price_percent", { precision: 6, scale: 3 }),
  onPeakAvg: numeric("on_peak_avg", { precision: 10, scale: 4 }),
  offPeakAvg: numeric("off_peak_avg", { precision: 10, scale: 4 }),
  minPrice: numeric("min_price", { precision: 10, scale: 4 }),
  maxPrice: numeric("max_price", { precision: 10, scale: 4 }),
  sampleCount: integer("sample_count"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertErcotNodalStatsSchema = createInsertSchema(ercotNodalStatsTable).omit({ id: true, createdAt: true });
export type InsertErcotNodalStats = z.infer<typeof insertErcotNodalStatsSchema>;
export type ErcotNodalStats = typeof ercotNodalStatsTable.$inferSelect;
