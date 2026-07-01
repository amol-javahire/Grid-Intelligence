import { pgTable, serial, text, varchar, real, date } from "drizzle-orm/pg-core";

export const datacenters = pgTable("datacenters", {
  id:          serial("id").primaryKey(),
  name:        text("name").notNull(),
  operator:    text("operator"),
  market:      varchar("market", { length: 10 }).notNull(),
  state:       varchar("state", { length: 2 }).notNull(),
  lat:         real("lat").notNull(),
  lon:         real("lon").notNull(),
  capacityMw:  real("capacity_mw").notNull(),
  status:      varchar("status", { length: 20 }).notNull(),
  codDate:     date("cod_date"),
  nearestZone: varchar("nearest_zone", { length: 10 }),
  source:      text("source"),
  notes:       text("notes"),
});
