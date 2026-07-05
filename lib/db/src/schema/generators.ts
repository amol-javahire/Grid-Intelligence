import { pgTable, serial, text, numeric, integer } from "drizzle-orm/pg-core";

export const generatorsTable = pgTable("generators", {
  id:                serial("id").primaryKey(),
  plantName:         text("plant_name").notNull(),
  operator:          text("operator"),
  assetClass:        text("asset_class").notNull(), // THERMAL | WIND | SOLAR | BATTERY | HYDRO
  technology:        text("technology").notNull(), // CCGT | CT | STEAM | WIND | PV | LI_ION | PUMPED_HYDRO
  fuelPrimary:       text("fuel_primary"), // NG | DFO | SUB | COAL | LIGNITE | SUN | WND
  nameplatemw:       numeric("nameplate_mw", { precision: 10, scale: 2 }).notNull(),
  summerCapacityMw:  numeric("summer_capacity_mw", { precision: 10, scale: 2 }),
  commissioningYear: integer("commissioning_year"),
  lat:               numeric("lat", { precision: 10, scale: 6 }),
  lng:               numeric("lng", { precision: 10, scale: 6 }),
  county:            text("county"),
  state:             text("state").default("TX"),
  iso:               text("iso").notNull(), // ERCOT | CAISO | PJM
  loadZone:          text("load_zone"),
  eiaPLantId:        integer("eia_plant_id"),
  eiaGeneratorId:    text("eia_generator_id"),
  status:            text("status").notNull().default("OPERATING"), // OPERATING | RETIRED | STANDBY
});

export const thermalParamsTable = pgTable("thermal_params", {
  id:                     serial("id").primaryKey(),
  generatorId:            integer("generator_id").notNull(),
  designHeatRate:         numeric("design_heat_rate", { precision: 8, scale: 3 }), // MMBtu/MWh
  minLoadMw:              numeric("min_load_mw", { precision: 10, scale: 2 }),
  maxLoadMw:              numeric("max_load_mw", { precision: 10, scale: 2 }),
  rampRateMwMin:          numeric("ramp_rate_mw_min", { precision: 8, scale: 2 }), // MW/minute
  rampRateEmergencyMwMin: numeric("ramp_rate_emergency_mw_min", { precision: 8, scale: 2 }),
  startupCostCold:        numeric("startup_cost_cold", { precision: 12, scale: 2 }), // $/start
  startupCostWarm:        numeric("startup_cost_warm", { precision: 12, scale: 2 }),
  startupCostHot:         numeric("startup_cost_hot", { precision: 12, scale: 2 }),
  startupTimeColdH:       numeric("startup_time_cold_h", { precision: 6, scale: 2 }), // hours
  vomPerMwh:              numeric("vom_per_mwh", { precision: 8, scale: 3 }), // $/MWh
  fuelHub:                text("fuel_hub"), // HENRY_HUB | WAHA | KATY | COAL_POWDER_RIVER
  co2RateTonsMwh:         numeric("co2_rate_tons_mwh", { precision: 8, scale: 4 }), // tons/MWh
  forcedOutageRate:       numeric("forced_outage_rate", { precision: 6, scale: 4 }), // 0.0–1.0
  plannedOutageDays:      integer("planned_outage_days"),
  impliedFuelCostPerMmb:  numeric("implied_fuel_cost_per_mmb", { precision: 8, scale: 4 }), // for non-gas (coal/lignite)
});

export type Generator = typeof generatorsTable.$inferSelect;
export type ThermalParam = typeof thermalParamsTable.$inferSelect;
