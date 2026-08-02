import { pgTable, serial, varchar, smallint, real, unique } from "drizzle-orm/pg-core";

export const hourlyTemperatures = pgTable(
  "iso_hourly_temps",
  {
    id:     serial("id").primaryKey(),
    iso:    varchar("iso",  { length: 10 }).notNull(),
    zone:   varchar("zone", { length: 20 }).notNull(),
    year:   smallint("year").notNull(),
    month:  smallint("month").notNull(),
    day:    smallint("day").notNull(),
    hour:   smallint("hour").notNull(),
    tempF:  real("temp_f").notNull(),
    tempC:  real("temp_c").notNull(),
  },
  (t) => [unique("hourly_temperatures_uniq").on(t.iso, t.zone, t.year, t.month, t.day, t.hour)],
);
