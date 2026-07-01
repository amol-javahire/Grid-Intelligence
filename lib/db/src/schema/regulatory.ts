import { pgTable, serial, text, varchar, date, timestamp } from "drizzle-orm/pg-core";

export const regulatoryItems = pgTable("regulatory_items", {
  id:            serial("id").primaryKey(),
  market:        varchar("market", { length: 10 }).notNull(),
  category:      varchar("category", { length: 30 }).notNull(),
  title:         text("title").notNull(),
  summary:       text("summary").notNull(),
  detail:        text("detail"),
  effectiveDate: date("effective_date"),
  announcedDate: date("announced_date"),
  status:        varchar("status", { length: 20 }).notNull(),
  impactLevel:   varchar("impact_level", { length: 10 }).notNull(),
  sourceUrl:     text("source_url"),
  sourceName:    text("source_name"),
  tags:          text("tags"),
  modelImpact:   text("model_impact"),
  scrapedAt:     timestamp("scraped_at", { withTimezone: true }).defaultNow(),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow(),
});
