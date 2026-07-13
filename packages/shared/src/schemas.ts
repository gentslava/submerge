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
  // Global deny-list flag: true = dropped from the engine config (never routed/pinged),
  // shown greyed + «исключён» in the UI. Absent/false = a normal node.
  excluded: z.boolean().optional(),
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
export const selectNodeInput = z.object({ group: z.literal("PROXY"), name: z.string().min(1) });
export type SelectNodeInput = z.infer<typeof selectNodeInput>;
export const delayInput = z.object({ name: z.string().min(1) });
export type DelayInput = z.infer<typeof delayInput>;
export const setSettingInput = z.object({ key: z.string().min(1), value: z.string() });
export type SetSettingInput = z.infer<typeof setSettingInput>;
export const setExcludedInput = z.object({ name: z.string().min(1), excluded: z.boolean() });
export type SetExcludedInput = z.infer<typeof setExcludedInput>;

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

// Connections — a live row from mihomo /connections. `up`/`down` are CUMULATIVE
// bytes (the client derives per-connection speed by diffing consecutive polls).
export const connectionItemSchema = z.object({
  id: z.string(),
  source: z.string(), // process name if mihomo resolved it, else the client's source IP
  host: z.string(),
  destIp: z.string(),
  port: z.string(),
  network: z.enum(["tcp", "udp"]),
  node: z.string(), // the outbound proxy node (chains[0]); "" when unknown
  up: z.number(),
  down: z.number(),
  start: z.string(), // ISO timestamp — the client formats elapsed time
});
export type ConnectionItem = z.infer<typeof connectionItemSchema>;

export const connectionsViewSchema = z.object({
  connections: z.array(connectionItemSchema),
});
export type ConnectionsView = z.infer<typeof connectionsViewSchema>;

export const closeConnectionInput = z.object({ id: z.string().min(1) });
export type CloseConnectionInput = z.infer<typeof closeConnectionInput>;

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
  // How the "best" node is (re)picked. highest-bandwidth (Phase 4c) ranks by the
  // cached on-demand/passive throughput, falling back to fastest for uncached nodes.
  initialCriterion: z.enum(["fastest", "lowest-loss", "highest-bandwidth"]),
});

export const manualPolicySchema = z.object({
  kind: z.literal("manual"),
  pinnedNode: z.string().min(1),
  onFailure: z.enum(["hold", "fallback"]),
});

// Controller-driven (like sticky): picks the node with the best WINDOWED speed-vs-
// liveness score (EWMA effective latency = ewmaLatency / max(ewmaSuccess, ε)) instead of
// the instantaneous fastest. The switch margin is RELATIVE (a % of the current node's
// score) and the EWMA window is measured in samples — both constants, not per-policy
// knobs — so there's no `toleranceMs`. See docs/specs/2026-07-07-optimal-policy-design.md.
export const optimalPolicySchema = z.object({
  kind: z.literal("optimal"),
  testUrl: z.string().min(1),
  intervalSec: z.number().int().min(1),
});

export const channelPolicySchema = z.discriminatedUnion("kind", [
  speedPolicySchema,
  stickyPolicySchema,
  manualPolicySchema,
  optimalPolicySchema,
]);
export type ChannelPolicy = z.infer<typeof channelPolicySchema>;

