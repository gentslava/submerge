import { z } from "zod";

export const sourceKindSchema = z.enum([
  "sub",
  "happ",
  "vless",
  "hysteria2",
  "vmess",
  "trojan",
  "ss",
  "tuic",
  "wireguard",
  "amneziawg",
]);
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
  // Transport + security, joined from the stored ProxyConfig (mihomo's /proxies
  // doesn't expose them). Drive the node's second badge — "VLESS · Reality" /
  // "· WS" / "· TCP" — instead of the meaningless, uniform "· UDP" flag.
  network: z.string().optional(), // mihomo transport: tcp | ws | grpc | http | xhttp
  security: z.enum(["reality", "tls", "none", "amneziawg"]).optional(),
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

// ── Channels (routing) ────────────────────────────────────────────
// A channel binds { matcher, pool, policy }. Phase 1 ships only the Default
// channel with the `speed` policy; sticky/manual are contract-complete here but
// wired end-to-end in Phase 2. The policy is a discriminated union stored as JSON.

export const speedPolicySchema = z.object({
  kind: z.literal("speed"),
  testUrl: z.string().min(1),
  intervalSec: z.number().int().min(1), // seconds between mihomo re-tests
  toleranceMs: z.number().int().min(0), // latency hysteresis before switching
  // Re-evaluate the group every interval even while the current node is healthy.
  // Maps to mihomo `lazy = !reevaluateWhileHealthy`. (Replaces the old, mislabelled
  // `switchOnTimeout`.)
  reevaluateWhileHealthy: z.boolean(),
});

export const stickyPolicySchema = z.object({
  kind: z.literal("sticky"),
  testUrl: z.string().min(1),
  intervalSec: z.number().int().min(1),
  failureThreshold: z.number().int().min(1), // consecutive fails before switching
  maxHoldHours: z.number().int().min(1).nullable(), // null = hold indefinitely
  initialCriterion: z.enum(["fastest", "lowest-loss"]), // highest-bandwidth: phase 4
});

export const manualPolicySchema = z.object({
  kind: z.literal("manual"),
  pinnedNode: z.string().min(1),
  onFailure: z.enum(["hold", "fallback"]),
});

export const channelPolicySchema = z.discriminatedUnion("kind", [
  speedPolicySchema,
  stickyPolicySchema,
  manualPolicySchema,
]);
export type ChannelPolicy = z.infer<typeof channelPolicySchema>;

export const channelMatcherSchema = z.object({
  presets: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
});
export type ChannelMatcher = z.infer<typeof channelMatcherSchema>;

// A routing domain for DOMAIN-SUFFIX: hostname labels ([A-Za-z0-9-], not
// hyphen-bookended) joined by dots, max 253 chars. Deliberately strict — a
// domain containing a comma, space, or newline produces a malformed mihomo rule
// and makes the engine reject the ENTIRE config reload, not just that rule. So
// bad domains are blocked here, at the write boundary. The read model
// (channelMatcherSchema) stays permissive so a legacy/corrupt row can't wipe a
// whole channel on load (rowToChannel falls back to an empty matcher on parse fail).
const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
export const domainSchema = z.string().trim().min(1).max(253).regex(DOMAIN_RE, "invalid domain");
export function isValidDomain(value: string): boolean {
  return domainSchema.safeParse(value).success;
}

// Strict INPUT matcher — used only by createChannelInput/updateChannelInput (the
// write boundary). channelMatcherSchema (the read model, used by channelSchema)
// intentionally stays permissive; see the comment on domainSchema above.
export const channelMatcherInputSchema = z.object({
  presets: z.array(z.string()).default([]),
  domains: z.array(domainSchema).default([]),
});

export const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  policy: channelPolicySchema,
  matcher: channelMatcherSchema,
  lastReason: z.string().nullable(),
  lastReasonAt: z.number().nullable(), // epoch ms of the last controller decision
});
export type Channel = z.infer<typeof channelSchema>;

export const setChannelPolicyInput = z.object({
  id: z.string().min(1),
  policy: channelPolicySchema,
});
export type SetChannelPolicyInput = z.infer<typeof setChannelPolicyInput>;

// ── Channel CRUD + pool (Phase 3a) ────────────────────────────────
// The pool is the set of sources/nodes a channel is allowed to route through,
// stored separately from the channel row (join table) and surfaced as an
// ordered list of typed refs.
export const channelPoolMemberSchema = z.object({
  kind: z.enum(["source", "node"]),
  ref: z.string().min(1),
});
export type ChannelPoolMember = z.infer<typeof channelPoolMemberSchema>;

export const createChannelInput = z.object({
  name: z.string().min(1),
  policy: channelPolicySchema,
  matcher: channelMatcherInputSchema.optional(),
});
export type CreateChannelInput = z.infer<typeof createChannelInput>;

export const updateChannelInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  matcher: channelMatcherInputSchema.optional(),
});
export type UpdateChannelInput = z.infer<typeof updateChannelInput>;

// Shared "just an id" input, reused by deleteChannelInput and by getPool (which
// isn't a delete — see router.ts).
export const channelIdInput = z.object({ id: z.string().min(1) });
export type ChannelIdInput = z.infer<typeof channelIdInput>;

export const deleteChannelInput = channelIdInput;
export type DeleteChannelInput = z.infer<typeof deleteChannelInput>;

// New priority order for all channels; the Default channel is forced last
// server-side regardless of its position here.
export const reorderChannelsInput = z.object({ ids: z.array(z.string().min(1)) });
export type ReorderChannelsInput = z.infer<typeof reorderChannelsInput>;

export const setChannelPoolInput = z.object({
  id: z.string().min(1),
  members: z.array(channelPoolMemberSchema),
});
export type SetChannelPoolInput = z.infer<typeof setChannelPoolInput>;

export const channelWithPoolSchema = channelSchema.extend({
  pool: z.array(channelPoolMemberSchema),
});
export type ChannelWithPool = z.infer<typeof channelWithPoolSchema>;

// A single controller decision, surfaced in the UI ("why did it switch?").
export const decisionEntrySchema = z.object({
  at: z.number(), // epoch ms
  channelId: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string(),
});
export type DecisionEntry = z.infer<typeof decisionEntrySchema>;
