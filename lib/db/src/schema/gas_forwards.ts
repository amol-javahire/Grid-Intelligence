import { pgTable, serial, text, numeric, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const gasForwardsTable = pgTable("gas_forwards", {
  id:            serial("id").primaryKey(),
  asOfDate:      date("as_of_date").notNull(),       // curve publication date
  deliveryMonth: date("delivery_month").notNull(),   // first day of delivery month (YYYY-MM-01)
  settlePrice:   numeric("settle_price", { precision: 10, scale: 4 }),  // $/MMBtu
  source:        text("source"),                     // 'model' | 'eia' | 'cme'
  fetchedAt:     timestamp("fetched_at").defaultNow(),
}, (t) => [
  uniqueIndex("gas_forwards_asof_delivery_uq").on(t.asOfDate, t.deliveryMonth),
  index("gas_forwards_asof_idx").on(t.asOfDate),
  index("gas_forwards_delivery_idx").on(t.deliveryMonth),
]);

export type GasForward = typeof gasForwardsTable.$inferSelect;
export type InsertGasForward = typeof gasForwardsTable.$inferInsert;
