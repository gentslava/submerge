import {
  type Channel,
  type ChannelPolicy,
  channelSchema,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_AUTO_TEST_URL,
  DEFAULT_SPEED_POLICY,
} from "@submerge/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { channels } from "../../db/schema.js";
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
      matcher: { presets: [], domains: [] },
    })
    .run();
}

// Read the Default row, validating the JSON policy/matcher. On a corrupt blob we
// fall back to the safe default rather than crashing the request path.
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
      matcher: { presets: [], domains: [] },
      lastReason: null,
      lastReasonAt: null,
    };
  }
  const parsed = channelSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled,
    isDefault: row.isDefault,
    policy: DEFAULT_SPEED_POLICY,
    matcher: { presets: [], domains: [] },
    lastReason: row.lastReason ?? null,
    lastReasonAt: row.lastReasonAt ?? null,
  };
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
