import { pgTable, serial, text, numeric, date, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * Regional wholesale power price forecast — EIA Short-Term Energy Outlook.
 *
 * NOT a tradeable futures settlement. Real regional power hub futures
 * (ERCOT North, CAISO SP15) trade on ICE/Nodal Exchange behind paid data
 * feeds with no free public source — confirmed by checking the commodity
 * API connected to this session (covers Henry Hub/Brent/WTI/TTF only, no
 * regional US power) before building this. EIA STEO is the best available
 * free alternative: a government forecaster's monthly wholesale price
 * outlook, published through the same API already used for Henry Hub gas.
 *
 * Series (confirmed via scripts/src/discover-eia-series.ts against the live
 * EIA API, 2026-07):
 *   ERCOT → ELWHU_TX  "Wholesale Electricity Price, ERCOT (Texas) ISO North hub"
 *   CAISO → ELWHU_CA  "Wholesale Electricity Price, CAISO (California ISO) SP15 zone"
 *
 * Seeded by scripts/src/seed-power-forwards.ts. Consumed by
 * artifacts/api-server/src/routes/ppa.ts, which prefers this real forecast
 * over the older gas×heat-rate synthetic proxy when available (ERCOT), and
 * gives CAISO a forward reference for the first time (previously fell back
 * straight to a flat historical average).
 */
export const powerForwardsTable = pgTable("power_forwards", {
  id:            serial("id").primaryKey(),
  market:        text("market").notNull(),          // 'ERCOT' | 'CAISO'
  asOfDate:      date("as_of_date").notNull(),       // date this forecast vintage was fetched
  deliveryMonth: date("delivery_month").notNull(),   // first day of forecast month (YYYY-MM-01)
  priceMwh:      numeric("price_mwh", { precision: 10, scale: 4 }),  // $/MWh
  source:        text("source").notNull(),           // 'eia_steo'
  seriesId:      text("series_id"),                  // e.g. 'ELWHU_TX' — for audit/debugging
  fetchedAt:     timestamp("fetched_at").defaultNow(),
}, (t) => [
  uniqueIndex("power_forwards_market_asof_delivery_uq").on(t.market, t.asOfDate, t.deliveryMonth),
  index("power_forwards_market_idx").on(t.market),
  index("power_forwards_delivery_idx").on(t.deliveryMonth),
]);

export type PowerForward = typeof powerForwardsTable.$inferSelect;
export type InsertPowerForward = typeof powerForwardsTable.$inferInsert;
