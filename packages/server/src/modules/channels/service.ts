import {
  type Channel,
  type ChannelPolicy,
  type CreateChannelInput,
  channelSchema,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_AUTO_TEST_URL,
  DEFAULT_SPEED_POLICY,
  emptyChannelMatcher,
  type UpdateChannelInput,
} from "@submerge/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { channelPool, channels } from "../../db/schema.js";
import { getSetting } from "../settings/service.js";

export const DEFAULT_CHANNEL_ID = "default";

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
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: seedPolicyFromLegacy(db),
      matcher: emptyChannelMatcher(),
    })
    .run();
}

// Validate a raw row's JSON policy/matcher against the shared schema. On a corrupt
// blob we fall back to the safe default rather than crashing the request path.
function rowToChannel(row: typeof channels.$inferSelect): Channel {
  const parsed = channelSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled,
    isDefault: row.isDefault,
    policy: DEFAULT_SPEED_POLICY,
    matcher: emptyChannelMatcher(),
    lastReason: row.lastReason ?? null,
    lastReasonAt: row.lastReasonAt ?? null,
  };
}

// Read the Default row, validating the JSON policy/matcher. Synthesizes an in-memory
// Default when the row doesn't exist yet (before the first `ensureDefaultChannel`).
export function readDefaultChannel(db: Db): Channel {
  const row = db.select().from(channels).where(eq(channels.id, DEFAULT_CHANNEL_ID)).get();
  if (!row) {
    return {
      id: DEFAULT_CHANNEL_ID,
      name: "Default",
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: DEFAULT_SPEED_POLICY,
      matcher: emptyChannelMatcher(),
      lastReason: null,
      lastReasonAt: null,
    };
  }
  return rowToChannel(row);
}

export function readDefaultPolicy(db: Db): ChannelPolicy {
  return readDefaultChannel(db).policy;
}

export function setChannelPolicy(db: Db, id: string, policy: ChannelPolicy): void {
  db.update(channels).set({ policy }).where(eq(channels.id, id)).run();
}

// Persist the latest controller decision (Phase 2 writes this; the UI reads it).
export function setChannelLastReason(db: Db, id: string, reason: string, at: number): void {
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

// Create a new, non-default channel. It's inserted one priority step ahead of
// Default so it's matched before the catch-all; Default itself is untouched here
// — `reorderChannels` is what re-packs priorities when the admin reorders the list.
export function createChannel(db: Db, input: CreateChannelInput): Channel {
  const rows = db.select().from(channels).all();
  const id = nextChannelId(rows);
  const defaultPriority = rows.find((row) => row.isDefault)?.priority ?? 0;
  db.insert(channels)
    .values({
      id,
      name: input.name,
      priority: defaultPriority - 1,
      enabled: true,
      isDefault: false,
      policy: input.policy,
      matcher: input.matcher ?? emptyChannelMatcher(),
    })
    .run();
  // Just-inserted row is always readable back — non-null assertion is safe here.
  return readChannel(db, id) as Channel;
}

export function updateChannel(
  db: Db,
  id: string,
  patch: Pick<UpdateChannelInput, "name" | "enabled" | "matcher">,
): void {
  const values: Partial<typeof channels.$inferInsert> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.enabled !== undefined) values.enabled = patch.enabled;
  if (patch.matcher !== undefined) values.matcher = patch.matcher;
  if (Object.keys(values).length === 0) return;
  db.update(channels).set(values).where(eq(channels.id, id)).run();
}

// Refuses to delete the Default channel — it's the permanent catch-all and the
// UI must never offer this. `channelPool` rows cascade via the FK (foreign_keys
// is ON in db/client.ts), but we also delete them explicitly inside the same
// transaction as the channel row for clarity and to stay correct even if that
// pragma were ever off.
export function deleteChannel(db: Db, id: string): void {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!row) return;
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
    const defaultRow = tx.select().from(channels).where(eq(channels.isDefault, true)).get();
    const ordered = ids.filter((id) => id !== defaultRow?.id);
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
