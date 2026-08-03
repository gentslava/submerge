import type {
  ChannelMatcher,
  ChannelPolicy,
  DirectPresetSettings,
  Proxy as ProxyConfig,
  SubscriptionMeta,
} from "@submerge/shared";
import { emptyChannelMatcher } from "@submerge/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  CandidateDecisionEvidenceSummary,
  CandidateDecisionReason,
} from "../modules/domain-intelligence/decision.js";
import {
  PROBE_CATEGORIES,
  type ProbeCategory,
} from "../modules/domain-intelligence/probe-category.js";

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
  // Auto-refresh state is persisted so restarts preserve both the provider schedule and
  // failure backoff. Millisecond epoch values match the rest of the runtime state.
  lastRefreshAttemptAt: integer("last_refresh_attempt_at"),
  lastRefreshSuccessAt: integer("last_refresh_success_at"),
  nextRefreshAttemptAt: integer("next_refresh_attempt_at"),
  refreshFailures: integer("refresh_failures").notNull().default(0),
  // Sanitized category only — never a provider URL, response body, or credential.
  lastRefreshError: text("last_refresh_error"),
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
export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(), // "default" for the Default channel
    name: text("name").notNull(),
    target: text("target", { enum: ["proxy", "direct"] })
      .notNull()
      .default("proxy"),
    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    policy: text("policy", { mode: "json" }).$type<ChannelPolicy | null>(),
    matcher: text("matcher", { mode: "json" })
      .$type<ChannelMatcher>()
      .notNull()
      .$defaultFn(emptyChannelMatcher),
    directPresets: text("direct_presets", { mode: "json" }).$type<DirectPresetSettings | null>(),
    lastReason: text("last_reason"),
    lastReasonAt: integer("last_reason_at"),
  },
  (t) => [
    check("channels_target_check", sql`${t.target} in ('proxy', 'direct')`),
    check(
      "channels_target_policy_check",
      sql`(${t.target} = 'proxy' and ${t.policy} is not null) or (${t.target} = 'direct' and ${t.policy} is null)`,
    ),
    check("channels_target_default_check", sql`${t.target} = 'proxy' or ${t.isDefault} = false`),
    check(
      "channels_target_presets_check",
      sql`(${t.target} = 'proxy' and ${t.directPresets} is null) or (${t.target} = 'direct' and ${t.directPresets} is not null)`,
    ),
    uniqueIndex("channels_direct_target_unique").on(t.target).where(sql`${t.target} = 'direct'`),
  ],
);

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

// Cached on-demand throughput per node (Phase 4c). Keyed by the node's display
// name; `mbps` is the last measured download speed, `tested_at` its epoch-ms
// timestamp. Feeds the `highest-bandwidth` sticky criterion + the UI's cached
// value. Best-effort cache — a node dropped from the config just goes stale.
export const nodeBandwidth = sqliteTable("node_bandwidth", {
  nodeName: text("node_name").primaryKey(),
  mbps: real("mbps").notNull(),
  testedAt: integer("tested_at").notNull(),
});

