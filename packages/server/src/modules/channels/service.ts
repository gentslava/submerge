import {
  type Channel,
  type ChannelPolicy,
  type CreateChannelInput,
  channelMatcherSchema,
  channelPolicySchema,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_AUTO_TEST_URL,
  DEFAULT_SPEED_POLICY,
  type DirectChannel,
  directChannelSchema,
  directPresetSettingsSchema,
  emptyChannelMatcher,
  type ProxyChannel,
  proxyChannelSchema,
  type UpdateChannelInput,
  type UpdateDirectInput,
} from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { channelPool, channels } from "../../db/schema.js";
import { isExactIdPermutation } from "../../lib/ids.js";
import { getSetting } from "../settings/service.js";

export const DEFAULT_CHANNEL_ID = "default";
export const DIRECT_CHANNEL_ID = "direct";

const DEFAULT_DIRECT_PRESETS = { privateNetworks: true, localDomains: true } as const;

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function proxyName(name: string): string {
  const trimmed = name.trim();
  if (normalizedName(trimmed) === DIRECT_CHANNEL_ID) {
    badRequest("Direct is a reserved channel name");
  }
  return trimmed;
}

// Build the initial Default policy, carrying over any legacy `auto*` settings from
// the pre-channel model so an upgrade preserves the admin's tuning. A legacy
// non-url-test strategy (fallback/load-balance) has no speed equivalent and is
// dropped to `speed` — the admin can re-select sticky in Phase 2.
function seedPolicyFromLegacy(db: Db): ChannelPolicy {
  // DEFAULT_SPEED_POLICY is typed as the ChannelPolicy union at its declaration site
  // (shared contract with the web fallback), so narrow it here to access `speed`-only
  // fields — the literal is known to be `kind: "speed"` by construction.
  const defaults = DEFAULT_SPEED_POLICY as Extract<ChannelPolicy, { kind: "speed" }>;
  const url = getSetting(db, "autoTestUrl")?.trim();
  const interval = Number.parseInt(getSetting(db, "autoTestInterval") ?? "", 10);
  const tolerance = Number.parseInt(getSetting(db, "autoTestTolerance") ?? "", 10);
  const switchOnTimeout = getSetting(db, "autoSwitchOnTimeout");
  return {
    kind: "speed",
    testUrl: url && url.length > 0 ? url : defaults.testUrl,
    intervalSec: Number.isFinite(interval) && interval >= 1 ? interval : defaults.intervalSec,
    toleranceMs: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : defaults.toleranceMs,
    reevaluateWhileHealthy:
      switchOnTimeout == null ? defaults.reevaluateWhileHealthy : switchOnTimeout === "true",
  };
}

// Insert the Default channel if the table is empty. Idempotent — never overwrites.
export function ensureDefaultChannel(db: Db): void {
  const existing = db.select().from(channels).where(eq(channels.id, DEFAULT_CHANNEL_ID)).get();
  if (existing) return;
  db.insert(channels)
    .values({
      id: DEFAULT_CHANNEL_ID,
      name: "Default",
      target: "proxy",
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: seedPolicyFromLegacy(db),
      matcher: emptyChannelMatcher(),
    })
    .run();
}

// Ensure the one system Direct row exists without ever overwriting an existing
// valid row. Creation also repairs legacy priorities and reserves its name in a
// single transaction, so no caller can observe a half-initialized order.
export function ensureDirectChannel(db: Db): void {
  db.transaction((tx) => {
    const rows = tx.select().from(channels).orderBy(asc(channels.priority), asc(channels.id)).all();
    const directIdRow = rows.find((row) => row.id === DIRECT_CHANNEL_ID);
    if (directIdRow && directIdRow.target !== "direct") {
      throw new Error('Direct channel storage is corrupt: id "direct" must target direct');
    }

    const directRows = rows.filter((row) => row.target === "direct");
    if (directRows.length > 0) {
      const direct = directRows[0];
      if (
        directRows.length !== 1 ||
        direct?.id !== DIRECT_CHANNEL_ID ||
        direct.name !== "Direct" ||
        direct.isDefault
      ) {
        throw new Error("Direct channel storage is corrupt: target must use id/name direct/Direct");
      }
      return;
    }

    const occupiedNames = new Set(rows.map((row) => normalizedName(row.name)));
    let customNumber = 1;
    for (const row of rows) {
      if (row.target !== "proxy" || normalizedName(row.name) !== DIRECT_CHANNEL_ID) continue;
      let candidate = "Direct (custom)";
      while (occupiedNames.has(normalizedName(candidate))) {
        customNumber++;
        candidate = `Direct (custom ${customNumber})`;
      }
      tx.update(channels).set({ name: candidate }).where(eq(channels.id, row.id)).run();
      occupiedNames.add(normalizedName(candidate));
    }

    const nonDefault = rows.filter((row) => !row.isDefault);
    tx.insert(channels)
      .values({
        id: DIRECT_CHANNEL_ID,
        name: "Direct",
        target: "direct",
        priority: 0,
        enabled: true,
        isDefault: false,
        policy: null,
        matcher: emptyChannelMatcher(),
        directPresets: DEFAULT_DIRECT_PRESETS,
      })
      .run();
    nonDefault.forEach((row, index) => {
      tx.update(channels)
        .set({ priority: index + 1 })
        .where(eq(channels.id, row.id))
        .run();
    });
    const defaultRow = rows.find((row) => row.id === DEFAULT_CHANNEL_ID);
    if (defaultRow) {
      tx.update(channels)
        .set({ priority: nonDefault.length + 1 })
        .where(eq(channels.id, defaultRow.id))
        .run();
    }
  });
}

