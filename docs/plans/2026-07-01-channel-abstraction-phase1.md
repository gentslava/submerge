# Channel Abstraction (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single opaque `AUTO` group model with a persisted **Channel** abstraction carrying an explicit **policy**, seeded with one non-deletable **Default** channel using the `speed` policy — behaviour-preserving, with honest settings labels.

**Architecture:** Add a `channels` table with one Default row whose `policy` is a JSON discriminated union (`speed` | `sticky` | `manual`); Phase 1 wires only `speed` end-to-end. `buildConfig` takes a `ChannelPolicy` instead of the old `AutoConfig` and emits the identical mihomo config for `speed`. The confusing `switchOnTimeout` setting becomes `reevaluateWhileHealthy` (maps to mihomo `lazy = !reevaluateWhileHealthy`). Legacy `auto*` settings are migrated into the Default channel on first boot.

**Tech Stack:** Node 24, strict TypeScript (ESM, `verbatimModuleSyntax`), tRPC v11, Drizzle ORM + better-sqlite3, Zod 4, Vitest, React 19 + shadcn/ui. Biome for lint/format.

## Global Constraints

- **Language:** all code, comments, commit messages in **English**. UI-facing strings stay Russian (no i18n).
- **Validation:** Zod at boundaries; external responses `.parse()`d. Zod 4 idioms (`z.looseObject`, `z.discriminatedUnion`).
- **Strict TS:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESM `.js` import specifiers in server source.
- **Naming:** camelCase (TS), kebab-case (files), snake_case (DB columns, mapped in `schema.ts`).
- **Boundaries:** mihomo/happ-decoder only via `packages/server/src/clients/*`.
- **No new heavy deps** (ADR-0004): no Postgres/GraphQL/DI. Reuse existing patterns.
- **Self-verify gate before every commit:** `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` green (use **raw biome**, not `pnpm lint`).
- **Commit trailer:** end each commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Behaviour-preserving:** for a `speed` policy whose params equal today's defaults, the generated `config.yaml` must be byte-identical to the pre-change output (except the internal field rename, which is not serialized).

---

## File Structure

**Create:**
- `packages/server/src/modules/channels/service.ts` — channel persistence + policy read/seed/migrate helpers.
- `packages/server/src/modules/channels/service.test.ts` — unit tests for the above.
- `packages/server/src/modules/channels/router.ts` — tRPC `channels` router (`get`, `setPolicy`).
- `packages/server/drizzle/0002_channels.sql` — migration creating the `channels` table (generated).

**Modify:**
- `packages/shared/src/schemas.ts` — add channel policy/channel schemas + `setChannelPolicyInput`.
- `packages/shared/src/defaults.ts` — add `DEFAULT_SPEED_POLICY`; keep existing constants as its building blocks.
- `packages/server/src/db/schema.ts` — add the `channels` table.
- `packages/server/src/modules/nodes/config.ts` — `buildConfig(proxies, policy, secret)`; `speed` path; field rename.
- `packages/server/src/modules/nodes/config.test.ts` — update call sites + assertions for the rename.
- `packages/server/src/modules/nodes/service.ts` — `applyConfig` reads the Default channel policy; drop `readAutoConfig`.
- `packages/server/src/modules/nodes/router.ts` — `delay` uses `policyProbe(...)`.
- `packages/server/src/live/singleton.ts` — active-node probe uses `policyProbe(...)`.
- `packages/server/src/modules/settings/router.ts` — drop the `auto*` reload branch (channels own reload now).
- `packages/server/src/trpc/router.ts` — register `channelsRouter`.
- `packages/server/src/index.ts` — call `ensureDefaultChannel(db)` at boot (after migrations).
- `packages/web/src/features/nodes/AutoStrategyCard.tsx` — relabel; read from channel policy shape.
- `packages/web/src/features/settings/SettingsScreen.tsx` — bind the auto-select card to `channels.get` / `channels.setPolicy`.

**Note (YAGNI):** the `channel_pool` table and multi-channel `rules` from the spec are **not** in this plan — with only a Default channel the pool is "all nodes" and routing stays `MATCH,PROXY`. They arrive in Phase 3.

---

### Task 1: Shared contract — channel policy & channel schemas

