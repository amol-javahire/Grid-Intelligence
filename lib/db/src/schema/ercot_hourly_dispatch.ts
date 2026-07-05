import { pgTable, text, timestamp, numeric, integer, index } from "drizzle-orm/pg-core";

export const ercotHourlyDispatchTable = pgTable("ercot_hourly_dispatch", {
  resourceName:     text("resource_name").notNull(),
  hour:             timestamp("hour", { withTimezone: true }).notNull(),
  resourceType:     text("resource_type"),
  avgMw:            numeric("avg_mw",          { precision: 10, scale: 2 }),
  maxMw:            numeric("max_mw",          { precision: 10, scale: 2 }),
  hsl:              numeric("hsl",             { precision: 10, scale: 2 }),
  lsl:              numeric("lsl",             { precision: 10, scale: 2 }),
  basePoint:        numeric("base_point",      { precision: 10, scale: 2 }),
  onlineIntervals:  integer("online_intervals"),
  offerPriceMin:    numeric("offer_price_min", { precision: 10, scale: 2 }),
  offerPriceMax:    numeric("offer_price_max", { precision: 10, scale: 2 }),
  offerMwTotal:     numeric("offer_mw_total",  { precision: 10, scale: 2 }),
  startupCold:      numeric("startup_cold",    { precision: 10, scale: 2 }),
  startupHot:       numeric("startup_hot",     { precision: 10, scale: 2 }),
}, (t) => [
  index("idx_erd_hour").on(t.hour),
  index("idx_erd_type_hour").on(t.resourceType, t.hour),
]);

export const ercotDispatchSeedLogTable = pgTable("ercot_dispatch_seed_log", {
  seedDate:     text("seed_date").primaryKey(),
  rowsInserted: integer("rows_inserted"),
  seededAt:     timestamp("seeded_at", { withTimezone: true }).defaultNow(),
});

export type ErcotHourlyDispatch    = typeof ercotHourlyDispatchTable.$inferSelect;
export type ErcotDispatchSeedLog   = typeof ercotDispatchSeedLogTable.$inferSelect;