// Validate a raw row's JSON policy/matcher against the shared schema. On a corrupt
// blob we fall back to the safe default rather than crashing the request path.
function rowToChannel(row: typeof channels.$inferSelect): Channel {
  const matcher = channelMatcherSchema.safeParse(row.matcher);
  if (row.target === "direct") {
    const presets = directPresetSettingsSchema.safeParse(row.directPresets);
    return directChannelSchema.parse({
      id: row.id,
      name: row.name,
      target: "direct",
      priority: row.priority,
      enabled: row.enabled,
      isDefault: row.isDefault,
      matcher: matcher.success ? matcher.data : emptyChannelMatcher(),
      directPresets: presets.success ? presets.data : DEFAULT_DIRECT_PRESETS,
    });
  }
  const policy = channelPolicySchema.safeParse(row.policy);
  return proxyChannelSchema.parse({
    id: row.id,
    name: row.name,
    target: "proxy",
    priority: row.priority,
    enabled: row.enabled,
    isDefault: row.isDefault,
    policy: policy.success ? policy.data : DEFAULT_SPEED_POLICY,
    matcher: matcher.success ? matcher.data : emptyChannelMatcher(),
    lastReason: row.lastReason ?? null,
    lastReasonAt: row.lastReasonAt ?? null,
  });
}

// Read the Default row, validating the JSON policy/matcher. Synthesizes an in-memory
// Default when the row doesn't exist yet (before the first `ensureDefaultChannel`).
export function readDefaultChannel(db: Db): ProxyChannel {
  const row = db.select().from(channels).where(eq(channels.id, DEFAULT_CHANNEL_ID)).get();
  if (!row) {
    return {
      id: DEFAULT_CHANNEL_ID,
      name: "Default",
      target: "proxy",
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: DEFAULT_SPEED_POLICY,
      matcher: emptyChannelMatcher(),
      lastReason: null,
      lastReasonAt: null,
    };
  }
  const channel = rowToChannel(row);
  if (channel.target !== "proxy") {
    throw new Error("Default channel storage is corrupt: target must be proxy");
  }
  return channel;
}

export function readDefaultPolicy(db: Db): ChannelPolicy {
  return readDefaultChannel(db).policy;
}

export function setChannelPolicy(db: Db, id: string, policy: ChannelPolicy): void {
  requireProxyChannel(db, id, "Direct channel cannot use policy");
  db.update(channels).set({ policy }).where(eq(channels.id, id)).run();
}

// Persist the latest controller decision (Phase 2 writes this; the UI reads it).
export function setChannelLastReason(db: Db, id: string, reason: string, at: number): void {
  requireProxyChannel(db, id, "Direct channel cannot use controller state");
  db.update(channels)
    .set({ lastReason: reason, lastReasonAt: at })
    .where(eq(channels.id, id))
    .run();
}

// The health-check target + cadence for any policy. `manual` has no probe of its
// own, so it uses the built-in defaults.
export function policyProbe(policy: ChannelPolicy): { url: string; intervalSec: number } {
  if (policy.kind === "manual") {
    return { url: DEFAULT_AUTO_TEST_URL, intervalSec: DEFAULT_AUTO_TEST_INTERVAL };
  }
  return { url: policy.testUrl, intervalSec: policy.intervalSec };
}

// ── Channel CRUD (Phase 3a) ────────────────────────────────────────

// All channels, in match order: lower priority is tried first, Default (the
// catch-all) sorts last because `createChannel`/`reorderChannels` always keep its
// priority the highest. `id asc` only breaks ties between rows sharing a priority.
export function listChannels(db: Db): Channel[] {
  const rows = db.select().from(channels).orderBy(asc(channels.priority), asc(channels.id)).all();
  return rows.map(rowToChannel);
}

export function readChannel(db: Db, id: string): Channel | undefined {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  return row ? rowToChannel(row) : undefined;
}

function requireProxyChannel(db: Db, id: string, directMessage: string): void {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  if (row?.target === "direct") badRequest(directMessage);
}

