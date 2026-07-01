# Sticky Controller (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on:** Phase 1 (`docs/plans/2026-07-01-channel-abstraction-phase1.md`) must be merged first — this plan assumes the `channels` table, the `ChannelPolicy` union, `readDefaultChannel`/`readDefaultPolicy`/`setChannelLastReason`/`policyProbe`, and the `select`-type `AUTO` group emitted by `buildConfig` for non-speed policies.

**Goal:** Make submerge an **active controller** for the Default channel: when its policy is `sticky`, the server picks the best node once, pins it into the `AUTO` `select` group, and only switches after `failureThreshold` consecutive health-check failures — killing latency-driven IP rotation while every decision is recorded and explained.

**Architecture:** A stateful `ChannelController` runs once per live poll via a new `afterView` hook on `LiveHub`. It handles all three policies: `speed` (passive — reconstructs and records the switch reason when mihomo's url-test moves), `sticky` (active — throttled health probe of the pinned node, failure counting, best-node re-pick, optional `maxHoldHours`), and `manual` (ensures the pinned node is selected, with an optional fallback). Decisions land in an in-memory ring buffer and the latest is persisted to the channel row (`last_reason`/`last_reason_at`). The web surfaces the policy choice (speed | sticky), sticky's knobs, and the last decision.

**Tech Stack:** Node 24, strict TypeScript (ESM), tRPC v11, Drizzle + better-sqlite3, Zod 4, Vitest, React 19 + shadcn/ui. Biome.

## Global Constraints

- **Language:** code/comments/commits in **English**; UI strings Russian.
- **Validation:** Zod at boundaries; mihomo responses `.parse()`d in `clients/*` only.
- **Strict TS:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM `.js` specifiers.
- **Boundaries:** all mihomo calls via `packages/server/src/clients/mihomo.js` (`getDelay`, `selectProxy`).
- **Controller must be best-effort:** a throwing `afterView`/controller tick must never break the live poll (the hook is wrapped in try/catch).
- **No fake data (honesty gate):** don't invent loss/bandwidth we don't measure. `initialCriterion` values must be backed by real probes; anything not truly backed is not offered in the UI.
- **Self-verify before each commit:** `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` (raw biome).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Clock is injected:** the controller takes `now: () => number`; production passes `Date.now`. Tests pass a fake clock (no real timers).

---

## File Structure

**Create:**
- `packages/server/src/modules/channels/controller.ts` — the `ChannelController` class (policy logic).
- `packages/server/src/modules/channels/controller.test.ts` — unit tests with fake deps (no real mihomo/timers).
- `packages/server/src/modules/channels/instance.ts` — the wired singleton controller (deps → real db + mihomo client).

**Modify:**
- `packages/shared/src/schemas.ts` — add `decisionEntrySchema` / `DecisionEntry`.
- `packages/server/src/live/hub.ts` — add the optional `afterView(view)` dep + call it in `pollOnce`.
- `packages/server/src/live/hub.test.ts` — cover the `afterView` hook.
- `packages/server/src/live/singleton.ts` — pass `afterView: (view) => controller.tick(view)`.
- `packages/server/src/modules/channels/router.ts` — add `recentDecisions` query.
- `packages/web/src/features/settings/SettingsScreen.tsx` — policy selector (speed | sticky) + sticky knobs + last-decision display.
- `packages/web/src/features/nodes/AutoStrategyCard.tsx` — show the persisted last-decision reason in the status line.

**Out of scope (later phases):** multi-channel controllers (Phase 3 — Phase 2 controls only the Default channel), `manual` policy UI (the existing PROXY "Ручной" node-pin already covers manual selection; the `manual` *policy* is handled by the controller but not surfaced as a new UI), on-demand bandwidth + `highest-bandwidth` criterion (Phase 4).

---

### Task 1: `LiveHub.afterView` hook

**Files:**
- Modify: `packages/server/src/live/hub.ts`
- Test: `packages/server/src/live/hub.test.ts`

**Interfaces:**
- Produces: `HubDeps.afterView?: (view: NodeView) => Promise<void>` — invoked once per successful poll, after the `nodeUpdate` emit, wrapped so its rejection can't fail the poll.

- [ ] **Step 1: Write a failing test**

Append to `packages/server/src/live/hub.test.ts` (mirror the existing test setup style — construct a `LiveHub` with minimal deps and call `pollOnce` directly):

```ts
it("calls afterView with the fetched view each poll", async () => {
  const view: NodeView = { now: "AUTO", autoNow: "A", all: [] };
  const seen: NodeView[] = [];
  const hub = new LiveHub({
    fetchView: async () => view,
    streamTraffic: async function* () {},
    getInterval: () => 10_000,
    afterView: async (v) => {
      seen.push(v);
    },
  });
  await hub.pollOnce();
  expect(seen).toEqual([view]);
});

it("a throwing afterView does not fail the poll (health stays true)", async () => {
  const events: LiveEvent[] = [];
  const hub = new LiveHub({
    fetchView: async () => ({ now: null, autoNow: null, all: [] }),
    streamTraffic: async function* () {},
    getInterval: () => 10_000,
    afterView: async () => {
      throw new Error("boom");
    },
  });
  hub.emitter.on(LIVE_EVENT, (e: LiveEvent) => events.push(e));
  await hub.pollOnce();
  expect(events).toContainEqual({ type: "health", mihomo: true });
});
```

Ensure the test file imports `LIVE_EVENT`, `LiveHub`, and the `NodeView`/`LiveEvent` types (add any missing imports).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @submerge/server test src/live/hub.test.ts`
Expected: FAIL — `afterView` is not a known dep / not invoked.

- [ ] **Step 3: Implement the hook**

In `packages/server/src/live/hub.ts`, add to `HubDeps` (after `fetchTotals`):

```ts
  // Runs once per successful poll AFTER the nodeUpdate emit, with the fresh view.
  // Best-effort: the hub swallows its errors so an active controller can never
  // break live polling. Used by the channel controller to pin/switch nodes.
  afterView?: (view: NodeView) => Promise<void>;
```

In `pollOnce`, after the `this.emit({ type: "nodeUpdate", view })` line and before the totals block, add:

```ts
      if (this.deps.afterView) {
        try {
          await this.deps.afterView(view);
        } catch {
          /* controller error — must not affect health or abort the poll */
        }
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @submerge/server test src/live/hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/live/hub.ts packages/server/src/live/hub.test.ts
git commit -m "feat(server): LiveHub afterView hook for the channel controller

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `DecisionEntry` contract + controller scaffolding & candidate/best-pick helpers

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Create: `packages/server/src/modules/channels/controller.ts`
- Test: `packages/server/src/modules/channels/controller.test.ts`

**Interfaces:**
- Produces:
  - Shared `decisionEntrySchema` / `DecisionEntry = { at: number; channelId: string; from: string | null; to: string; reason: string }`.
  - `ControllerDeps { readChannel: () => Channel; probe: (name: string, url: string) => Promise<number | null>; select: (group: string, name: string) => Promise<void>; persistReason: (reason: string, at: number) => void; now: () => number; ringSize?: number }`.
  - `class ChannelController` with `tick(view: NodeView): Promise<void>` and `recent(): DecisionEntry[]`.
  - Exported pure helpers: `selectableNames(view: NodeView): string[]`, `pickBest(names: string[], url: string, criterion: "fastest" | "lowest-loss", probe, samples?): Promise<string | null>`.

- [ ] **Step 1: Add the shared `DecisionEntry` schema**

Append to `packages/shared/src/schemas.ts`:

```ts
// A single controller decision, surfaced in the UI ("why did it switch?").
export const decisionEntrySchema = z.object({
  at: z.number(), // epoch ms
  channelId: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string(),
});
export type DecisionEntry = z.infer<typeof decisionEntrySchema>;
```

- [ ] **Step 2: Write failing tests for the helpers**

Create `packages/server/src/modules/channels/controller.test.ts`:

```ts
import type { NodeItem, NodeView } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { pickBest, selectableNames } from "./controller.js";

const node = (name: string, delay: number | null = null): NodeItem => ({
  name,
  type: "vless",
  delay,
  history: [],
});

const view = (names: string[], autoNow: string | null = null): NodeView => ({
  now: "AUTO",
  autoNow,
  all: names.map((n) => node(n)),
});

describe("selectableNames", () => {
  it("drops pseudo groups (AUTO/PROXY/DIRECT/REJECT/GLOBAL)", () => {
    expect(selectableNames(view(["AUTO", "A", "DIRECT", "B", "REJECT"]))).toEqual(["A", "B"]);
  });
});

describe("pickBest", () => {
  it("fastest: picks the lowest-latency reachable node", async () => {
    const delays: Record<string, number | null> = { A: 120, B: 40, C: null };
    const probe = async (name: string) => delays[name] ?? null;
    expect(await pickBest(["A", "B", "C"], "u", "fastest", probe)).toBe("B");
  });
  it("fastest: falls back to the first name when all probes fail", async () => {
    const probe = async () => null;
    expect(await pickBest(["A", "B"], "u", "fastest", probe)).toBe("A");
  });
  it("lowest-loss: ranks by success count over samples, then latency", async () => {
    // A: 1/3 ok (fast when ok); B: 3/3 ok (slower). B wins on reliability.
    const seq: Record<string, (number | null)[]> = {
      A: [10, null, null],
      B: [80, 80, 80],
    };
    const idx: Record<string, number> = { A: 0, B: 0 };
    const probe = async (name: string) => {
      const arr = seq[name] as (number | null)[];
      const i = idx[name] as number;
      idx[name] = i + 1;
      return arr[i] ?? null;
    };
    expect(await pickBest(["A", "B"], "u", "lowest-loss", probe, 3)).toBe("B");
  });
  it("returns null for an empty candidate list", async () => {
    expect(await pickBest([], "u", "fastest", async () => 1)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm -F @submerge/server test src/modules/channels/controller.test.ts`
Expected: FAIL — `./controller.js` does not exist.

- [ ] **Step 4: Implement the scaffolding + helpers**

Create `packages/server/src/modules/channels/controller.ts`:

```ts
import type { Channel, DecisionEntry, NodeView } from "@submerge/shared";

// mihomo built-in policies + our routing groups — never selectable exit nodes.
const PSEUDO = new Set([
  "AUTO",
  "PROXY",
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
  "GLOBAL",
]);

// The real exit nodes a channel can pin, in view order.
export function selectableNames(view: NodeView): string[] {
  return view.all.map((n) => n.name).filter((n) => !PSEUDO.has(n));
}

// Probe one candidate `samples` times; return { ok, latency } where ok is the
// number of successful probes and latency is the mean of successful probes
// (Infinity if none succeeded).
async function score(
  name: string,
  url: string,
  samples: number,
  probe: (name: string, url: string) => Promise<number | null>,
): Promise<{ ok: number; latency: number }> {
  let ok = 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const d = await probe(name, url);
    if (d != null && d > 0) {
      ok++;
      sum += d;
    }
  }
  return { ok, latency: ok > 0 ? sum / ok : Number.POSITIVE_INFINITY };
}

// Pick the best candidate. `fastest` = one probe each, lowest latency. `lowest-loss`
// = `samples` probes each, ranked by success count then mean latency. Falls back to
// the first name if every candidate is unreachable (best-effort — never returns a
// name outside `names`). Returns null only for an empty list.
export async function pickBest(
  names: string[],
  url: string,
  criterion: "fastest" | "lowest-loss",
  probe: (name: string, url: string) => Promise<number | null>,
  samples = 3,
): Promise<string | null> {
  if (names.length === 0) return null;
  const n = criterion === "lowest-loss" ? samples : 1;
  let best: string | null = null;
  let bestOk = -1;
  let bestLatency = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const s = await score(name, url, n, probe);
    if (s.ok > bestOk || (s.ok === bestOk && s.latency < bestLatency)) {
      best = name;
      bestOk = s.ok;
      bestLatency = s.latency;
    }
  }
  // Every candidate failed (bestOk === 0) → keep the deterministic first choice.
  return best ?? (names[0] as string);
}

export interface ControllerDeps {
  readChannel: () => Channel;
  probe: (name: string, url: string) => Promise<number | null>; // null = timeout/unreachable
  select: (group: string, name: string) => Promise<void>;
  persistReason: (reason: string, at: number) => void;
  now: () => number;
  ringSize?: number;
}

const AUTO_GROUP = "AUTO";

export class ChannelController {
  private failures = 0;
  private heldSince: number | null = null;
  private lastCheck = 0;
  private lastSpeedNow: string | null = null;
  private log: DecisionEntry[] = [];

  constructor(private deps: ControllerDeps) {}

  recent(): DecisionEntry[] {
    return [...this.log].reverse(); // newest first
  }

  protected record(entry: DecisionEntry): void {
    this.log.push(entry);
    const cap = this.deps.ringSize ?? 20;
    if (this.log.length > cap) this.log.splice(0, this.log.length - cap);
    this.deps.persistReason(entry.reason, entry.at);
  }

  // Apply a decision: select the node in mihomo (only if it actually changes),
  // reset the hold window, and record the reason.
  protected async apply(
    channelId: string,
    from: string | null,
    to: string,
    reason: string,
    at: number,
  ): Promise<void> {
    if (to !== from) await this.deps.select(AUTO_GROUP, to);
    this.heldSince = at;
    this.record({ at, channelId, from, to, reason });
  }

  async tick(_view: NodeView): Promise<void> {
    // Implemented across Tasks 3 (sticky) and 4 (speed/manual).
  }
}
```

- [ ] **Step 5: Run to verify the helper tests pass**

Run: `pnpm -F @submerge/server test src/modules/channels/controller.test.ts`
Expected: PASS (helper tests green; `tick` is still a stub).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas.ts packages/server/src/modules/channels/controller.ts packages/server/src/modules/channels/controller.test.ts
git commit -m "feat: DecisionEntry contract + controller scaffolding & pickBest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Sticky policy — initial pick, failure counting, switch, max-hold

**Files:**
- Modify: `packages/server/src/modules/channels/controller.ts`
- Test: `packages/server/src/modules/channels/controller.test.ts`

**Interfaces:**
- Consumes: `selectableNames`, `pickBest`, `ControllerDeps`, `readChannel().policy` (`sticky` variant), `policyProbe` (from `./service.js`).
- Produces: `ChannelController.tick(view)` handling `sticky` — pins the best node initially, health-checks the pinned node once per `intervalSec`, switches after `failureThreshold` consecutive failures, and re-picks after `maxHoldHours`.

- [ ] **Step 1: Write failing sticky tests**

Append to `packages/server/src/modules/channels/controller.test.ts`:

```ts
import type { Channel, ChannelPolicy } from "@submerge/shared";
import { ChannelController } from "./controller.js";

const stickyPolicy = (over: Partial<Extract<ChannelPolicy, { kind: "sticky" }>> = {}): ChannelPolicy => ({
  kind: "sticky",
  testUrl: "https://probe",
  intervalSec: 60,
  failureThreshold: 3,
  maxHoldHours: null,
  initialCriterion: "fastest",
  ...over,
});

const channel = (policy: ChannelPolicy): Channel => ({
  id: "default",
  name: "Default",
  priority: 0,
  enabled: true,
  isDefault: true,
  policy,
  matcher: { presets: [], domains: [] },
  lastReason: null,
  lastReasonAt: null,
});

interface Harness {
  ctrl: ChannelController;
  selected: string[];
  reasons: { reason: string; at: number }[];
  setClock: (t: number) => void;
  setProbe: (fn: (name: string) => number | null) => void;
}

function harness(policy: ChannelPolicy): Harness {
  let clock = 0;
  let probeFn: (name: string) => number | null = () => 50;
  const selected: string[] = [];
  const reasons: { reason: string; at: number }[] = [];
  const ctrl = new ChannelController({
    readChannel: () => channel(policy),
    probe: async (name) => probeFn(name),
    select: async (_group, name) => {
      selected.push(name);
    },
    persistReason: (reason, at) => reasons.push({ reason, at }),
    now: () => clock,
  });
  return {
    ctrl,
    selected,
    reasons,
    setClock: (t) => {
      clock = t;
    },
    setProbe: (fn) => {
      probeFn = fn;
    },
  };
}

describe("ChannelController sticky", () => {
  it("pins a best node on the first tick when AUTO points nowhere valid", async () => {
    const h = harness(stickyPolicy());
    h.setProbe((n) => (n === "B" ? 20 : 90));
    await h.ctrl.tick(view(["AUTO", "A", "B", "DIRECT"], null));
    expect(h.selected).toEqual(["B"]); // fastest
    expect(h.reasons.at(-1)?.reason).toContain("initial");
  });

  it("holds a healthy pinned node — no switch across many ticks", async () => {
    const h = harness(stickyPolicy());
    h.setProbe(() => 30); // always healthy
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A (in-candidate)
    const afterAdopt = h.selected.length;
    for (let i = 1; i <= 10; i++) {
      h.setClock(i * 60_000);
      await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    }
    expect(h.selected.length).toBe(afterAdopt); // never switched away
  });

  it("switches only after failureThreshold consecutive failures", async () => {
    const h = harness(stickyPolicy({ failureThreshold: 3 }));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A
    const base = h.selected.length;
    // A now dead, B healthy.
    h.setProbe((n) => (n === "A" ? null : 25));
    for (let i = 1; i <= 2; i++) {
      h.setClock(i * 60_000);
      await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    }
    expect(h.selected.length).toBe(base); // 2 failures < threshold: still holding
    h.setClock(3 * 60_000);
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("×3");
  });

  it("throttles health checks to intervalSec (a failure within the interval does not count)", async () => {
    const h = harness(stickyPolicy({ failureThreshold: 1, intervalSec: 60 }));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A at t=0
    const base = h.selected.length;
    h.setProbe((n) => (n === "A" ? null : 25));
    h.setClock(30_000); // < interval: skipped
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.length).toBe(base); // not checked yet
    h.setClock(60_000); // interval elapsed: one failure, threshold 1 → switch
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.at(-1)).toBe("B");
  });

  it("re-picks after maxHoldHours even while healthy", async () => {
    const h = harness(stickyPolicy({ maxHoldHours: 1 }));
    h.setProbe((n) => (n === "B" ? 10 : 90)); // B fastest
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A at t=0
    h.setClock(60 * 60_000 + 60_000); // > 1h later
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("max-hold");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -F @submerge/server test src/modules/channels/controller.test.ts`
Expected: FAIL — `tick` is still a stub; sticky behaviour missing.

- [ ] **Step 3: Implement sticky in `tick`**

In `packages/server/src/modules/channels/controller.ts`, add the import:

```ts
import { policyProbe } from "./service.js";
```

Replace the stub `tick` with a dispatcher + the sticky handler:

```ts
  async tick(view: NodeView): Promise<void> {
    const channel = this.deps.readChannel();
    const policy = channel.policy;
    if (policy.kind === "speed") {
      this.tickSpeed(view, channel.id); // Task 4
      return;
    }
    // Active policies (sticky/manual) health-check on the channel's own cadence,
    // not every poll — throttle to intervalSec (1 s slack for poll jitter).
    const { url, intervalSec } = policyProbe(policy);
    const t = this.deps.now();
    if (t - this.lastCheck < intervalSec * 1000 - 1000) return;
    this.lastCheck = t;
    if (policy.kind === "manual") {
      await this.tickManual(view, channel.id, policy, url, t); // Task 4
      return;
    }
    await this.tickSticky(view, channel.id, policy, url, t);
  }

  private async tickSticky(
    view: NodeView,
    channelId: string,
    policy: Extract<ChannelPolicy, { kind: "sticky" }>,
    url: string,
    at: number,
  ): Promise<void> {
    const candidates = selectableNames(view);
    if (candidates.length === 0) return;
    const active = view.autoNow;

    // No valid pin yet → choose the best node and pin it.
    if (!active || !candidates.includes(active)) {
      const best = await pickBest(candidates, url, policy.initialCriterion, this.deps.probe);
      if (best) await this.apply(channelId, active, best, `initial pick: ${best}`, at);
      this.failures = 0;
      return;
    }

    // Adopt a pre-existing valid pin without switching (start its hold window).
    if (this.heldSince === null) this.heldSince = at;

    // Forced refresh after max-hold, even while healthy.
    if (policy.maxHoldHours != null && at - this.heldSince >= policy.maxHoldHours * 3_600_000) {
      const best = await pickBest(candidates, url, policy.initialCriterion, this.deps.probe);
      if (best && best !== active) {
        await this.apply(channelId, active, best, `max-hold ${policy.maxHoldHours}h reached`, at);
        this.failures = 0;
        return;
      }
      this.heldSince = at; // same node stayed best — reset the window, keep holding
    }

    // Health-check the pinned node; count consecutive failures.
    const d = await this.deps.probe(active, url);
    if (d == null || d <= 0) this.failures++;
    else this.failures = 0;

    if (this.failures >= policy.failureThreshold) {
      const others = candidates.filter((c) => c !== active);
      const best = (await pickBest(others, url, policy.initialCriterion, this.deps.probe)) ?? active;
      await this.apply(channelId, active, best, `${active} failed ×${this.failures}`, at);
      this.failures = 0;
    }
  }
```

Add `ChannelPolicy` to the type import at the top of the file:

```ts
import type { Channel, ChannelPolicy, DecisionEntry, NodeView } from "@submerge/shared";
```

(`tickSpeed`/`tickManual` are added in Task 4; declare them as stubs now so the file compiles:)

```ts
  private tickSpeed(_view: NodeView, _channelId: string): void {}
  private async tickManual(
    _view: NodeView,
    _channelId: string,
    _policy: Extract<ChannelPolicy, { kind: "manual" }>,
    _url: string,
    _at: number,
  ): Promise<void> {}
```

- [ ] **Step 4: Run to verify sticky tests pass**

Run: `pnpm -F @submerge/server test src/modules/channels/controller.test.ts`
Expected: PASS (helper + sticky tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/channels/controller.ts packages/server/src/modules/channels/controller.test.ts
git commit -m "feat(server): sticky policy — pin, failure-count, switch, max-hold

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Speed reason reconstruction + manual ensure/fallback

**Files:**
- Modify: `packages/server/src/modules/channels/controller.ts`
- Test: `packages/server/src/modules/channels/controller.test.ts`

**Interfaces:**
- Produces: `tickSpeed` (records a decision when mihomo's url-test `AUTO.now` moves, with `X ms vs Y ms` when both delays are known); `tickManual` (selects the pinned node; if it's unreachable and `onFailure === "fallback"`, pins the best other node).

- [ ] **Step 1: Write failing tests**

Append to `packages/server/src/modules/channels/controller.test.ts`:

```ts
describe("ChannelController speed (passive)", () => {
  const speedPolicy = (): ChannelPolicy => ({
    kind: "speed",
    testUrl: "https://probe",
    intervalSec: 30,
    toleranceMs: 50,
    reevaluateWhileHealthy: true,
  });

  it("records a reason when AUTO.now moves, with the delta", async () => {
    const h = harness(speedPolicy());
    const v1: NodeView = {
      now: "AUTO",
      autoNow: "A",
      all: [node("A", 180), node("B", 40)],
    };
    await h.ctrl.tick(v1); // establishes lastSpeedNow = A, no reason yet
    expect(h.reasons.length).toBe(0);
    await h.ctrl.tick({ ...v1, autoNow: "B" });
    expect(h.reasons.at(-1)?.reason).toContain("A → B");
    expect(h.reasons.at(-1)?.reason).toContain("40");
    expect(h.selected.length).toBe(0); // speed is passive: never calls select
  });
});

describe("ChannelController manual", () => {
  const manualPolicy = (onFailure: "hold" | "fallback"): ChannelPolicy => ({
    kind: "manual",
    pinnedNode: "A",
    onFailure,
  });

  it("selects the pinned node when AUTO points elsewhere", async () => {
    const h = harness(manualPolicy("hold"));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "B"));
    expect(h.selected.at(-1)).toBe("A");
  });

  it("falls back to another node when the pin is down and onFailure=fallback", async () => {
    const h = harness(manualPolicy("fallback"));
    h.setProbe((n) => (n === "A" ? null : 20));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "B"));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("fell back");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -F @submerge/server test src/modules/channels/controller.test.ts`
Expected: FAIL — `tickSpeed`/`tickManual` are empty stubs.

- [ ] **Step 3: Implement `tickSpeed` and `tickManual`**

Replace the two stub methods in `controller.ts` with:

```ts
  // Passive: mihomo's url-test owns the switch; we only record WHY it moved.
  private tickSpeed(view: NodeView, channelId: string): void {
    const active = view.autoNow;
    if (this.lastSpeedNow && active && active !== this.lastSpeedNow) {
      const to = view.all.find((n) => n.name === active);
      const from = view.all.find((n) => n.name === this.lastSpeedNow);
      const delta =
        to?.delay != null && from?.delay != null ? ` (${to.delay} vs ${from.delay} ms)` : "";
      const at = this.deps.now();
      this.record({
        at,
        channelId,
        from: this.lastSpeedNow,
        to: active,
        reason: `faster: ${this.lastSpeedNow} → ${active}${delta}`,
      });
    }
    if (active) this.lastSpeedNow = active;
  }

  // Active: keep AUTO pinned to the chosen node; optionally fall back if it's down.
  private async tickManual(
    view: NodeView,
    channelId: string,
    policy: Extract<ChannelPolicy, { kind: "manual" }>,
    url: string,
    at: number,
  ): Promise<void> {
    const active = view.autoNow;
    const pin = policy.pinnedNode;
    const candidates = selectableNames(view);
    if (policy.onFailure === "fallback") {
      const d = await this.deps.probe(pin, url);
      if (d == null || d <= 0) {
        const others = candidates.filter((c) => c !== pin);
        const best = await pickBest(others, url, "fastest", this.deps.probe);
        if (best) {
          if (active !== best) {
            await this.apply(channelId, active, best, `${pin} down; fell back to ${best}`, at);
          }
          return;
        }
      }
    }
    if (active !== pin) await this.apply(channelId, active, pin, `pinned ${pin}`, at);
  }
```

- [ ] **Step 4: Run to verify all controller tests pass**

Run: `pnpm -F @submerge/server test src/modules/channels/controller.test.ts`
Expected: PASS (helpers + sticky + speed + manual).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/channels/controller.ts packages/server/src/modules/channels/controller.test.ts
git commit -m "feat(server): speed reason reconstruction + manual ensure/fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire the controller into the live loop + expose `recentDecisions`

**Files:**
- Create: `packages/server/src/modules/channels/instance.ts`
- Modify: `packages/server/src/live/singleton.ts`
- Modify: `packages/server/src/modules/channels/router.ts`
- Test: manual/typecheck (integration) — covered by the full suite gate.

**Interfaces:**
- Consumes: `ChannelController`, `readDefaultChannel`, `setChannelLastReason`, `testDelay` (nodes service) or `getDelay`/`selectProxy` (mihomo client), `DEFAULT_CHANNEL_ID`.
- Produces: `channelController` singleton (wired to real deps); `LiveHub` `afterView` calls `channelController.tick`; tRPC `channels.recentDecisions` returns `DecisionEntry[]`.

- [ ] **Step 1: Create the wired singleton**

Create `packages/server/src/modules/channels/instance.ts`:

```ts
import { getDelay, selectProxy } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { ChannelController } from "./controller.js";
import { DEFAULT_CHANNEL_ID, readDefaultChannel, setChannelLastReason } from "./service.js";

// The single controller for the Default channel (Phase 2). Deps bind it to the real
// db + mihomo client; `probe` maps a timeout/unreachable node to null so the sticky
// failure counter advances instead of throwing.
export const channelController = new ChannelController({
  readChannel: () => readDefaultChannel(db),
  probe: async (name, url) => {
    try {
      const { delay } = await getDelay(name, url);
      return delay > 0 ? delay : null;
    } catch {
      return null;
    }
  },
  select: selectProxy,
  persistReason: (reason, at) => setChannelLastReason(db, DEFAULT_CHANNEL_ID, reason, at),
  now: () => Date.now(),
});
```

- [ ] **Step 2: Hook it into the live poll**

In `packages/server/src/live/singleton.ts`, import the controller and add the `afterView` dep to the `LiveHub` config:

```ts
import { channelController } from "../modules/channels/instance.js";
```

Add to the `new LiveHub({ ... })` deps object (alongside `fetchTotals`):

```ts
  afterView: (view) => channelController.tick(view),
```

- [ ] **Step 3: Expose recent decisions over tRPC**

In `packages/server/src/modules/channels/router.ts`, add the import and query:

```ts
import { channelController } from "./instance.js";
```

Add to the `channelsRouter` object:

```ts
  recentDecisions: protectedProcedure.query(() => channelController.recent()),
```

- [ ] **Step 4: Verify the full suite + typecheck**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: all green. Watch for import cycles — `instance.ts` imports `service.js` + `controller.js` + clients; `singleton.ts` and `router.ts` import `instance.js`. No cycle back into `singleton.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/channels/instance.ts packages/server/src/live/singleton.ts packages/server/src/modules/channels/router.ts
git commit -m "feat(server): run the channel controller each live poll + expose decisions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Web — policy selector (speed | sticky) + sticky knobs

**Files:**
- Modify: `packages/web/src/features/settings/SettingsScreen.tsx`
- Test: `pnpm -F @submerge/web test` + manual visual check.

**Interfaces:**
- Consumes: `trpc.channels.get`, `trpc.channels.setPolicy`, `ChannelPolicy`, existing UI primitives (`components/ui/segmented`, `input`, `switch`).
- Produces: a segmented **Политика** control (`По задержке` = speed | `Стабильный IP` = sticky) on the auto-select settings card; when sticky, editable **Порог сбоев**, **Интервал проверки**, **Проверочный URL**, **Держать не дольше** (hours, empty = ∞), **Критерий выбора** (Быстрейший | Наименьшие потери).

- [ ] **Step 1: Design-system check (do not invent UI)**

Open `pencil/web-ui.pen` (Pencil MCP `batch_get` on the Settings frame, `resolveVariables:true`) and check whether a policy/strategy control and sticky parameters are specified. If present, match its control types, tokens, and labels exactly. If absent, treat the segmented control + input rows below as a minimal extension using existing tokens/components only (no new gradients/radii); note in the PR that a mockup for the sticky controls is a follow-up so the design owner can refine.

- [ ] **Step 2: Add the policy segmented control + sticky fields**

In `SettingsScreen.tsx`, extend the auto-select card. Building on Phase 1's `channelQuery`/`policy`/`setPolicy`/`updateSpeed`, add a policy switch and sticky editors. Concrete additions:

```tsx
import { Segmented } from "@/components/ui/segmented"; // match the existing import path/casing

// Switch the Default channel between the speed and sticky policies, carrying over
// shared fields (testUrl/intervalSec) and seeding the rest with sane defaults.
function switchPolicy(kind: "speed" | "sticky") {
  if (!policy || policy.kind === kind) return;
  const testUrl = "testUrl" in policy ? policy.testUrl : "https://www.gstatic.com/generate_204";
  const intervalSec = "intervalSec" in policy ? policy.intervalSec : 60;
  const next: ChannelPolicy =
    kind === "speed"
      ? { kind: "speed", testUrl, intervalSec, toleranceMs: 50, reevaluateWhileHealthy: true }
      : {
          kind: "sticky",
          testUrl,
          intervalSec,
          failureThreshold: 3,
          maxHoldHours: null,
          initialCriterion: "fastest",
        };
  setPolicy.mutate({ id: "default", policy: next });
}

function updateSticky(patch: Partial<Extract<ChannelPolicy, { kind: "sticky" }>>) {
  if (policy?.kind !== "sticky") return;
  setPolicy.mutate({ id: "default", policy: { ...policy, ...patch } });
}
```

Render, above the existing param rows:

```tsx
<Segmented
  aria-label="Политика выбора"
  value={policy?.kind === "sticky" ? "sticky" : "speed"}
  onChange={(v) => switchPolicy(v as "speed" | "sticky")}
  options={[
    { value: "speed", label: "По задержке" },
    { value: "sticky", label: "Стабильный IP" },
  ]}
/>
```

When `policy?.kind === "sticky"`, render editable rows (reuse the existing input row component/pattern used for the speed URL/interval), bound to:
- **Порог сбоев** → `failureThreshold` (integer ≥ 1) → `updateSticky({ failureThreshold: n })`
- **Интервал проверки, с** → `intervalSec` (≥ 1) → `updateSticky({ intervalSec: n })`
- **Проверочный URL** → `testUrl` → `updateSticky({ testUrl: v })`
- **Держать не дольше, ч** → `maxHoldHours` (empty → `null`) → `updateSticky({ maxHoldHours: v === "" ? null : Number(v) })`
- **Критерий выбора** → `initialCriterion` segmented (`Быстрейший`=fastest | `Наименьшие потери`=lowest-loss) → `updateSticky({ initialCriterion: v })`

Keep the speed card (Phase 1) rendered only when `policy?.kind === "speed"`.

- [ ] **Step 3: Typecheck + web tests + lint**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm -F @submerge/web test`
Expected: green. Resolve any exhaustiveness warnings on the policy union.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/features/settings/SettingsScreen.tsx
git commit -m "feat(web): policy selector + sticky knobs on the Default channel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Web — surface the last decision ("why it switched")

**Files:**
- Modify: `packages/web/src/features/nodes/AutoStrategyCard.tsx`
- Modify: `packages/web/src/features/settings/SettingsScreen.tsx`
- Test: `pnpm -F @submerge/web test` + manual visual check.

**Interfaces:**
- Consumes: `trpc.channels.get` (`lastReason`, `lastReasonAt`), optionally `trpc.channels.recentDecisions`, the existing `formatRelative`/duration helper in `@/lib/duration`.
- Produces: the auto-select card status line shows the persisted last decision + relative time; the Settings card lists recent decisions.

- [ ] **Step 1: Pass the last reason into `AutoStrategyCard`**

Extend `AutoStrategyCardProps` with an optional `lastDecision?: { reason: string; at: number | null }`. In the status footer (the block at the bottom rendering `status`), when `lastDecision?.reason` is present, render a second line:

```tsx
{lastDecision?.reason && (
  <span className="font-mono text-xs text-text-tertiary">
    {lastDecision.reason}
    {lastDecision.at ? ` · ${formatRelative(lastDecision.at)}` : ""}
  </span>
)}
```

Use the existing relative-time helper from `@/lib/duration` (import it; if only an interval formatter exists, add a minimal `formatRelative(epochMs: number): string` there returning e.g. `2 ч назад`, with its own unit test).

- [ ] **Step 2: Feed it from the channel query**

Where `SettingsScreen.tsx` renders `AutoStrategyCard`, pass:

```tsx
lastDecision={{
  reason: channelQuery.data?.lastReason ?? "",
  at: channelQuery.data?.lastReasonAt ?? null,
}}
```

Below the policy controls, add a compact **История решений** list from `trpc.channels.recentDecisions.useQuery()` — each row: `reason · relative-time` (newest first, cap the visible count at ~10). Empty state: "Пока нет переключений".

- [ ] **Step 3: Typecheck + web tests + lint**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm -F @submerge/web test`
Expected: green (including any new `formatRelative` unit test).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/features/nodes/AutoStrategyCard.tsx packages/web/src/features/settings/SettingsScreen.tsx packages/web/src/lib/duration.ts
git commit -m "feat(web): surface the last controller decision + history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Final Phase-2 verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 2: Sticky end-to-end (live)**

With ≥2 working nodes: set the Default channel to **Стабильный IP** (`failureThreshold: 2`, short `intervalSec` e.g. 15 for the test). Confirm: (a) the server pins one node (AUTO group shows a fixed `now`), (b) it does **not** rotate while healthy across several intervals, (c) forcing the pinned node to fail (disable that source/node) causes a switch after exactly 2 checks, and (d) the switch reason appears in Settings → История решений and on the node card. Restore `intervalSec` afterward.

- [ ] **Step 3: Speed reason (live)**

Switch to **По задержке**; when the active node changes, confirm a `faster: A → B (… ms)` entry is recorded and the server never calls select for it (mihomo drives it).

- [ ] **Step 4: Risky states**

Check: empty node pool (no sources) — controller no-ops, no crash, health stays green. Single node — sticky pins it and never switches (no alternative). Engine unreachable mid-tick — the poll survives (health flips, no unhandled rejection).

- [ ] **Step 5: Visual gate**

Settings at **1440×1024 dark** and the **390** breakpoint: policy segmented, sticky knobs, and История решений render without overflow/clipping; controls are live (editing persists across reload). Cross-check the mockup per Task 6 Step 1.

- [ ] **Step 6: Incremental review**

Review the whole Phase-2 diff against spec §5 (sticky), §6 (controller), §7 (observability), and the honesty gate (no faked loss/bandwidth). Then run `/code-review` on the branch and resolve findings before shipping.

---

## Self-Review

**Spec coverage (`docs/specs/2026-07-01-channel-routing-design.md`):**
- §5 `sticky` policy (server pin, hold-until-dead, `failureThreshold`, `maxHoldHours`, `initialCriterion`) → Tasks 3, 5, 6. `initialCriterion` is really backed: `fastest` = single probe, `lowest-loss` = multi-sample success ranking (Task 2 `pickBest`). `highest-bandwidth` intentionally absent (Phase 4).
- §5 `manual` policy → Task 4 (controller); no new UI (existing PROXY manual pin covers the UX) — documented in Out of scope.
- §5 `speed` scoring reason → Task 4 `tickSpeed`.
- §6 controller (single loop, throttled probes, best-effort) → Tasks 1 (`afterView`), 3 (throttle), 5 (wiring). Reuses the existing poll — no new fleet.
- §7 observability (in-memory ring + persisted last reason; "why" UI) → Tasks 2 (`record`/ring), 5 (`recentDecisions`), 7 (UI).

**Gaps (intentional):** multi-channel controllers, per-channel rules/pools (Phase 3); on-demand bandwidth + `highest-bandwidth` + passive Mbps display (Phase 4). None are Phase-2 deliverables.

**Placeholder scan:** none — the two `tickSpeed`/`tickManual` stubs in Task 3 are explicit compile-time placeholders **filled in Task 4**, called out in both tasks (not left as TODOs).

**Type consistency:** `ChannelController(tick/recent)`, `ControllerDeps` fields (`readChannel`/`probe`/`select`/`persistReason`/`now`/`ringSize`), `selectableNames`, `pickBest(names,url,criterion,probe,samples)`, and `DecisionEntry {at,channelId,from,to,reason}` are used identically across Tasks 2–7. `channels.setPolicy` input (`{id:"default", policy}`) matches Phase 1's router. `afterView: (view) => channelController.tick(view)` matches the `HubDeps.afterView` signature from Task 1. `policyProbe` reused from Phase 1 (not redefined).
