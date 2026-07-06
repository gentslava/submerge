import type {
  ChannelMatcher,
  ChannelPolicy,
  Proxy as ProxyConfig,
  SubscriptionMeta,
} from "@submerge/shared";
import { DEFAULT_SPEED_POLICY } from "@submerge/shared";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// Source entries: subscription URLs, vless://, happ:// links, or client deep-links.
export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  // Canonical subscription identity: the decoded (happ) or extracted (deep-link)
  // sub URL; null for single-node kinds and inline subs. Needed for dedup — happ
  // crypt5 blobs are non-deterministic, so two different `value` strings can be
  // the same subscription.
  subUrl: text("sub_url"),
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
  // Subscription metadata (traffic/expiry/update interval) parsed from provider headers;
  // null for vless / metadata-less sources. The display name lives in `label`.
  meta: text("meta", { mode: "json" }).$type<SubscriptionMeta | null>(),
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

// Globally excluded nodes (deny-list): a node name here is dropped from the whole
// generated config — never defined, pinged, routed, or manually selected — while
// staying visible (idle, marked «исключён») in the UI so it can be re-included.
export const excludedNodes = sqliteTable("excluded_nodes", {
  name: text("name").primaryKey(),
});

// Routing channels: each binds a matcher + pool + policy. Phase 1 seeds exactly one
// non-deletable Default channel (is_default = true). policy/matcher are JSON blobs
// validated by the shared Zod schemas at the service boundary.
export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(), // "default" for the Default channel
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  policy: text("policy", { mode: "json" })
    .$type<ChannelPolicy>()
    .notNull()
    .$defaultFn(() => DEFAULT_SPEED_POLICY),
  matcher: text("matcher", { mode: "json" })
    .$type<ChannelMatcher>()
    .notNull()
    .$defaultFn(() => ({ presets: [], domains: [] })),
  lastReason: text("last_reason"),
  lastReasonAt: integer("last_reason_at"),
});

// Pool membership: which sources/nodes a channel is allowed to route through.
// Cascade-deletes with its channel; (channel_id, kind, ref) is unique to prevent
// duplicate members.
export const channelPool = sqliteTable(
  "channel_pool",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "source" | "node"
    ref: text("ref").notNull(),
  },
  (t) => [
    unique().on(t.channelId, t.kind, t.ref),
    index("channel_pool_channel_id_idx").on(t.channelId),
  ],
);