// Next `ch<n>` id: one past the highest numeric suffix in use among non-default
// channels. Deterministic and gap-tolerant (survives deletes) — never Date.now()/
// Math.random(), so channel ids stay reproducible in tests.
function nextChannelId(rows: (typeof channels.$inferSelect)[]): string {
  let maxN = 0;
  for (const row of rows) {
    if (row.isDefault) continue;
    const match = /^ch(\d+)$/.exec(row.id);
    const n = match ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  return `ch${maxN + 1}`;
}

// Create a new, non-default channel at the end of the current matcher order.
// Re-pack the whole order in the same transaction so neither Direct nor Default
// can share a priority with the new row, even after importing legacy priorities.
export function createChannel(db: Db, input: CreateChannelInput): ProxyChannel {
  const name = proxyName(input.name);
  const id = db.transaction((tx) => {
    const rows = tx.select().from(channels).orderBy(asc(channels.priority), asc(channels.id)).all();
    const nextId = nextChannelId(rows);
    const nonDefault = rows.filter((row) => !row.isDefault);
    tx.insert(channels)
      .values({
        id: nextId,
        name,
        target: "proxy",
        priority: nonDefault.length,
        enabled: true,
        isDefault: false,
        policy: input.policy,
        matcher: input.matcher ?? emptyChannelMatcher(),
      })
      .run();
    nonDefault.forEach((row, index) => {
      tx.update(channels).set({ priority: index }).where(eq(channels.id, row.id)).run();
    });
    const defaultRow = rows.find((row) => row.isDefault);
    if (defaultRow) {
      tx.update(channels)
        .set({ priority: nonDefault.length + 1 })
        .where(eq(channels.id, defaultRow.id))
        .run();
    }
    return nextId;
  });
  // The just-inserted row is known to be a proxy, so this narrowing assertion is safe.
  return readChannel(db, id) as ProxyChannel;
}

export function updateChannel(
  db: Db,
  id: string,
  patch: Pick<UpdateChannelInput, "name" | "enabled" | "matcher">,
): void {
  requireProxyChannel(db, id, "Direct channel cannot use proxy update");
  const values: Partial<typeof channels.$inferInsert> = {};
  if (patch.name !== undefined) values.name = proxyName(patch.name);
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.matcher !== undefined) values.matcher = patch.matcher;
  if (Object.keys(values).length === 0) return;
  db.update(channels).set(values).where(eq(channels.id, id)).run();
}

export function updateDirect(db: Db, patch: UpdateDirectInput): DirectChannel {
  if (Object.keys(patch).length === 0) badRequest("At least one Direct field is required");
  db.transaction((tx) => {
    const row = tx.select().from(channels).where(eq(channels.id, DIRECT_CHANNEL_ID)).get();
    if (row?.target !== "direct") throw new Error("Direct channel is missing");
    const values: Partial<typeof channels.$inferInsert> = {};
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.matcher !== undefined) values.matcher = patch.matcher;
    if (patch.directPresets !== undefined) values.directPresets = patch.directPresets;
    tx.update(channels).set(values).where(eq(channels.id, DIRECT_CHANNEL_ID)).run();
  });
  const updated = readChannel(db, DIRECT_CHANNEL_ID);
  if (updated?.target !== "direct") throw new Error("Direct channel is missing");
  return updated;
}

// Refuses to delete the Default channel — it's the permanent catch-all and the
// UI must never offer this. `channelPool` rows cascade via the FK (foreign_keys
// is ON in db/client.ts), but we also delete them explicitly inside the same
// transaction as the channel row for clarity and to stay correct even if that
// pragma were ever off.
export function deleteChannel(db: Db, id: string): void {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!row) return;
  if (row.target === "direct") badRequest("Direct channel cannot be deleted");
  if (row.isDefault) throw new Error("cannot delete the Default channel");
  db.transaction((tx) => {
    tx.delete(channelPool).where(eq(channelPool.channelId, id)).run();
    tx.delete(channels).where(eq(channels.id, id)).run();
  });
}

// Assign priorities 0..N-1 to the given ids in order, then force Default to the
// highest priority so it always stays the catch-all — regardless of where (or
// whether) the caller placed it in `ids`.
export function reorderChannels(db: Db, ids: string[]): void {
  db.transaction((tx) => {
    const current = tx.select().from(channels).all();
    const defaultRow = current.find((channel) => channel.isDefault);
    const ordered = ids.filter((id) => id !== defaultRow?.id);
    const expectedIds = current
      .filter((channel) => !channel.isDefault)
      .map((channel) => channel.id);
    const defaultCount = defaultRow ? ids.filter((id) => id === defaultRow.id).length : 0;
    if (defaultCount > 1 || !isExactIdPermutation(ordered, expectedIds))
      throw new Error("complete channel order is required");

    ordered.forEach((id, index) => {
      tx.update(channels).set({ priority: index }).where(eq(channels.id, id)).run();
    });
    if (defaultRow) {
      tx.update(channels)
        .set({ priority: ordered.length })
        .where(eq(channels.id, defaultRow.id))
        .run();
    }
  });
}
