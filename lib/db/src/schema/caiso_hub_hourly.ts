import { pgTable, serial, text, numeric, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const caisoHubHourlyTable = pgTable("caiso_hub_da_rt_hourly", {
  id:        serial("id").primaryKey(),
  node:      text("node").notNull(),
  nodeType:  text("node_type").notNull(),
  year:      integer("year").notNull(),
  month:     integer("month").notNull(),
  day:       integer("day").notNull(),
  hour:      integer("hour").notNull(),
  daPrice:   numeric("da_price", { precision: 10, scale: 4 }),
  rtPrice:   numeric("rt_price", { precision: 10, scale: 4 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("caiso_hub_da_rt_hourly_uq").on(t.node, t.year, t.month, t.day, t.hour),
  index("caiso_hub_da_rt_hourly_node_idx").on(t.node),
  index("caiso_hub_da_rt_hourly_time_idx").on(t.year, t.month, t.day, t.hour),
]);

export type CaisoHubHourly = typeof caisoHubHourlyTable.$inferSelect;
export type InsertCaisoHubHourly = typeof caisoHubHourlyTable.$inferInsert;
