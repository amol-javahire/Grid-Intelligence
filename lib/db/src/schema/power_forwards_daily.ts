import { pgTable, serial, text, numeric, integer, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Daily-shaped power forward prices.
 *
 * power_forwards holds one price per calendar month (EIA STEO forecast).
 * This table distributes each monthly price across every day in that month
 * using a real 2025 daily settlement shape:
 *
 *   shape_factor(month, day) = 2025 real daily DA price / 2025 real monthly
 *                               avg DA price, at the SAME reference hub the
 *                               monthly forward represents (HB_NORTH for
 *                               ERCOT, SP15 for CAISO — see power_forwards.ts
 *                               header for why those hubs were chosen).
 *
 *   daily_forward_price(future month, day N) =
 *       monthly_forward_price(future month) × shape_factor(calendar month of
 *       future month, day N of 2025's same calendar month)
 *
 * Mapping is MONTH × WEEKDAY: a Saturday in Sep 2026 takes the average of all
 * Saturdays in Sep 2025. Revised 2026-08-02 from an earlier day-of-month
 * mapping, which was value-correct but misaligned the weekly cycle (2025 and
 * 2026 put weekends on different dates), producing Sundays priced above the
 * following Monday.
 *
 * Each delivery month is renormalised so its calendar-day mean factor is
 * exactly 1.0 — the daily series must average back to the monthly forward or
 * the contract's value silently changes.
 *
 * Built by scripts/src/seed-power-forwards-daily.ts.
 */
export const powerForwardsDailyTable = pgTable("power_forwards_daily", {
  id:                     serial("id").primaryKey(),
  market:                 text("market").notNull(),          // 'ERCOT' | 'CAISO'
  asOfDate:               date("as_of_date").notNull(),       // matches power_forwards.as_of_date used as source
  deliveryDate:           date("delivery_date").notNull(),    // the specific day
  priceMwh:               numeric("price_mwh", { precision: 10, scale: 4 }),
  monthlyForwardPriceMwh: numeric("monthly_forward_price_mwh", { precision: 10, scale: 4 }), // audit: source monthly value
  shapeFactor:            numeric("shape_factor", { precision: 8, scale: 5 }),                // audit: daily/monthly ratio applied
  referenceNode:          text("reference_node"),             // audit: hub the shape was derived from
  shapeYear:              integer("shape_year").default(2025),// audit: source year for the daily shape
  createdAt:              timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("power_forwards_daily_uq").on(t.market, t.asOfDate, t.deliveryDate),
  index("power_forwards_daily_market_idx").on(t.market),
  index("power_forwards_daily_delivery_idx").on(t.deliveryDate),
]);

export type PowerForwardDaily = typeof powerForwardsDailyTable.$inferSelect;
export type InsertPowerForwardDaily = typeof powerForwardsDailyTable.$inferInsert;