// The mihomo rule-provider file `format`, derived from the URL extension rather
// than chosen by the admin — the format is a mechanical property of the file the
// URL points to (mihomo doesn't sniff it; it trusts the declared value, default
// yaml). `.list`/`.txt` → text, `.mrs` → mrs, everything else → yaml. Query/hash
// are stripped first.
export type RuleProviderFormat = "yaml" | "text" | "mrs";
export function ruleProviderFormat(url: string): RuleProviderFormat {
  const path = (url.split(/[?#]/)[0] ?? url).toLowerCase();
  if (path.endsWith(".mrs")) return "mrs";
  if (path.endsWith(".list") || path.endsWith(".txt")) return "text";
  return "yaml";
}

// A reference to an external mihomo rule-provider (Phase 4a). mihomo (not submerge)
// fetches the list; we only emit the `rule-providers:` entry + a `RULE-SET` rule.
// The list is identified by its URL; `format` is derived (see ruleProviderFormat),
// and config generation derives a stable, collision-safe internal name from
// (url, behavior). `mrs` is a binary format mihomo supports only for
// domain/ipcidr behaviors — never `classical` — so an `.mrs` URL with classical
// behavior is rejected here at parse time.
export const ruleProviderRefSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .refine((value) => /^https?:\/\//i.test(value), "must be an http(s) URL"),
    behavior: z.enum(["domain", "ipcidr", "classical"]),
  })
  .refine((r) => !(ruleProviderFormat(r.url) === "mrs" && r.behavior === "classical"), {
    message: "an .mrs list supports only domain/ipcidr behavior",
    path: ["behavior"],
  });
export type RuleProviderRef = z.infer<typeof ruleProviderRefSchema>;

const ruleProviderRefInputSchema = ruleProviderRefSchema.and(
  z.object({
    url: z
      .string()
      .trim()
      .min(1)
      .pipe(z.url())
      .refine((value) => /^https?:\/\//i.test(value), "must be a valid http(s) URL"),
  }),
);

export const channelMatcherSchema = z.object({
  presets: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  // Phase 4a — DOMAIN-KEYWORD tokens + external rule-providers. Additive with
  // empty defaults so legacy/Default rows parse unchanged.
  keywords: z.array(z.string()).default([]),
  ruleProviders: z.array(ruleProviderRefSchema).default([]),
  // Phase 4b — geo matchers: GEOSITE categories + GEOIP country codes. Permissive
  // in the read model (like domains/keywords); the write boundary is strict.
  geosite: z.array(z.string()).default([]),
  geoip: z.array(z.string()).default([]),
  // General IPv4/IPv6 CIDR matchers. The read model stays permissive so a
  // malformed legacy value does not make the whole channel unreadable.
  cidrs: z.array(z.string()).default([]),
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

// IPv4/IPv6 networks routed with mihomo IP-CIDR/IP-CIDR6 rules. The strict
// write boundary trims each value and requires an explicit, valid prefix.
const cidrV4Schema = z.cidrv4();
const cidrV6Schema = z.cidrv6();
const cidrSchema = z
  .string()
  .trim()
  .pipe(z.union([cidrV4Schema, cidrV6Schema]));
export function isValidCidr(value: string): boolean {
  return cidrSchema.safeParse(value).success;
}
export function cidrVersion(value: string): 4 | 6 | null {
  const result = cidrSchema.safeParse(value);
  if (!result.success) return null;
  return cidrV4Schema.safeParse(result.data).success ? 4 : 6;
}

// A DOMAIN-KEYWORD token (Phase 4a): a substring matched against the request
// host. Same write-boundary rationale as domainSchema — a comma/space/newline
// would produce a malformed mihomo rule and reject the whole config reload, so
// we forbid them here. Dots and hyphens are allowed (e.g. "double-click", "ad.").
const KEYWORD_RE = /^[A-Za-z0-9.-]+$/;
export const keywordSchema = z.string().trim().min(1).max(63).regex(KEYWORD_RE, "invalid keyword");
export function isValidKeyword(value: string): boolean {
  return keywordSchema.safeParse(value).success;
}

// Phase 4b geo matchers. A GEOSITE category is a lowercase token as published in
// MetaCubeX's geosite.dat (e.g. `youtube`, `telegram`, `category-ads-all`). A GEOIP
// code is an ISO-3166 alpha-2 country upper-cased (e.g. `RU`, `CN`), plus mihomo's
// special sets `LAN`/`PRIVATE`. Strict at the write boundary (a bad token would
// break the whole mihomo rule set), same as domains/keywords.
// Allow `!` and `@`: `geolocation-!cn` ("everything except CN") and `tag@attr`
// are common, config-safe geosite tags. Still block whitespace/comma/newline that
// would break the whole rule reload.
const GEOSITE_RE = /^[a-z0-9!@_-]+$/;
// ISO-3166 alpha-2 country codes, plus mihomo's special sets LAN / PRIVATE.
const GEOIP_RE = /^([A-Z]{2}|LAN|PRIVATE)$/;
export const geoCategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(GEOSITE_RE, "invalid geosite category");
export const geoCountrySchema = z.string().trim().regex(GEOIP_RE, "invalid geoip code");
export function isValidGeoCategory(value: string): boolean {
  return geoCategorySchema.safeParse(value).success;
}
export function isValidGeoCountry(value: string): boolean {
  return geoCountrySchema.safeParse(value).success;
}

// Strict INPUT matcher — used only by createChannelInput/updateChannelInput (the
// write boundary). channelMatcherSchema (the read model, used by channelSchema)
// intentionally stays permissive; see the comment on domainSchema above.
export const channelMatcherInputSchema = z.object({
  presets: z.array(z.string()).default([]),
  domains: z.array(domainSchema).default([]),
  keywords: z.array(keywordSchema).default([]),
  ruleProviders: z.array(ruleProviderRefInputSchema).default([]),
  geosite: z.array(geoCategorySchema).default([]),
  geoip: z.array(geoCountrySchema).default([]),
  cidrs: z.array(cidrSchema).default([]),
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

// Mihomo group names are a cross-package contract: the server emits these groups
// while the web excludes them from the pool picker as non-exit nodes.
export function channelGroupName(channel: Pick<Channel, "id" | "isDefault">): string {
  return channel.isDefault ? "AUTO" : `ch-${channel.id}`;
}

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
