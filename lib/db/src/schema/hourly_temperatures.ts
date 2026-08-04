import { pgTable, bigserial, varchar, smallint, real, text, date, unique } from "drizzle-orm/pg-core";

/**
 * Hourly temperature by ISO load zone.
 *
 * TIMEZONE: `hour` is UTC, hour-beginning 0..23 — deliberately identical to
 * ercot/caiso/pjm_hourly_zonal_load so the temperature/load regression joins
 * on (year, month, day, hour) with no conversion. See iso_table_metadata.
 *
 * The previous version of this table had no source column and a HOST-DEPENDENT
 * timezone (it parsed unix epochs with datetime.fromtimestamp() and no tz
 * argument), so identical inputs produced different data on different machines.
 * source / method / latitude / longitude are NOT NULL here to make that class
 * of ambiguity impossible.
 *
 * Zones are the codes used by the load tables, verified against the live DB —
 * notably CAISO uses DLAPs (PGAE/SCE/SDGE/VEA), NOT the price hubs
 * NP15/SP15/ZP26, which have no load series to join against.
 */
export const isoHourlyTemps = pgTable(
  "iso_hourly_temps",
  {
    id:        bigserial("id", { mode: "number" }).primaryKey(),
    iso:       varchar("iso", { length: 10 }).notNull(),
    zone:      varchar("zone", { length: 20 }).notNull(),
    year:      smallint("year").notNull(),
    month:     smallint("month").notNull(),
    day:       smallint("day").notNull(),
    /** UTC, hour-beginning 0..23 */
    hour:      smallint("hour").notNull(),
    tempC:     real("temp_c").notNull(),
    tempF:     real("temp_f").notNull(),
    latitude:  real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    /** 'open_meteo_archive' | 'open_meteo_forecast' | 'synthetic' */
    source:    text("source").notNull(),
    /** 'single_centroid' | 'load_weighted' */
    method:    text("method").notNull(),
  },
  (t) => [unique("iso_hourly_temps_uniq").on(t.iso, t.zone, t.year, t.month, t.day, t.hour)],
);

/**
 * Daily degree days, rolled up on the MARKET-LOCAL calendar.
 *
 * Not UTC: a degree day is a local-calendar concept, and a UTC rollup would mix
 * the tail of one local day into the next. `hoursUsed` exposes the 23- and
 * 25-hour DST transition days rather than hiding them.
 */
export const isoDailyDegreeDays = pgTable(
  "iso_daily_degree_days",
  {
    id:        bigserial("id", { mode: "number" }).primaryKey(),
    iso:       varchar("iso", { length: 10 }).notNull(),
    zone:      varchar("zone", { length: 20 }).notNull(),
    localDate: date("local_date").notNull(),
    timeZone:  text("time_zone").notNull(),
    tempCAvg:  real("temp_c_avg").notNull(),
    tempCMin:  real("temp_c_min").notNull(),
    tempCMax:  real("temp_c_max").notNull(),
    hddC:      real("hdd_c").notNull(),
    cddC:      real("cdd_c").notNull(),
    hddF:      real("hdd_f").notNull(),
    cddF:      real("cdd_f").notNull(),
    hoursUsed: smallint("hours_used").notNull(),
  },
  (t) => [unique("iso_daily_degree_days_uniq").on(t.iso, t.zone, t.localDate)],
);

/** @deprecated Renamed to isoHourlyTemps. Kept so existing imports still compile. */
export const hourlyTemperatures = isoHourlyTemps;
