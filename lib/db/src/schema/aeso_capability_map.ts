import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aesoSubstationCapabilityTable = pgTable(
  "aeso_substation_capability",
  {
    id: serial("id").primaryKey(),
    facilityName: text("facility_name").notNull(),
    facilityCode: text("facility_code").notNull(),
    tfo: text("tfo"),
    planningAreaCode: integer("planning_area_code"),
    planningAreaName: text("planning_area_name"),
    busNumber: integer("bus_number").notNull(),
    voltageKv: integer("voltage_kv").notNull(),
    capabilityMw: numeric("capability_mw", { precision: 10, scale: 2 }).notNull(),
    sourceDocument: text("source_document").notNull(),
    asOfDate: date("as_of_date").notNull(),
  },
  (table) => [
    uniqueIndex("aeso_subcap_source_key").on(
      table.facilityCode,
      table.busNumber,
      table.voltageKv,
      table.asOfDate,
    ),
    index("aeso_subcap_area_idx").on(table.planningAreaCode),
  ],
);

export const aesoLineCapabilityTable = pgTable(
  "aeso_line_capability",
  {
    id: serial("id").primaryKey(),
    lineName: text("line_name").notNull(),
    voltageKv: integer("voltage_kv").notNull(),
    substationName: text("substation_name").notNull(),
    facilityCode: text("facility_code").notNull(),
    planningAreaCode: integer("planning_area_code"),
    planningAreaName: text("planning_area_name"),
    tfo: text("tfo"),
    capabilityMw: numeric("capability_mw", { precision: 10, scale: 2 }).notNull(),
    sourceDocument: text("source_document").notNull(),
    asOfDate: date("as_of_date").notNull(),
  },
  (table) => [
    uniqueIndex("aeso_linecap_source_key").on(table.lineName, table.facilityCode, table.asOfDate),
    index("aeso_linecap_area_idx").on(table.planningAreaCode),
  ],
);

export const aesoAssetAreaTable = pgTable(
  "aeso_asset_area",
  {
    id: serial("id").primaryKey(),
    assetId: text("asset_id").notNull(),
    assetName: text("asset_name").notNull(),
    capabilityChangeMw: numeric("capability_change_mw", { precision: 10, scale: 2 }).notNull(),
    planningAreaCode: integer("planning_area_code").notNull(),
    planningAreaName: text("planning_area_name").notNull(),
    region: text("region").notNull(),
    sourceDocument: text("source_document").notNull(),
    asOfDate: date("as_of_date").notNull(),
  },
  (table) => [
    uniqueIndex("aeso_asset_area_source_key").on(table.assetId, table.asOfDate),
    index("aeso_asset_area_planning_idx").on(table.planningAreaCode),
  ],
);

export const aesoPlanningAreasTable = pgTable(
  "aeso_planning_areas",
  {
    id: serial("id").primaryKey(),
    planningAreaCode: integer("planning_area_code").notNull(),
    planningAreaName: text("planning_area_name").notNull(),
    region: text("region").notNull(),
    sourceDocument: text("source_document").notNull(),
    asOfDate: date("as_of_date").notNull(),
  },
  (table) => [
    uniqueIndex("aeso_planning_area_source_key").on(table.planningAreaCode, table.asOfDate),
    index("aeso_planning_area_region_idx").on(table.region),
  ],
);

export const insertAesoSubstationCapabilitySchema = createInsertSchema(aesoSubstationCapabilityTable);
export type InsertAesoSubstationCapability = z.infer<typeof insertAesoSubstationCapabilitySchema>;
export type AesoSubstationCapability = typeof aesoSubstationCapabilityTable.$inferSelect;
