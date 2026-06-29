import type { Proxy as ProxyConfig } from "@submerge/shared";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Source entries: subscription URLs, vless://, happ:// links, or client deep-links.
export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  label: text("label").notNull(),
  // X-Hwid flag: device-bound providers require hardware ID header.
  hwid: integer("hwid", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  // Snapshot of the full proxy objects parsed from this source (used to generate
  // the mihomo config without re-fetching). $defaultFn avoids double-encoding:
  // mode:"json" applies JSON.stringify, so the JS-level default must be an array.
  proxies: text("proxies", { mode: "json" })
    .$type<ProxyConfig[]>()
    .notNull()
    .$defaultFn(() => []),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

// Key-value store for application settings (e.g., admin password hash, active node).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Session tokens for the optional admin password auth flow.
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});