**Files:**
- Modify: `packages/shared/src/defaults.ts`
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.test.ts`

**Interfaces:**
- Produces: `ChannelPolicy` (`{kind:'speed',testUrl,intervalSec,toleranceMs,reevaluateWhileHealthy}` | `{kind:'sticky',testUrl,intervalSec,failureThreshold,maxHoldHours,initialCriterion}` | `{kind:'manual',pinnedNode,onFailure}`), `Channel`, `channelPolicySchema`, `channelSchema`, `setChannelPolicyInput`, `DEFAULT_SPEED_POLICY`.

- [ ] **Step 1: Add the default speed policy to `defaults.ts`**

Append to `packages/shared/src/defaults.ts` (keep the existing `DEFAULT_AUTO_*` constants — they seed the object):

```ts
import type { ChannelPolicy } from "./schemas.js";

/** The Default channel's policy on a fresh install (behaviour-preserving vs the old AUTO url-test). */
export const DEFAULT_SPEED_POLICY: ChannelPolicy = {
  kind: "speed",
  testUrl: DEFAULT_AUTO_TEST_URL,
  intervalSec: DEFAULT_AUTO_TEST_INTERVAL,
  toleranceMs: DEFAULT_AUTO_TOLERANCE,
  // The old `switchOnTimeout: true` meant mihomo `lazy: false` = always re-evaluate.
  reevaluateWhileHealthy: DEFAULT_AUTO_SWITCH_ON_TIMEOUT,
};
```

- [ ] **Step 2: Write failing tests for the policy schemas**

Append to `packages/shared/src/schemas.test.ts`:

```ts
import {
  channelPolicySchema,
  channelSchema,
  setChannelPolicyInput,
} from "./schemas.js";

describe("channelPolicySchema", () => {
  it("accepts a speed policy", () => {
    const p = channelPolicySchema.parse({
      kind: "speed",
      testUrl: "https://x/generate_204",
      intervalSec: 300,
      toleranceMs: 50,
      reevaluateWhileHealthy: true,
    });
    expect(p.kind).toBe("speed");
  });
  it("accepts a sticky policy with null maxHoldHours", () => {
    const p = channelPolicySchema.parse({
      kind: "sticky",
      testUrl: "https://x/generate_204",
      intervalSec: 60,
      failureThreshold: 3,
      maxHoldHours: null,
      initialCriterion: "fastest",
    });
    expect(p.kind === "sticky" && p.maxHoldHours).toBeNull();
  });
  it("rejects an unknown kind", () => {
    expect(() => channelPolicySchema.parse({ kind: "nope" })).toThrow();
  });
  it("rejects intervalSec below 1", () => {
    expect(() =>
      channelPolicySchema.parse({
        kind: "speed",
        testUrl: "u",
        intervalSec: 0,
        toleranceMs: 0,
        reevaluateWhileHealthy: false,
      }),
    ).toThrow();
  });
});

describe("channelSchema", () => {
  it("parses a default channel row", () => {
    const c = channelSchema.parse({
      id: "default",
      name: "Default",
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: {
        kind: "speed",
        testUrl: "u",
        intervalSec: 300,
        toleranceMs: 50,
        reevaluateWhileHealthy: true,
      },
      matcher: { presets: [], domains: [] },
      lastReason: null,
      lastReasonAt: null,
    });
    expect(c.isDefault).toBe(true);
  });
});

