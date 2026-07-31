import { pgTable, serial, text, numeric, integer, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Daily-shaped gas forward prices.
 *
 * gas_forwards holds one national Henry Hub price per calendar month. This
 * table distributes each monthly price across every day in that month using
 * a real 2025 daily settlement shape, same methodology as
 * power_forwards_daily.ts:
 *
 *   shape_factor(month, day) = 2025 real daily Henry Hub price / 2025 real
 *                               monthly avg Henry Hub price (gas_prices,
 *                               hub='henry_hub')
 *
 *   daily_forward_price(future month, day N) =
 *       monthly_forward_price(future month) × shape_factor(calendar month,
 *       day N of 2025's same calendar month)
 *
 * Henry-Hub-only scope (not split by ERCOT/CAISO basis hub) — confirmed with
 * the user as the recommended default since gas_forwards itself is a single
 * national curve; Waha/CA-citygate don't have their own forward strips yet.
 *
 * Built by scripts/src/seed-gas-forwards-daily.ts.
 */
export const gasForwardsDailyTable = pgTable("gas_forwards_daily", {
  id:                   serial("id").primaryKey(),
  asOfDate:             date("as_of_date").notNull(),
  deliveryDate:         date("delivery_date").notNull(),
  priceMmbtu:           numeric("price_mmbtu", { precision: 10, scale: 4 }),
  monthlyForwardPrice:  numeric("monthly_forward_price", { precision: 10, scale: 4 }), // audit: source monthly value
  shapeFactor:          numeric("shape_factor", { precision: 8, scale: 5 }),           // audit: daily/monthly ratio applied
  referenceHub:         text("reference_hub").default("henry_hub"),
  shapeYear:            integer("shape_year").default(2025),
  createdAt:            timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("gas_forwards_daily_uq").on(t.asOfDate, t.deliveryDate),
  index("gas_forwards_daily_delivery_idx").on(t.deliveryDate),
]);

export type GasForwardDaily = typeof gasForwardsDailyTable.$inferSelect;
export type InsertGasForwardDaily = typeof gasForwardsDailyTable.$inferInsert;