// Privacy-bounded destination observations. The canonical fingerprint excludes
// source type so one connection seen by both the log stream and /connections can
// reconcile without storing a client/connection identifier.
export const domainObservations = sqliteTable(
  "domain_observations",
  {
    fingerprint: text("fingerprint").primaryKey(),
    fqdn: text("fqdn").notNull(),
    observedAt: integer("observed_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    transport: text("transport", { enum: ["tcp", "udp"] }).notNull(),
    source: text("source", { enum: ["mihomo-log", "connection-snapshot"] }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [
    check("domain_observations_timestamp_check", sql`${t.observedAt} >= 0`),
    check("domain_observations_last_seen_check", sql`${t.lastSeenAt} >= ${t.observedAt}`),
    check("domain_observations_transport_check", sql`${t.transport} in ('tcp', 'udp')`),
    check(
      "domain_observations_source_check",
      sql`${t.source} in ('mihomo-log', 'connection-snapshot')`,
    ),
    check("domain_observations_count_check", sql`${t.count} >= 1`),
    index("domain_observations_reconcile_idx").on(t.fqdn, t.transport, t.observedAt, t.source),
    index("domain_observations_retention_idx").on(t.lastSeenAt),
  ],
);

// One aggregate row per normalized FQDN and UTC day. It contains no client
// dimensions, request payload, URL, or connection metadata.
export const domainDailyStats = sqliteTable(
  "domain_daily_stats",
  {
    day: text("day").notNull(),
    fqdn: text("fqdn").notNull(),
    connectionCount: integer("connection_count").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.fqdn] }),
    check("domain_daily_stats_count_check", sql`${t.connectionCount} >= 1`),
    check("domain_daily_stats_first_seen_check", sql`${t.firstSeenAt} >= 0`),
    check("domain_daily_stats_last_seen_check", sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
  ],
);

const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_DATE_SQL = sql.raw(String(MAX_DATE_MS));
const PROBE_CATEGORIES_SQL = sql.raw(PROBE_CATEGORIES.map((value) => `'${value}'`).join(", "));

// Persistent validation queue plus the admin's reversible review state. Only a
// candidate rederived from the current Never-add and scope policy is admitted;
// raw observations remain in their own tables.
export const domainCandidates = sqliteTable(
  "domain_candidates",
  {
    fqdn: text("fqdn").primaryKey(),
    registrableSite: text("registrable_site"),
    selectedScope: text("selected_scope", { enum: ["exact", "site"] }),
    proposedRule: text("proposed_rule"),
    exclusionReason: text("exclusion_reason", {
      enum: [
        "excluded-tld",
        "never-add-domain",
        "never-add-suffix",
        "telemetry-pattern",
        "invalid-policy",
      ],
    }),
    status: text("status", { enum: ["queued", "pending", "confirmed", "blocked", "excluded"] })
      .notNull()
      .default("queued"),
    reviewState: text("review_state", { enum: ["active", "rejected"] })
      .notNull()
      .default("active"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    nextValidationAt: integer("next_validation_at").notNull(),
    lastValidationAt: integer("last_validation_at"),
    failureStreak: integer("failure_streak").notNull().default(0),
    leaseId: text("lease_id"),
    leaseUntil: integer("lease_until"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check(
      "domain_candidates_status_check",
      sql`${t.status} in ('queued', 'pending', 'confirmed', 'blocked', 'excluded')`,
    ),
    check("domain_candidates_review_state_check", sql`${t.reviewState} in ('active', 'rejected')`),
    check("domain_candidates_fqdn_length_check", sql`length(${t.fqdn}) between 3 and 253`),
    check(
      "domain_candidates_site_length_check",
      sql`${t.registrableSite} is null or length(${t.registrableSite}) between 3 and 253`,
    ),
    check(
      "domain_candidates_rule_length_check",
      sql`${t.proposedRule} is null or length(${t.proposedRule}) between 3 and 255`,
    ),
    check(
      "domain_candidates_first_seen_check",
      sql`${t.firstSeenAt} between 0 and ${MAX_DATE_SQL}`,
    ),
    check(
      "domain_candidates_last_seen_check",
      sql`${t.lastSeenAt} between ${t.firstSeenAt} and ${MAX_DATE_SQL}`,
    ),
    check(
      "domain_candidates_next_validation_check",
      sql`${t.nextValidationAt} between 0 and ${MAX_DATE_SQL}`,
    ),
    check(
      "domain_candidates_last_validation_check",
      sql`${t.lastValidationAt} is null or ${t.lastValidationAt} between 0 and ${MAX_DATE_SQL}`,
    ),
    check("domain_candidates_failure_streak_check", sql`${t.failureStreak} between 0 and 1000000`),
    check(
      "domain_candidates_scope_check",
      sql`${t.selectedScope} is null or ${t.selectedScope} in ('exact', 'site')`,
    ),
    check(
      "domain_candidates_eligibility_check",
      sql`(${t.status} = 'excluded' and ${t.exclusionReason} in ('excluded-tld', 'never-add-domain', 'never-add-suffix', 'telemetry-pattern', 'invalid-policy') and ${t.selectedScope} is null and ${t.proposedRule} is null and ${t.leaseId} is null and ${t.leaseUntil} is null) or (${t.status} != 'excluded' and ${t.exclusionReason} is null and ${t.selectedScope} is not null and ${t.proposedRule} is not null)`,
    ),
    check(
      "domain_candidates_lease_pair_check",
      sql`(${t.leaseId} is null and ${t.leaseUntil} is null) or (${t.leaseId} is not null and length(${t.leaseId}) between 1 and 128 and ${t.leaseUntil} between 0 and ${MAX_DATE_SQL} and ${t.leaseGeneration} between 1 and 1000000000)`,
    ),
    check(
      "domain_candidates_lease_generation_check",
      sql`${t.leaseGeneration} between 0 and 1000000000`,
    ),
    check("domain_candidates_updated_check", sql`${t.updatedAt} between 0 and ${MAX_DATE_SQL}`),
    index("domain_candidates_due_idx").on(t.nextValidationAt, t.leaseUntil),
    index("domain_candidates_retention_idx").on(t.updatedAt),
  ],
);

export const DOMAIN_VALIDATION_RUN_ERROR_CATEGORIES = [
  "shutdown",
  "lease-lost",
  "coverage-failure",
  "direct-probe-failure",
  "proxy-probe-failure",
  "decision-failure",
  "policy-changed",
  "infrastructure-failure",
] as const;
export type DomainValidationRunErrorCategory =
  (typeof DOMAIN_VALIDATION_RUN_ERROR_CATEGORIES)[number];

export const domainValidationRuns = sqliteTable(
  "domain_validation_runs",
  {
    id: text("id").primaryKey(),
    leaseId: text("lease_id").notNull(),
    leaseGeneration: integer("lease_generation").notNull(),
    fqdn: text("fqdn")
      .notNull()
      .references(() => domainCandidates.fqdn, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text("status", { enum: ["running", "completed", "failed", "cancelled"] }).notNull(),
    errorCategory: text("error_category").$type<DomainValidationRunErrorCategory>(),
  },
  (t) => [
    check(
      "domain_validation_runs_status_check",
      sql`${t.status} in ('running', 'completed', 'failed', 'cancelled')`,
    ),
    check("domain_validation_runs_id_length_check", sql`length(${t.id}) between 1 and 128`),
    check(
      "domain_validation_runs_lease_id_length_check",
      sql`length(${t.leaseId}) between 1 and 128`,
    ),
    check(
      "domain_validation_runs_lease_generation_check",
      sql`${t.leaseGeneration} between 1 and 1000000000`,
    ),
    check("domain_validation_runs_fqdn_length_check", sql`length(${t.fqdn}) between 3 and 253`),
    check(
      "domain_validation_runs_started_check",
      sql`${t.startedAt} between 0 and ${MAX_DATE_SQL}`,
    ),
    check(
      "domain_validation_runs_finished_check",
      sql`(${t.status} = 'running' and ${t.finishedAt} is null) or (${t.status} != 'running' and ${t.finishedAt} is not null and ${t.finishedAt} between ${t.startedAt} and ${MAX_DATE_SQL})`,
    ),
    check(
      "domain_validation_runs_error_check",
      sql`(${t.status} in ('running', 'completed') and ${t.errorCategory} is null) or (${t.status} in ('failed', 'cancelled') and ${t.errorCategory} in ('shutdown', 'lease-lost', 'coverage-failure', 'direct-probe-failure', 'proxy-probe-failure', 'decision-failure', 'policy-changed', 'infrastructure-failure'))`,
    ),
    index("domain_validation_runs_fqdn_started_idx").on(t.fqdn, t.startedAt),
    index("domain_validation_runs_retention_idx").on(t.finishedAt, t.startedAt),
  ],
);

export const domainValidationAttempts = sqliteTable(
  "domain_validation_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => domainValidationRuns.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["direct", "proxy"] }).notNull(),
    attemptedAt: integer("attempted_at").notNull(),
    category: text("category").$type<ProbeCategory>().notNull(),
    transportSuccess: integer("transport_success", { mode: "boolean" }).notNull(),
    httpStatus: integer("http_status"),
    resolvedAddress: text("resolved_address"),
    availableAddressCount: integer("available_address_count").notNull(),
    connectDurationMs: integer("connect_duration_ms"),
    tlsDurationMs: integer("tls_duration_ms"),
    totalDurationMs: integer("total_duration_ms").notNull(),
    redirectCount: integer("redirect_count").notNull(),
    finalOrigin: text("final_origin"),
  },
  (t) => [
    unique().on(t.runId, t.direction),
    check("domain_validation_attempts_id_length_check", sql`length(${t.id}) between 1 and 128`),
    check(
      "domain_validation_attempts_run_id_length_check",
      sql`length(${t.runId}) between 1 and 128`,
    ),
    check("domain_validation_attempts_direction_check", sql`${t.direction} in ('direct', 'proxy')`),
    check(
      "domain_validation_attempts_category_check",
      sql`${t.category} in (${PROBE_CATEGORIES_SQL})`,
    ),
    check(
      "domain_validation_attempts_timestamp_check",
      sql`${t.attemptedAt} between 0 and ${MAX_DATE_SQL}`,
    ),
    check(
      "domain_validation_attempts_transport_success_check",
      sql`${t.transportSuccess} in (0, 1)`,
    ),
    check(
      "domain_validation_attempts_http_status_check",
      sql`${t.httpStatus} is null or (${t.httpStatus} >= 100 and ${t.httpStatus} <= 599)`,
    ),
    check(
      "domain_validation_attempts_address_count_check",
      sql`${t.availableAddressCount} between 0 and 1024 and (${t.resolvedAddress} is not null or ${t.availableAddressCount} = 0)`,
    ),
    check(
      "domain_validation_attempts_address_length_check",
      sql`${t.resolvedAddress} is null or length(${t.resolvedAddress}) between 2 and 45`,
    ),
    check(
      "domain_validation_attempts_connect_duration_check",
      sql`${t.connectDurationMs} is null or ${t.connectDurationMs} between 0 and 60000`,
    ),
    check(
      "domain_validation_attempts_tls_duration_check",
      sql`${t.tlsDurationMs} is null or ${t.tlsDurationMs} between 0 and 60000`,
    ),
    check(
      "domain_validation_attempts_total_duration_check",
      sql`${t.totalDurationMs} between 0 and 60000`,
    ),
    check(
      "domain_validation_attempts_redirect_count_check",
      sql`${t.redirectCount} between 0 and 5`,
    ),
    check(
      "domain_validation_attempts_final_origin_length_check",
      sql`${t.finalOrigin} is null or length(${t.finalOrigin}) between 9 and 2048`,
    ),
    check(
      "domain_validation_attempts_result_shape_check",
      sql`(${t.category} = 'http_response' and ${t.transportSuccess} = 1 and ${t.httpStatus} is not null) or (${t.category} != 'http_response' and ${t.transportSuccess} = 0)`,
    ),
    index("domain_validation_attempts_run_idx").on(t.runId),
    index("domain_validation_attempts_retention_idx").on(t.attemptedAt),
  ],
);

export type DomainDecisionEvidenceJson = CandidateDecisionEvidenceSummary;

export const domainDecisions = sqliteTable(
  "domain_decisions",
  {
    id: text("id").primaryKey(),
    fqdn: text("fqdn")
      .notNull()
      .references(() => domainCandidates.fqdn, { onDelete: "cascade" }),
    evaluatedAt: integer("evaluated_at").notNull(),
    status: text("status", { enum: ["confirmed", "pending", "blocked"] }).notNull(),
    confidence: text("confidence", { enum: ["none", "low", "high"] }).notNull(),
    reasons: text("reasons", { mode: "json" }).$type<CandidateDecisionReason[]>().notNull(),
    windowStart: integer("window_start"),
    evidence: text("evidence", { mode: "json" }).$type<DomainDecisionEvidenceJson>().notNull(),
    selectedScope: text("selected_scope", { enum: ["exact", "site"] }),
    proposedRule: text("proposed_rule"),
  },
  (t) => [
    check("domain_decisions_status_check", sql`${t.status} in ('confirmed', 'pending', 'blocked')`),
    check("domain_decisions_id_length_check", sql`length(${t.id}) between 1 and 128`),
    check("domain_decisions_fqdn_length_check", sql`length(${t.fqdn}) between 3 and 253`),
    check("domain_decisions_evaluated_check", sql`${t.evaluatedAt} between 0 and ${MAX_DATE_SQL}`),
    check(
      "domain_decisions_confidence_check",
      sql`(${t.status} = 'confirmed' and ${t.confidence} = 'high') or (${t.status} = 'pending' and ${t.confidence} = 'low') or (${t.status} = 'blocked' and ${t.confidence} = 'none')`,
    ),
    check(
      "domain_decisions_window_check",
      sql`${t.windowStart} is null or ${t.windowStart} between 0 and ${t.evaluatedAt}`,
    ),
    check(
      "domain_decisions_scope_pair_check",
      sql`(${t.selectedScope} is null and ${t.proposedRule} is null) or (${t.selectedScope} is not null and ${t.proposedRule} is not null)`,
    ),
    check(
      "domain_decisions_scope_check",
      sql`${t.selectedScope} is null or ${t.selectedScope} in ('exact', 'site')`,
    ),
    check(
      "domain_decisions_rule_length_check",
      sql`${t.proposedRule} is null or length(${t.proposedRule}) between 3 and 255`,
    ),
    check("domain_decisions_reasons_length_check", sql`length(${t.reasons}) between 2 and 1024`),
    check("domain_decisions_evidence_length_check", sql`length(${t.evidence}) between 2 and 2048`),
    index("domain_decisions_fqdn_evaluated_idx").on(t.fqdn, t.evaluatedAt),
    index("domain_decisions_retention_idx").on(t.evaluatedAt),
  ],
);
