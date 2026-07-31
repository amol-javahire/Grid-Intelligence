import { pgTable, serial, text, numeric, date, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Inventory of Major Alberta Projects — Government of Alberta.
 *
 * Every private- and public-sector project in Alberta valued at C$5M or more
 * that has recently completed, is under construction, or is expected to start
 * construction within two years.
 *
 * Source:  https://majorprojects.alberta.ca/
 * Data:    https://open.alberta.ca/opendata/inventory-of-major-alberta-projects
 * Licence: Open Government Licence – Alberta
 *
 * Complements aeso_queue_projects rather than duplicating it. The AESO
 * Connection Project List has MW and interconnection status but no capital
 * cost; this has capital cost, developer, municipality and construction stage
 * but no MW. Projects appear in both — join on name is fuzzy and unreliable,
 * so they are deliberately kept as separate tables and separate sub-tabs.
 *
 * costMillions is stored as published (C$ millions). AESO publishes nothing
 * comparable, so this is the only capital-cost signal in the platform.
 */
export const albertaMajorProjectsTable = pgTable("alberta_major_projects", {
  id: serial("id").primaryKey(),
  projectName: text("project_name").notNull(),
  municipality: text("municipality"),
  region: text("region"),
  sector: text("sector"),
  projectType: text("project_type"),
  stage: text("stage"),
  status: text("status"),
  costMillions: numeric("cost_millions", { precision: 14, scale: 2 }),
  developer: text("developer"),
  startDate: date("start_date"),
  completionDate: date("completion_date"),
  lat: numeric("lat", { precision: 10, scale: 6 }),
  lng: numeric("lng", { precision: 10, scale: 6 }),
  // True when sector/type indicates electricity generation, storage,
  // transmission or a data centre — the subset relevant to origination.
  isPowerRelated: text("is_power_related"),
  sourceUpdated: date("source_updated"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("alberta_major_projects_sector_idx").on(t.sector),
  index("alberta_major_projects_stage_idx").on(t.stage),
]);

export const insertAlbertaMajorProjectSchema =
  createInsertSchema(albertaMajorProjectsTable).omit({ id: true, createdAt: true });
export type InsertAlbertaMajorProject = z.infer<typeof insertAlbertaMajorProjectSchema>;
export type AlbertaMajorProject = typeof albertaMajorProjectsTable.$inferSelect;