describe("setChannelPolicyInput", () => {
  it("requires id and a valid policy", () => {
    expect(() => setChannelPolicyInput.parse({ id: "", policy: {} })).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm -F @submerge/shared test`
Expected: FAIL — `channelPolicySchema`/`channelSchema`/`setChannelPolicyInput` are not exported.

- [ ] **Step 4: Implement the schemas in `schemas.ts`**

Append to `packages/shared/src/schemas.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -F @submerge/shared test`
Expected: PASS (all channel tests green; existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts packages/shared/src/defaults.ts
git commit -m "feat(shared): channel policy & channel schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `channels` table + migration

**Files:**
- Modify: `packages/server/src/db/schema.ts`
- Create: `packages/server/drizzle/0002_channels.sql` (generated)
- Test: `packages/server/src/db/client.test.ts` (extend)

**Interfaces:**
- Produces: Drizzle `channels` table with columns `id, name, priority, enabled, is_default, policy(json), matcher(json), last_reason, last_reason_at`.

- [ ] **Step 1: Add the table to `schema.ts`**

Add the import at the top of `packages/server/src/db/schema.ts` (extend the existing shared import):

```ts
import type { Channel, ChannelMatcher, ChannelPolicy, Proxy as ProxyConfig, SubscriptionMeta } from "@submerge/shared";
import { DEFAULT_SPEED_POLICY } from "@submerge/shared";
```

Append the table after `sessions`:

```ts
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
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm -F @submerge/server db:generate`
Expected: a new file `packages/server/drizzle/0002_channels.sql` containing `CREATE TABLE \`channels\` (...)`. Verify it lists all columns and `is_default` / `last_reason` / `last_reason_at`.

- [ ] **Step 3: Write a failing test that the migration creates the table**

Extend `packages/server/src/db/client.test.ts` with:

```ts
import { channels } from "./schema.js";
// ...
it("has a channels table after migrations", () => {
  const testDb = createDb(":memory:");
  // Apply migrations against the in-memory db the same way runMigrations does.
  migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  expect(() => testDb.select().from(channels).all()).not.toThrow();
});
```

Add the imports the test needs at the top of the file if missing:

```ts
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @submerge/server test src/db/client.test.ts`
Expected: PASS (the generated migration creates the table).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/drizzle/ packages/server/src/db/client.test.ts
git commit -m "feat(server): channels table + migration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Channel service — seed, read, migrate legacy, update

**Files:**
- Create: `packages/server/src/modules/channels/service.ts`
- Test: `packages/server/src/modules/channels/service.test.ts`

**Interfaces:**
- Consumes: `db` (`Db`), `channels` table, `getSetting` from settings service, `DEFAULT_SPEED_POLICY`, `channelPolicySchema`, `Channel`, `ChannelPolicy`.
- Produces:
  - `ensureDefaultChannel(db: Db): void` — inserts the Default row if absent, migrating legacy `auto*` settings into its `speed` policy.
  - `readDefaultChannel(db: Db): Channel` — the Default row, policy parsed (falls back to `DEFAULT_SPEED_POLICY` on a corrupt blob).
  - `readDefaultPolicy(db: Db): ChannelPolicy` — shorthand for the above `.policy`.
  - `setChannelPolicy(db: Db, id: string, policy: ChannelPolicy): void`.
  - `setChannelLastReason(db: Db, id: string, reason: string, at: number): void` (used by Phase 2).
  - `policyProbe(policy: ChannelPolicy): { url: string; intervalSec: number }` — the health-check target + cadence for any policy (manual → defaults).

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/modules/channels/service.test.ts`:

```ts
import { DEFAULT_AUTO_TEST_URL, DEFAULT_SPEED_POLICY } from "@submerge/shared";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { setSetting } from "../settings/service.js";
import {
  ensureDefaultChannel,
  policyProbe,
  readDefaultPolicy,
  setChannelPolicy,
} from "./service.js";

function freshDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
  return db;
}

describe("ensureDefaultChannel", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("seeds a default speed channel when none exists", () => {
    ensureDefaultChannel(db);
    expect(readDefaultPolicy(db)).toEqual(DEFAULT_SPEED_POLICY);
  });

  it("is idempotent", () => {
    ensureDefaultChannel(db);
    setChannelPolicy(db, "default", { ...DEFAULT_SPEED_POLICY, intervalSec: 42 });
    ensureDefaultChannel(db); // must NOT overwrite an existing row
    expect(readDefaultPolicy(db).intervalSec).toBe(42);
  });

  it("migrates legacy auto* settings into the default speed policy", () => {
    setSetting(db, "autoTestUrl", "https://legacy/probe");
    setSetting(db, "autoTestInterval", "77");
    setSetting(db, "autoTestTolerance", "10");
    setSetting(db, "autoSwitchOnTimeout", "false");
    ensureDefaultChannel(db);
    expect(readDefaultPolicy(db)).toEqual({
      kind: "speed",
      testUrl: "https://legacy/probe",
      intervalSec: 77,
      toleranceMs: 10,
      reevaluateWhileHealthy: false,
    });
  });
});

describe("policyProbe", () => {
  it("returns a sticky policy's own url + interval", () => {
    expect(
      policyProbe({
        kind: "sticky",
        testUrl: "https://s/probe",
        intervalSec: 30,
        failureThreshold: 3,
        maxHoldHours: null,
        initialCriterion: "fastest",
      }),
    ).toEqual({ url: "https://s/probe", intervalSec: 30 });
  });
  it("falls back to defaults for a manual policy", () => {
    expect(
      policyProbe({ kind: "manual", pinnedNode: "X", onFailure: "hold" }),
    ).toEqual({ url: DEFAULT_AUTO_TEST_URL, intervalSec: expect.any(Number) });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @submerge/server test src/modules/channels/service.test.ts`
Expected: FAIL — module `./service.js` does not exist.

- [ ] **Step 3: Implement the service**

Create `packages/server/src/modules/channels/service.ts`:

```ts
import {
  channelSchema,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_AUTO_TEST_URL,
  DEFAULT_SPEED_POLICY,
  type Channel,
  type ChannelPolicy,
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
  const url = getSetting(db, "autoTestUrl")?.trim();
  const interval = Number.parseInt(getSetting(db, "autoTestInterval") ?? "", 10);
  const tolerance = Number.parseInt(getSetting(db, "autoTestTolerance") ?? "", 10);
  const switchOnTimeout = getSetting(db, "autoSwitchOnTimeout");
  return {
    kind: "speed",
    testUrl: url && url.length > 0 ? url : DEFAULT_SPEED_POLICY.testUrl,
    intervalSec:
      Number.isFinite(interval) && interval >= 1 ? interval : DEFAULT_SPEED_POLICY.intervalSec,
    toleranceMs:
      Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_SPEED_POLICY.toleranceMs,
    reevaluateWhileHealthy:
      switchOnTimeout == null
        ? DEFAULT_SPEED_POLICY.reevaluateWhileHealthy
        : switchOnTimeout === "true",
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
  db.update(channels).set({ lastReason: reason, lastReasonAt: at }).where(eq(channels.id, id)).run();
}

// The health-check target + cadence for any policy. `manual` has no probe of its
// own, so it uses the built-in defaults.
export function policyProbe(policy: ChannelPolicy): { url: string; intervalSec: number } {
  if (policy.kind === "manual") {
    return { url: DEFAULT_AUTO_TEST_URL, intervalSec: DEFAULT_AUTO_TEST_INTERVAL };
  }
  return { url: policy.testUrl, intervalSec: policy.intervalSec };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @submerge/server test src/modules/channels/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/channels/service.ts packages/server/src/modules/channels/service.test.ts
git commit -m "feat(server): channel service — seed/read/migrate/update

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `buildConfig` takes a `ChannelPolicy` (speed path, behaviour-preserving)

**Files:**
- Modify: `packages/server/src/modules/nodes/config.ts`
- Test: `packages/server/src/modules/nodes/config.test.ts`

**Interfaces:**
- Consumes: `ChannelPolicy`, `DEFAULT_SPEED_POLICY`.
- Produces: `buildConfig(proxies: ProxyConfig[], policy?: ChannelPolicy, secret?: string): string`. For `speed`, the `AUTO` group is `type: url-test` with `url/interval/tolerance/lazy` from the policy; collapsed subgroups use the same `url/interval/tolerance/lazy`. `sticky`/`manual` make `AUTO` a `select` group (server pins in Phase 2). Removes the old `AutoConfig`/`AutoStrategy`/`AUTO_DEFAULTS`/`AUTO_STRATEGIES` exports.

- [ ] **Step 1: Update the existing tests for the new signature + field**

In `packages/server/src/modules/nodes/config.test.ts`, the `buildConfig([...])` calls already omit the policy arg (they rely on the default), so the populated/empty/collapse tests keep passing. **Add** a test asserting the `speed`→`lazy` mapping and a `sticky`→`select` shape. Append:

```ts
import type { ChannelPolicy } from "@submerge/shared";

const speed = (over: Partial<Extract<ChannelPolicy, { kind: "speed" }>> = {}): ChannelPolicy => ({
  kind: "speed",
  testUrl: "https://x/generate_204",
  intervalSec: 300,
  toleranceMs: 50,
  reevaluateWhileHealthy: true,
  ...over,
});

describe("buildConfig policy mapping", () => {
  it("maps speed.reevaluateWhileHealthy=true to AUTO lazy=false + tolerance", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(buildConfig([proxy("A")], speed())) as Record<string, any>;
    const auto = cfg["proxy-groups"].find((g: any) => g.name === "AUTO");
    expect(auto.type).toBe("url-test");
    expect(auto.lazy).toBe(false);
    expect(auto.tolerance).toBe(50);
    expect(auto.url).toBe("https://x/generate_204");
    expect(auto.interval).toBe(300);
  });

  it("makes AUTO a select group for a sticky policy (server pins it)", () => {
    const sticky: ChannelPolicy = {
      kind: "sticky",
      testUrl: "https://x/generate_204",
      intervalSec: 60,
      failureThreshold: 3,
      maxHoldHours: null,
      initialCriterion: "fastest",
    };
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(buildConfig([proxy("A"), proxy("B")], sticky)) as Record<string, any>;
    const auto = cfg["proxy-groups"].find((g: any) => g.name === "AUTO");
    expect(auto.type).toBe("select");
    expect(auto.proxies).toEqual(["A", "B"]);
    expect(auto.tolerance).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm -F @submerge/server test src/modules/nodes/config.test.ts`
Expected: FAIL — `buildConfig` still expects the old `AutoConfig`; the `speed()` object is not assignable / `lazy` mapping differs.

- [ ] **Step 3: Rewrite the policy-dependent parts of `config.ts`**

In `packages/server/src/modules/nodes/config.ts`:

Replace the imports block (lines 2-9) with:

```ts
import { DEFAULT_SPEED_POLICY, type ChannelPolicy, type Proxy as ProxyConfig } from "@submerge/shared";
```

Delete the `AutoStrategy`/`AUTO_STRATEGIES`/`AutoConfig`/`AUTO_DEFAULTS` block (old lines 60-78).

Add a small helper above `buildConfig`:

```ts
// The mihomo tuning a `speed` policy contributes to url-test groups (AUTO + any
// collapsed same-name subgroup). Non-speed policies make AUTO a plain `select`
// that the server controller pins, so they contribute nothing here.
interface UrlTestTuning {
  url: string;
  interval: number;
  tolerance: number;
  lazy: boolean;
}
function urlTestTuning(policy: ChannelPolicy): UrlTestTuning {
  const p = policy.kind === "speed" ? policy : DEFAULT_SPEED_POLICY;
  return {
    url: p.testUrl,
    interval: p.intervalSec,
    tolerance: p.toleranceMs,
    lazy: !p.reevaluateWhileHealthy,
  };
}
```

Change `buildConfig`'s signature and body. Replace the old signature line and the `auto`-dependent sections:

```ts
export function buildConfig(
  proxies: ProxyConfig[],
  policy: ChannelPolicy = DEFAULT_SPEED_POLICY,
  secret: string = env.MIHOMO_SECRET,
): string {
  const entries = groupProxies(proxies);
  const usedGroupNames = new Set<string>(RESERVED_GROUP_NAMES);
  const topLevelNames: string[] = [];
  const flat: ProxyConfig[] = [];
  const subGroups: Record<string, unknown>[] = [];
  const tuning = urlTestTuning(policy);
```

Inside the collapse loop, replace the `subGroups.push({...})` block to use `tuning`:

```ts
    subGroups.push({
      name: gname,
      type: "url-test",
      url: tuning.url,
      interval: tuning.interval,
      tolerance: tuning.tolerance,
      lazy: tuning.lazy,
      proxies: memberNames,
    });
```

Replace the `autoGroup` construction (old lines 122-132) with:

```ts
  const unique = dedupeNames(flat);
  const members = topLevelNames.length ? topLevelNames : ["DIRECT"];
  const autoGroup: Record<string, unknown> =
    policy.kind === "speed"
      ? {
          name: "AUTO",
          type: "url-test",
          url: tuning.url,
          interval: tuning.interval,
          tolerance: tuning.tolerance,
          lazy: tuning.lazy,
          proxies: members,
        }
      : {
          // sticky / manual: a dumb selector the server controller pins (Phase 2).
          name: "AUTO",
          type: "select",
          proxies: members,
        };
```

(The rest of `buildConfig` — the `cfg` object and `rules` — is unchanged.)

- [ ] **Step 4: Run the full config test file**

Run: `pnpm -F @submerge/server test src/modules/nodes/config.test.ts`
Expected: PASS — the original populated/empty/collapse tests are byte-compatible for `speed` defaults, and the two new mapping tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/config.ts packages/server/src/modules/nodes/config.test.ts
git commit -m "refactor(server): buildConfig takes a ChannelPolicy (speed path)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Rewire `applyConfig`, node router, and live probe onto the Default policy

**Files:**
- Modify: `packages/server/src/modules/nodes/service.ts`
- Modify: `packages/server/src/modules/nodes/router.ts`
- Modify: `packages/server/src/live/singleton.ts`
- Test: `packages/server/src/modules/nodes/service.test.ts` (verify still green)

**Interfaces:**
- Consumes: `readDefaultPolicy`, `policyProbe` (Task 3), `buildConfig(proxies, policy, secret)` (Task 4).
- Produces: `applyConfig` writes the config from the Default channel policy; `readAutoConfig` is deleted; `nodes.delay` and the live probe use `policyProbe(readDefaultPolicy(db))`.

- [ ] **Step 1: Update `service.ts`**

In `packages/server/src/modules/nodes/service.ts`:

Remove the `readAutoConfig` function (old lines 19-36) and its `config.js` imports of `AUTO_DEFAULTS`/`AUTO_STRATEGIES`/`AutoConfig`/`AutoStrategy`. The `config.js` import shrinks to:

```ts
import { buildConfig } from "./config.js";
```

Add near the other imports:

```ts
import { readDefaultPolicy } from "../channels/service.js";
```

In `applyConfig`, change the `buildConfig` call (old line 76):

```ts
  const content = buildConfig(proxies, readDefaultPolicy(db), readMihomoSecret(db));
```

- [ ] **Step 2: Update `router.ts`**

In `packages/server/src/modules/nodes/router.ts`, replace the `readAutoConfig` import and use with `policyProbe`/`readDefaultPolicy`:

```ts
import { delayInput, selectNodeInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { policyProbe, readDefaultPolicy } from "../channels/service.js";
import { checkHealth, listNodes, selectNode, testDelay } from "./service.js";

export const nodesRouter = router({
  list: protectedProcedure.query(() => listNodes()),
  health: protectedProcedure.query(async () => ({ connected: await checkHealth() })),
  delay: protectedProcedure
    .input(delayInput)
    .mutation(({ input }) => testDelay(input.name, policyProbe(readDefaultPolicy(db)).url)),
  select: protectedProcedure
    .input(selectNodeInput)
    .mutation(({ input }) => selectNode(input.group, input.name)),
});
```

- [ ] **Step 3: Update the live probe in `singleton.ts`**

In `packages/server/src/live/singleton.ts`, replace the `readAutoConfig` import and the `probeActive` body:

```ts
import { policyProbe, readDefaultPolicy } from "../modules/channels/service.js";
import { toNodeView } from "../modules/nodes/service.js";
```

```ts
  probeActive: async (name) => {
    if (PSEUDO_NODES.has(name)) return;
    const { url, intervalSec } = policyProbe(readDefaultPolicy(db));
    const now = Date.now();
    if (now - lastProbe < intervalSec * 1000 - 1000) return;
    lastProbe = now;
    await getDelay(name, url);
  },
```

(Keep the existing `getDelay` import from the mihomo client.)

- [ ] **Step 4: Verify the node/service tests + typecheck**

Run: `pnpm -F @submerge/server test src/modules/nodes/ && pnpm -F @submerge/server exec tsc -b --noEmit`
Expected: PASS and no type errors (no lingering `readAutoConfig` references).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/service.ts packages/server/src/modules/nodes/router.ts packages/server/src/live/singleton.ts
git commit -m "refactor(server): route config + probes through the Default channel policy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `channels` tRPC router + boot seed + drop the `auto*` settings branch

**Files:**
- Create: `packages/server/src/modules/channels/router.ts`
- Modify: `packages/server/src/trpc/router.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/modules/settings/router.ts`
- Test: `packages/server/src/trpc/router.test.ts` (verify still green)

**Interfaces:**
- Consumes: `setChannelPolicyInput`, `readDefaultChannel`, `setChannelPolicy`, `applyConfig`, `ensureDefaultChannel`.
- Produces: `channelsRouter` with `get` (→ `Channel`) and `setPolicy` (validates, persists, regenerates config). Registered as `channels` on the app router. `ensureDefaultChannel(db)` runs at boot.

- [ ] **Step 1: Create the router**

Create `packages/server/src/modules/channels/router.ts`:

```ts
import { setChannelPolicyInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { applyConfig } from "../nodes/service.js";
import { readDefaultChannel, setChannelPolicy } from "./service.js";

export const channelsRouter = router({
  // Phase 1 exposes only the Default channel; multi-channel CRUD lands in Phase 3.
  get: protectedProcedure.query(() => readDefaultChannel(db)),
  setPolicy: protectedProcedure.input(setChannelPolicyInput).mutation(async ({ input }) => {
    setChannelPolicy(db, input.id, input.policy);
    // The policy shapes the mihomo config (group type + tuning) — regenerate + reload.
    await applyConfig(db);
    return { ok: true as const };
  }),
});
```

- [ ] **Step 2: Register it on the app router**

In `packages/server/src/trpc/router.ts`, add the import and the router entry:

```ts
import { channelsRouter } from "../modules/channels/router.js";
```

```ts
  nodes: nodesRouter,
  channels: channelsRouter,
  settings: settingsRouter,
```

- [ ] **Step 3: Seed the Default channel at boot**

In `packages/server/src/index.ts`, after `runMigrations()` is called, add `ensureDefaultChannel(db)`. Find the migration call and add below it:

```ts
import { ensureDefaultChannel } from "./modules/channels/service.js";
import { db } from "./db/client.js";
// ... after runMigrations():
ensureDefaultChannel(db);
```

(If `db` is already imported in `index.ts`, don't duplicate the import.)

- [ ] **Step 4: Drop the `auto*` reload branch from settings router**

In `packages/server/src/modules/settings/router.ts`, remove the now-dead branch (old lines 11-13):

```ts
    // AUTO tuning lives in the mihomo config — regenerate + reload so it takes effect.
    if (input.key.startsWith("auto")) await applyConfig(db);
```

Auto tuning is no longer stored as `auto*` settings — it lives on the Default channel and reloads via `channels.setPolicy`. Keep the `mihomoSecret` branch untouched. If `applyConfig` becomes unused in this file after the edit, remove its import.

- [ ] **Step 5: Verify router tests + typecheck + full suite**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: all green. (`router.test.ts` should still pass; if it asserts the exact set of top-level routers, add `channels` to that assertion.)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/modules/channels/router.ts packages/server/src/trpc/router.ts packages/server/src/index.ts packages/server/src/modules/settings/router.ts
git commit -m "feat(server): channels tRPC router + boot seed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Web — bind the auto-select card to the channel policy + honest label

**Files:**
- Modify: `packages/web/src/features/nodes/AutoStrategyCard.tsx`
- Modify: `packages/web/src/features/settings/SettingsScreen.tsx`
- Test: manual visual check (design-system gate) + `pnpm -F @submerge/web test`

**Interfaces:**
- Consumes: `trpc.channels.get` (→ `Channel`), `trpc.channels.setPolicy`. Uses `RouterOutputs["channels"]["get"]`.
- Produces: the auto-select card reads the Default channel's `speed` policy; the row previously labelled **"ПЕРЕКЛЮЧАТЬ ПРИ / таймаут"** now reads **"ПЕРЕОЦЕНКА / всегда | пока жив"** driven by `reevaluateWhileHealthy`.

- [ ] **Step 1: Update the `AutoInfo` shape + labels in `AutoStrategyCard.tsx`**

Replace the `AutoInfo` interface and the `params` array so the card is driven by the speed policy. Change the interface (old lines 13-20):

```ts
// Mirror of the Default channel's speed policy (Settings → Авто-выбор узла).
export interface AutoInfo {
  testUrl: string;
  intervalSec: number; // seconds between mihomo re-tests (NOT the panel poll)
  toleranceMs: number;
  reevaluateWhileHealthy: boolean;
}
```

Remove the `STRATEGY_LABELS` map and the "СТРАТЕГИЯ" param (strategy is implied by the policy kind now — Phase 1 is always `speed`). Replace the `params` array (old lines 49-55):

```ts
  const params: { caption: string; value: string; grow?: boolean }[] = [
    { caption: "ПРОВЕРОЧНЫЙ URL", value: auto.testUrl.replace(/^https?:\/\//, ""), grow: true },
    { caption: "ИНТЕРВАЛ ПРОВЕРКИ", value: formatInterval(auto.intervalSec) },
    { caption: "ДОПУСК", value: `${auto.toleranceMs} ms` },
    { caption: "ПЕРЕОЦЕНКА", value: auto.reevaluateWhileHealthy ? "всегда" : "пока жив" },
  ];
```

(Remove the now-unused `STRATEGY_LABELS` const and, if unused, the value that referenced `auto.strategy`.)

- [ ] **Step 2: Feed the card from `channels.get` in `SettingsScreen.tsx`**

In `packages/web/src/features/settings/SettingsScreen.tsx`, wherever the auto-select tuning was read from the settings query (the `auto*` keys), switch to the channel query. Add/replace the query and map its `speed` policy to `AutoInfo`:

```ts
const channelQuery = trpc.channels.get.useQuery();
// ...
const policy = channelQuery.data?.policy;
const autoInfo: AutoInfo | null =
  policy?.kind === "speed"
    ? {
        testUrl: policy.testUrl,
        intervalSec: policy.intervalSec,
        toleranceMs: policy.toleranceMs,
        reevaluateWhileHealthy: policy.reevaluateWhileHealthy,
      }
    : null;
```

Where the editable controls previously called `settings.set` with `auto*` keys, call `channels.setPolicy` with the full updated speed policy instead, e.g. an interval edit:

```ts
const setPolicy = trpc.channels.setPolicy.useMutation({
  onSuccess: () => channelQuery.refetch(),
});
function updateSpeed(patch: Partial<Extract<ChannelPolicy, { kind: "speed" }>>) {
  if (policy?.kind !== "speed") return;
  setPolicy.mutate({ id: "default", policy: { ...policy, ...patch } });
}
```

Import `ChannelPolicy` from `@submerge/shared` for the patch type. Replace the "переключать при таймауте" control's copy with a toggle labelled **"Переоценивать, пока узел жив"** bound to `reevaluateWhileHealthy` via `updateSpeed({ reevaluateWhileHealthy: v })`.

- [ ] **Step 3: Typecheck + web tests + lint**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm -F @submerge/web test`
Expected: green. Fix any references to the removed `strategy`/`switchOnTimeout` fields the compiler flags.

- [ ] **Step 4: Visual verification (design-system gate)**

Run the app (`pnpm -F @submerge/server dev` + the web dev server), open Settings at **1440×1024, dark**, and confirm: the auto-select card shows ПРОВЕРОЧНЫЙ URL / ИНТЕРВАЛ ПРОВЕРКИ / ДОПУСК / ПЕРЕОЦЕНКА; editing the interval and toggling "Переоценивать, пока узел жив" persists (reload shows the new value) and does not throw. Check the 390 breakpoint for overflow. Confirm the config actually reloaded (no engine error toast).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/features/nodes/AutoStrategyCard.tsx packages/web/src/features/settings/SettingsScreen.tsx
git commit -m "feat(web): bind auto-select card to the channel speed policy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Final Phase-1 verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 2: Behaviour-preservation check**

With a fresh DB (no `auto*` settings), start the server and confirm the generated `mihomo/config.yaml` has an `AUTO` group of `type: url-test`, `url: https://www.gstatic.com/generate_204`, `interval: 300`, `tolerance: 50`, `lazy: false`, and `rules: [MATCH,PROXY]` — i.e. identical to the pre-change default output.

- [ ] **Step 3: Upgrade-path check**

On a DB that still has legacy `autoTestInterval=77` etc. (simulate via the settings table), start the server and confirm `channels.get` returns a `speed` policy with `intervalSec: 77` — the tuning carried over.

- [ ] **Step 4: Incremental review**

Review the whole Phase-1 diff against the spec §3–§5 and the conventions (tokens-in-config, control-type fidelity, Zod at boundaries). Confirm no `readAutoConfig`/`switchOnTimeout`/`AUTO_STRATEGIES` references remain (`git grep -n "readAutoConfig\|switchOnTimeout\|AUTO_STRATEGIES\|AUTO_DEFAULTS"` returns nothing in `packages/`).

---

## Self-Review

**Spec coverage (§ of `docs/specs/2026-07-01-channel-routing-design.md`):**
- §3 Channel abstraction → Tasks 1–3 (schema, table, service). Multi-channel list deferred to Phase 3 (documented in File Structure note).
- §4 Data model → Task 2 (`channels` table incl. `last_reason`/`last_reason_at`); `channel_pool` explicitly deferred (Default = all nodes).
- §5 `speed` policy → Tasks 1, 4, 5, 7. `sticky`/`manual` are contract-complete (Task 1) and config emits a `select` group for them (Task 4), but the controller that acts on them is Phase 2 — flagged, not silently dropped.
- §8 config generation → Task 4 (speed url-test; select for sticky/manual). Multi-channel `rules` deferred to Phase 3.
- Honest-label goal (rename `switchOnTimeout`→`reevaluateWhileHealthy`) → Tasks 1, 7.

**Gaps (intentional, Phase 2/3):** controller loop, decision-log ring buffer, "why" UI, `channel_pool`, per-channel `rules`, sticky pinning. None are Phase-1 deliverables.

**Placeholder scan:** none — every code step carries complete code; every run step has an exact command + expected result.

**Type consistency:** `ChannelPolicy` discriminated union, `readDefaultPolicy`/`policyProbe`/`readDefaultChannel`/`setChannelPolicy`/`ensureDefaultChannel`/`setChannelLastReason` names are used identically across Tasks 3, 5, 6, 7. `buildConfig(proxies, policy, secret)` signature matches its callers in Task 5. `DEFAULT_CHANNEL_ID = "default"` matches the `"default"` id used by the web `setPolicy` call in Task 7 and the seed in Task 3.
