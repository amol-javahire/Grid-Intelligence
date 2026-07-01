import { pgTable, serial, varchar, smallint, real, unique } from "drizzle-orm/pg-core";

export const loadForecasts = pgTable("load_forecasts", {
  id:      serial("id").primaryKey(),
  zone:    varchar("zone", { length: 20 }).notNull(),
  year:    smallint("year").notNull(),
  month:   smallint("month").notNull(),
  day:     smallint("day").notNull(),
  baseMw:  real("base_mw"),
  evMw:    real("ev_mw"),
  dcMw:    real("dc_mw"),
  totalMw: real("total_mw"),
}, (t) => ({
  unq: unique().on(t.zone, t.year, t.month, t.day),
}));
