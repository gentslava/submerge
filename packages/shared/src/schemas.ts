import { z } from "zod";

export const sourceKindSchema = z.enum(["sub", "vless", "happ"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

// mihomo proxy: pin only the required core fields, everything else passes through
// Zod 4: z.looseObject() replaces z.object().passthrough() / .loose()
export const proxySchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  server: z.string(),
  port: z.number(),
  uuid: z.string().optional(),
});
export type Proxy = z.infer<typeof proxySchema>;

// Subscription metadata parsed from the provider's HTTP response headers. All fields are
// optional — providers send some, none, or all. Bytes for traffic, unix seconds for
// expiry, hours for the suggested refresh interval.
export const subscriptionMetaSchema = z.object({
  used: z.number().nullable().default(null), // upload + download, bytes
  total: z.number().nullable().default(null), // bytes (null/0 = unlimited)
  expire: z.number().nullable().default(null), // unix seconds (null/0 = no expiry)
  updateHours: z.number().nullable().default(null), // provider's suggested refresh interval
});
export type SubscriptionMeta = z.infer<typeof subscriptionMetaSchema>;

export const sourceSchema = z.object({
  id: z.number().int(),
  kind: sourceKindSchema,
  value: z.string(),
  label: z.string(),
  hwid: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  proxies: z.array(proxySchema),
  // Subscription metadata (name lives in `label`); null for vless / metadata-less sources.
  meta: subscriptionMetaSchema.nullable().default(null),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

export const addSourceInput = z.object({
  value: z.string().min(1),
  hwid: z.boolean().default(false),
});
export type AddSourceInput = z.infer<typeof addSourceInput>;

// A member server inside a collapsed url-test node (view-only in v1).
export const nodeMemberSchema = z.object({
  name: z.string(),
  delay: z.number().nullable(),
  history: z.array(z.number()).default([]),
  active: z.boolean(), // true = the group's currently-routed member (`now`)
});
export type NodeMember = z.infer<typeof nodeMemberSchema>;

// A single node as shown in the UI: live "now"/delay come from mihomo, not the DB.
export const nodeItemSchema = z.object({
  name: z.string(),
  type: z.string(),
  delay: z.number().nullable(), // null = unreachable or not yet tested
  udp: z.boolean().optional(),
  // mihomo's recorded delay history (ms, oldest → newest; timeouts kept as 0 so the
  // chart can render them as instability) — drives the live latency chart.
  history: z.array(z.number()).default([]),
  // Present only for a collapsed group node: its member servers.
  members: z.array(nodeMemberSchema).optional(),
});
export type NodeItem = z.infer<typeof nodeItemSchema>;

// The PROXY select group: currently selected node + all selectable members.
export const nodeViewSchema = z.object({
  now: z.string().nullable(),
  // The node the AUTO (url-test) group currently resolves to, or null — lets the UI
  // show "выбран автоматически: X" and pin it when switching Авто → Ручной.
  autoNow: z.string().nullable(),
  all: z.array(nodeItemSchema),
});
export type NodeView = z.infer<typeof nodeViewSchema>;

// ── tRPC input schemas ────────────────────────────────────────────
export const idInput = z.object({ id: z.number().int() });
export type IdInput = z.infer<typeof idInput>;
export const reorderInput = z.object({ ids: z.array(z.number().int()) });
export type ReorderInput = z.infer<typeof reorderInput>;
export const selectNodeInput = z.object({ group: z.string().min(1), name: z.string().min(1) });
export type SelectNodeInput = z.infer<typeof selectNodeInput>;
export const delayInput = z.object({ name: z.string().min(1) });
export type DelayInput = z.infer<typeof delayInput>;
export const setSettingInput = z.object({ key: z.string().min(1), value: z.string() });
export type SetSettingInput = z.infer<typeof setSettingInput>;

// Live (SSE) — high-frequency traffic samples + the fan-out event union.
export const trafficSampleSchema = z.object({ up: z.number(), down: z.number() });
export type TrafficSample = z.infer<typeof trafficSampleSchema>;

export const liveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("nodeUpdate"), view: nodeViewSchema }),
  z.object({ type: z.literal("traffic"), up: z.number(), down: z.number() }),
  // Cumulative bytes received/sent since mihomo started (per-poll snapshot).
  z.object({ type: z.literal("totals"), up: z.number(), down: z.number() }),
  z.object({ type: z.literal("health"), mihomo: z.boolean() }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;

// Auth (Phase 5) — single-admin optional password.
export const loginInput = z.object({ password: z.string().min(1) });
export type LoginInput = z.infer<typeof loginInput>;

export const sessionStatusSchema = z.object({ authed: z.boolean(), required: z.boolean() });
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
