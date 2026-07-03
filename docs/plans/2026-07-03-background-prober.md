# Background Node Prober Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every node has a latency measurement no older than N («Интервал проверки»), regardless of policy or config reloads — via a server-side rolling prober; selection logic is untouched.

**Architecture:** A new `Prober` class observes each `/proxies` snapshot (freshness from mihomo history timestamps) and, on every internal 5 s pulse, probes the stale nodes in rolling batches through the existing `getDelay` client (mihomo records results into history, so the existing view/SSE path picks them up with no new plumbing). The user-visible `pollInterval` setting is retired; the pulse becomes an internal constant. The now-redundant active-node probe throttle is removed (the prober covers the active node at the same cadence).

**Tech Stack:** TypeScript (strict), Vitest, tRPC v11, React 19. Spec: `docs/specs/2026-07-03-background-prober-design.md`.

**File structure:**

- Create: `packages/server/src/live/prober.ts` — the rolling prober (pure logic, deps injected)
- Create: `packages/server/src/live/prober.test.ts`
- Modify: `packages/server/src/live/singleton.ts` — wire prober; internal pulse constant; drop `probeActiveThrottled` and the `pollInterval` setting read
- Rewrite: `packages/server/src/live/singleton.test.ts` — wiring tests replace throttle tests
- Modify: `packages/server/src/live/hub.ts` + `hub.test.ts` — remove the superseded `probeActive`/`lastActive` path
- Modify: `packages/shared/src/defaults.ts` — re-document `DEFAULT_POLL_INTERVAL` as the internal pulse
- Modify: `packages/web/src/features/settings/SettingsScreen.tsx` — remove the «Опрос каждые» row
- Modify: `packages/web/src/features/nodes/NodesScreen.tsx`, `NodesHeader.tsx` — header copy «проверка каждые N»
- Modify: `docs/specs/README.md`, `docs/plans/README.md`, spec status — on completion

**Conventions (repeat for every task):** run checks with raw biome — `./node_modules/.bin/biome ci packages/` (NOT `pnpm lint`); server tests: `pnpm -F @submerge/server exec vitest run <file>`; web tests: `pnpm -F @submerge/web exec vitest run <file>`; full gate before each commit: `./node_modules/.bin/biome check --write packages/ && ./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test`. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Prober — freshness observation and stale-only probing

**Files:**
- Create: `packages/server/src/live/prober.ts`
- Test: `packages/server/src/live/prober.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/live/prober.test.ts
import { describe, expect, it, vi } from "vitest";
import type { ProxiesResponse } from "../clients/mihomo.js";
import { Prober } from "./prober.js";

// PROXY.all lists AUTO (pseudo, must be ignored) + the real node names.
// `times[name]` = ISO timestamp of the node's latest measurement (absent = never).
function resp(names: string[], times: Record<string, string> = {}): ProxiesResponse {
  const proxies: Record<string, unknown> = {
    PROXY: { name: "PROXY", type: "Selector", all: ["AUTO", ...names], history: [] },
    AUTO: { name: "AUTO", type: "URLTest", history: [] },
  };
  for (const n of names) {
    proxies[n] = {
      name: n,
      type: "vless",
      history: times[n] ? [{ time: times[n], delay: 50 }] : [],
    };
  }
  return { proxies } as ProxiesResponse;
}

const T0 = 1_000_000_000_000; // fixed "now" for deterministic staleness math

function makeProber(over: { intervalSec?: number; nowMs?: () => number } = {}) {
  const probe = vi.fn(async () => ({}));
  const prober = new Prober({
    probe,
    getProbeConfig: () => ({ url: "https://t/check", intervalSec: over.intervalSec ?? 60 }),
    pulseMs: 5000,
    now: over.nowMs ?? (() => T0),
  });
  return { prober, probe };
}

describe("Prober staleness", () => {
  it("probes only nodes without a fresh measurement", async () => {
    const { prober, probe } = makeProber();
    prober.observe(
      resp(["fresh", "stale", "never"], {
        fresh: new Date(T0 - 1_000).toISOString(), // 1 s ago — fresh
        stale: new Date(T0 - 120_000).toISOString(), // 2 min ago — older than N=60 s
      }),
    );
    await prober.tick();
    const probed = probe.mock.calls.map((c) => c[0]).sort();
    expect(probed).toEqual(["never", "stale"]);
    expect(probe).toHaveBeenCalledWith("stale", "https://t/check");
  });

  it("ignores pseudo names and probes nothing when everything is fresh", async () => {
    const { prober, probe } = makeProber();
    prober.observe(resp(["a"], { a: new Date(T0 - 1_000).toISOString() }));
    await prober.tick();
    expect(probe).not.toHaveBeenCalled();
  });

  it("drops vanished nodes on the next observe", async () => {
    const { prober, probe } = makeProber();
    prober.observe(resp(["a", "b"]));
    prober.observe(resp(["a"])); // b vanished (reload/rename)
    await prober.tick();
    expect(probe.mock.calls.map((c) => c[0])).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm -F @submerge/server exec vitest run src/live/prober.test.ts`
Expected: FAIL — `Cannot find module './prober.js'`.

- [ ] **Step 3: Implement the minimal Prober**

```ts
// packages/server/src/live/prober.ts
import { PSEUDO_NODE_SET } from "@submerge/shared";
import type { ProxiesResponse } from "../clients/mihomo.js";

export interface ProberDeps {
  // getDelay(name, url) — the result is ignored here; mihomo records it into
  // the node's history, which the normal view/SSE path already surfaces.
  probe: (name: string, url: string) => Promise<unknown>;
  // The single user knob: «Интервал проверки» (+ its test URL) from the policy.
  getProbeConfig: () => { url: string; intervalSec: number };
  pulseMs: number; // internal pulse length (how often tick() runs)
  concurrency?: number; // hard cap per tick (default 10)
  now?: () => number;
}

// Gap-filling measurement loop (spec §4.1): keeps every real node's latency
// measurement fresher than «Интервал проверки». Only probes nodes WITHOUT a
// fresh measurement — under the speed policy mihomo's url-test keeps most
// nodes fresh and the prober fills the gaps (post-reload, select-policy nodes).
export class Prober {
  private names: string[] = []; // rotation order
  private cursor = 0;
  private lastSeen = new Map<string, number>(); // mihomo's latest measurement
  private lastAttempt = new Map<string, number>(); // our latest probe attempt

  constructor(private readonly deps: ProberDeps) {}

  // Digest a /proxies snapshot: refresh the node set (rotation keeps its order,
  // new names append, vanished names drop) and each node's latest-measured time.
  observe(resp: ProxiesResponse): void {
    const current = (resp.proxies.PROXY?.all ?? []).filter((n) => !PSEUDO_NODE_SET.has(n));
    const currentSet = new Set(current);
    this.names = this.names.filter((n) => currentSet.has(n));
    for (const n of current) if (!this.names.includes(n)) this.names.push(n);
    for (const k of [...this.lastSeen.keys()]) if (!currentSet.has(k)) this.lastSeen.delete(k);
    for (const k of [...this.lastAttempt.keys()])
      if (!currentSet.has(k)) this.lastAttempt.delete(k);
    if (this.cursor >= this.names.length) this.cursor = 0;
    for (const n of current) {
      const t = resp.proxies[n]?.history.at(-1)?.time;
      if (t) {
        const ms = Date.parse(t);
        if (Number.isFinite(ms)) this.lastSeen.set(n, ms);
      }
    }
  }

  // Probe the next rolling batch of stale nodes. Batch size spreads a full
  // sweep across the check interval: ceil(total × pulse / interval), min 1,
  // capped by `concurrency` so a tiny interval can't burst 90 parallel probes.
  async tick(): Promise<void> {
    if (this.names.length === 0) return;
    const { url, intervalSec } = this.deps.getProbeConfig();
    const now = (this.deps.now ?? Date.now)();
    const staleMs = intervalSec * 1000;
    const isStale = (n: string) => {
      const seen = this.lastSeen.get(n) ?? Number.NEGATIVE_INFINITY;
      const tried = this.lastAttempt.get(n) ?? Number.NEGATIVE_INFINITY;
      return Math.max(seen, tried) <= now - staleMs;
    };
    const batch = Math.min(
      this.deps.concurrency ?? 10,
      Math.max(1, Math.ceil((this.names.length * this.deps.pulseMs) / staleMs)),
    );
    const picked: string[] = [];
    let lastOffset = -1;
    for (let step = 0; step < this.names.length && picked.length < batch; step++) {
      const idx = (this.cursor + step) % this.names.length;
      const name = this.names[idx] as string;
      if (isStale(name)) {
        picked.push(name);
        lastOffset = step;
      }
    }
    if (picked.length === 0) return;
    this.cursor = (this.cursor + lastOffset + 1) % this.names.length;
    // lastAttempt guards against hot-looping on dead nodes: a failed probe may
    // record nothing in mihomo, so without it the node would be re-probed every
    // pulse forever.
    for (const n of picked) this.lastAttempt.set(n, now);
    await Promise.allSettled(picked.map((n) => this.deps.probe(n, url)));
  }
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm -F @submerge/server exec vitest run src/live/prober.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/live/prober.ts packages/server/src/live/prober.test.ts
git commit -m "feat(server): rolling prober — stale-only node probing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Prober — batch sizing, rotation, concurrency cap, retry guard

**Files:**
- Modify: `packages/server/src/live/prober.test.ts` (implementation from Task 1 should already satisfy these — this task pins the behavior with tests)

- [ ] **Step 1: Add the failing/pinning tests**

Append to `describe`-level scope in `packages/server/src/live/prober.test.ts`:

```ts
describe("Prober batching", () => {
  it("sweeps ceil(total × pulse / interval) per tick and rotates round-robin", async () => {
    // 12 nodes, pulse 5 s, N=30 s → batch = ceil(12×5/30) = 2 per tick
    const { prober, probe } = makeProber({ intervalSec: 30 });
    const names = Array.from({ length: 12 }, (_, i) => `n${i}`);
    prober.observe(resp(names));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(2);
    const first = probe.mock.calls.map((c) => c[0]);
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(4);
    const second = probe.mock.calls.slice(2).map((c) => c[0]);
    // rotation: the second tick probes DIFFERENT nodes
    expect(second.some((n) => first.includes(n))).toBe(false);
  });

  it("caps a burst at the concurrency limit", async () => {
    // 90 nodes, N=5 s → raw batch 90, capped at 10
    const { prober, probe } = makeProber({ intervalSec: 5 });
    prober.observe(resp(Array.from({ length: 90 }, (_, i) => `n${i}`)));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(10);
  });

  it("never re-attempts a failing node within the interval", async () => {
    let nowMs = T0;
    const probe = vi.fn(async () => {
      throw new Error("unreachable");
    });
    const prober = new Prober({
      probe,
      getProbeConfig: () => ({ url: "u", intervalSec: 60 }),
      pulseMs: 5000,
      now: () => nowMs,
    });
    prober.observe(resp(["dead"]));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(1);
    nowMs += 5000; // next pulse — still within N
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(1); // guarded by lastAttempt
    nowMs += 60_000; // interval elapsed
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes at least one node even when the batch formula rounds to <1", async () => {
    // 1 node, pulse 5 s, N=300 s → ceil(1×5/300) < 1 → floor to 1
    const { prober, probe } = makeProber({ intervalSec: 300 });
    prober.observe(resp(["only"]));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — expect green (behavior pinned) or fix**

Run: `pnpm -F @submerge/server exec vitest run src/live/prober.test.ts`
Expected: 7 passed. If any batching test fails, fix `tick()` (not the tests) until green.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/live/prober.test.ts
git commit -m "test(server): pin prober batching, rotation, cap and retry guard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Remove the superseded active-node probe path from the hub

The prober measures the active node at the same cadence the old throttle did, so `HubDeps.probeActive` + `lastActive` become dead weight.

**Files:**
- Modify: `packages/server/src/live/hub.ts`
- Modify: `packages/server/src/live/hub.test.ts`

- [ ] **Step 1: Delete the two obsolete hub tests**

In `packages/server/src/live/hub.test.ts` delete the tests
`"probes the active node on the poll after it becomes active"` and
`"keeps polling when an active-node probe rejects"` (both construct `probeActive`).

- [ ] **Step 2: Remove the path from the hub**

In `packages/server/src/live/hub.ts`:
- delete the `probeActive?: (name: string) => Promise<void>;` member (and its comment) from `HubDeps`;
- delete the `private lastActive: string | null = null;` field;
- in `pollOnce()`, delete the leading block:

```ts
      // Probe the previously-active node first so this poll's view already carries
      // a fresh measurement (best-effort: a failed probe must not abort the poll).
      if (this.lastActive && this.deps.probeActive) {
        try {
          await this.deps.probeActive(this.lastActive);
        } catch {
          /* unreachable node / probe error — mihomo still records it; keep polling */
        }
      }
```

- and delete the line `this.lastActive = view.now === "AUTO" ? view.autoNow : view.now;` (with its comment).

- [ ] **Step 3: Run the hub tests**

Run: `pnpm -F @submerge/server exec vitest run src/live/hub.test.ts`
Expected: all remaining tests pass; typecheck the package too: `pnpm typecheck`.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/live/hub.ts packages/server/src/live/hub.test.ts
git commit -m "refactor(server): drop hub probeActive path — superseded by the prober

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the prober into the live singleton; internal pulse constant

**Files:**
- Modify: `packages/shared/src/defaults.ts`
- Modify: `packages/server/src/live/singleton.ts`
- Rewrite: `packages/server/src/live/singleton.test.ts`

- [ ] **Step 1: Re-document the pulse constant in shared defaults**

In `packages/shared/src/defaults.ts` replace:

```ts
/** Seconds between panel polls of mihomo (latency/traffic refresh + engine health). */
export const DEFAULT_POLL_INTERVAL = 5;
```

with:

```ts
/** INTERNAL pulse (seconds): how often the server reads mihomo state and runs a
 *  prober batch. Not user-configurable — the one user knob is the policy's
 *  «Интервал проверки» (see docs/specs/2026-07-03-background-prober-design.md). */
export const DEFAULT_POLL_INTERVAL = 5;
```

- [ ] **Step 2: Rewrite the singleton wiring**

Replace the whole `packages/server/src/live/singleton.ts` with:

```ts
import { DEFAULT_POLL_INTERVAL } from "@submerge/shared";
import { getDelay, getProxies, getTotals, streamTraffic } from "../clients/mihomo.js";
import { db } from "../db/client.js";
import { log } from "../log.js";
import { channelController } from "../modules/channels/instance.js";
import { policyProbe, readDefaultPolicy } from "../modules/channels/service.js";
import { collectProxies, proxyMeta, toNodeView } from "../modules/nodes/service.js";
import { LiveHub } from "./hub.js";
import { Prober } from "./prober.js";

// The internal pulse. Reading mihomo state must stay fast regardless of the
// user's check interval, so this is a constant, not a setting (spec §4.2).
const PULSE_MS = DEFAULT_POLL_INTERVAL * 1000;

// Keeps every node's measurement fresher than «Интервал проверки» (spec §4.1).
// Probes go through getDelay → mihomo records them → the normal view path
// (fetchView below) surfaces them; observe() feeds freshness back in.
export const prober = new Prober({
  probe: (name, url) => getDelay(name, url),
  getProbeConfig: () => policyProbe(readDefaultPolicy(db)),
  pulseMs: PULSE_MS,
});

export const liveHub = new LiveHub({
  fetchView: async () => {
    const raw = await getProxies();
    prober.observe(raw);
    return toNodeView(raw, proxyMeta(collectProxies(db)));
  },
  streamTraffic,
  getInterval: () => PULSE_MS,
  fetchTotals: getTotals,
  afterView: async (view) => {
    await channelController.tick(view);
    // After the controller so a policy switch this tick can't race the batch.
    await prober.tick();
  },
  // The hub reports once per outage streak, so this can't flood the log.
  onError: (scope, err) => log.warn({ scope, err }, "mihomo live %s failed", scope),
});
```

Note: `getSetting`/`settings/service` and `MIHOMO_BUILTIN_POLICIES` imports are gone.

- [ ] **Step 3: Rewrite the singleton tests (wiring, not throttle)**

Replace the whole `packages/server/src/live/singleton.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../log.js", () => ({ log: { warn: vi.fn() } }));
vi.mock("../clients/mihomo.js", () => ({
  getDelay: vi.fn(async () => ({ delay: 42 })),
  getProxies: vi.fn(async () => ({
    proxies: { PROXY: { name: "PROXY", type: "Selector", all: ["A"], history: [] } },
  })),
  getTotals: vi.fn(),
  streamTraffic: vi.fn(),
}));
vi.mock("../modules/channels/instance.js", () => ({
  channelController: { tick: vi.fn(async () => {}) },
}));
vi.mock("../modules/channels/service.js", () => ({
  policyProbe: vi.fn(() => ({ url: "https://probe/check", intervalSec: 30 })),
  readDefaultPolicy: vi.fn(() => ({})),
}));
vi.mock("../modules/nodes/service.js", () => ({
  collectProxies: vi.fn(() => []),
  proxyMeta: vi.fn(),
  toNodeView: vi.fn(() => ({ now: null, autoNow: null, all: [] })),
}));

async function load() {
  vi.resetModules();
  vi.clearAllMocks();
  const channels = await import("../modules/channels/instance.js");
  const singleton = await import("./singleton.js");
  return { ...singleton, controllerTick: vi.mocked(channels.channelController.tick) };
}

describe("live singleton wiring", () => {
  it("fetchView feeds each raw snapshot into prober.observe", async () => {
    const { liveHub, prober } = await load();
    const observe = vi.spyOn(prober, "observe");
    await liveHub.pollOnce();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toHaveProperty("proxies.PROXY");
  });

  it("afterView runs the controller first, then a prober tick", async () => {
    const { liveHub, prober, controllerTick } = await load();
    const order: string[] = [];
    controllerTick.mockImplementation(async () => {
      order.push("controller");
    });
    const tick = vi.spyOn(prober, "tick").mockImplementation(async () => {
      order.push("prober");
    });
    await liveHub.pollOnce();
    expect(order).toEqual(["controller", "prober"]);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run server tests + typecheck**

Run: `pnpm -F @submerge/server exec vitest run && pnpm typecheck`
Expected: all pass (the old throttle tests are gone; prober tests cover that logic).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/defaults.ts packages/server/src/live/singleton.ts packages/server/src/live/singleton.test.ts
git commit -m "feat(server): wire the prober into the live pulse; pollInterval becomes internal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Settings UI — remove the «Опрос каждые» row

**Files:**
- Modify: `packages/web/src/features/settings/SettingsScreen.tsx`

- [ ] **Step 1: Remove the poll-interval control and its plumbing**

In `packages/web/src/features/settings/SettingsScreen.tsx`:

1. Delete the preset list (line ~28):

```ts
const POLL_PRESETS = [1, 2, 5, 10, 30];
```

2. The engine-health refetch cadence becomes the internal constant — replace:

```ts
const pollMs = (Number(data?.pollInterval) || DEFAULT_POLL_INTERVAL) * 1000;
```

with:

```ts
const pollMs = DEFAULT_POLL_INTERVAL * 1000;
```

3. Delete the variable (line ~169):

```ts
const pollInterval = data?.pollInterval ?? String(DEFAULT_POLL_INTERVAL);
```

4. Delete the whole settings row (the `Row`/field block around lines ~440-452) whose
`<Select>` has `onChange={(e) => settingsMutation.mutate({ key: "pollInterval", value: e.target.value })}`
and renders `{secondsOptions(POLL_PRESETS, pollInterval)}` — remove the entire row
element including its label («Опрос каждые…») and description.

- [ ] **Step 2: Gates**

Run: `./node_modules/.bin/biome check --write packages/ && ./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm -F @submerge/web test`
Expected: clean (unused `secondsOptions` may now have one caller left — the check-interval row; keep it).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/features/settings/SettingsScreen.tsx
git commit -m "feat(web): retire the poll-interval setting — the pulse is internal now

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Nodes header copy — «проверка каждые N»

**Files:**
- Modify: `packages/web/src/features/nodes/NodesScreen.tsx`
- Modify: `packages/web/src/features/nodes/NodesHeader.tsx`

- [ ] **Step 1: Pass the check interval instead of the poll interval**

In `NodesScreen.tsx`: delete the `pollInterval` computation (lines ~35-38, the
`Math.max(...settingsQuery.data?.pollInterval...)` block) and pass the policy's
check interval instead. The screen already has `channelQuery`:

```ts
const policy = channelQuery.data?.policy;
const checkIntervalSec =
  policy && "intervalSec" in policy ? policy.intervalSec : null;
```

and change the header usage:

```tsx
<NodesHeader
  nodeCount={...}
  checkIntervalSec={checkIntervalSec}
  ...
/>
```

(remove the old `pollInterval={pollInterval}` prop; drop the now-unused
`DEFAULT_POLL_INTERVAL`/settings imports if nothing else uses them).

- [ ] **Step 2: Render the copy in `NodesHeader.tsx`**

Replace the `pollInterval: number` prop with `checkIntervalSec: number | null` and
the subtitle line with:

```tsx
<p className="text-sub text-text-secondary">
  Группа PROXY · {nodeCount} {pluralRu(nodeCount, ["узел", "узла", "узлов"])}
  {checkIntervalSec != null && <> · проверка каждые {formatInterval(checkIntervalSec)}</>}
</p>
```

adding `import { formatInterval } from "@/lib/duration";`. For the `manual` policy
(no `intervalSec`) the tail is simply omitted — honest: nothing is periodically
checked by policy there beyond the prober's default cadence.

- [ ] **Step 3: Gates**

Run: `./node_modules/.bin/biome check --write packages/ && ./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm -F @submerge/web test && pnpm -F @submerge/web build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/features/nodes
git commit -m "feat(web): nodes header shows the check interval, not the internal pulse

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Live verification on the stand + docs

**Files:**
- Modify: `docs/specs/2026-07-03-background-prober-design.md` (status)
- Modify: `docs/specs/README.md`, `docs/plans/README.md` (indexes)

- [ ] **Step 1: Rebuild web + restart the dev stand**

```bash
pnpm -F @submerge/web build
lsof -nP -iTCP:3100 -sTCP:LISTEN -t | xargs kill -9; sleep 2
# start the dev server exactly as before (PORT=3100, .local-run DB, mihomo :9091, decoder :8088)
```

- [ ] **Step 2: Verify P2 (all nodes fresher than N)**

Set «Интервал проверки» to 30 s in the panel. Within ~35 s every real node —
including the singles (Discord, Германия, Telegram) — must show a number or
`timeout`, no «— ms». Check via:

```bash
curl -s http://127.0.0.1:3100/trpc/nodes.list | python3 -c "
import json,sys
d=json.load(sys.stdin)['result']['data']['all']
print('unmeasured:', [n['name'] for n in d if n['delay'] is None])"
```

Expected: `unmeasured: []` (pseudo entries excluded from `all` by design).

- [ ] **Step 3: Verify reload recovery**

Change any setting (e.g. tolerance) → config reloads, history wipes. Within one
interval all nodes must be measured again (repeat the command above).

- [ ] **Step 4: Update docs and commit**

- Spec header: `Status: Draft (approved for planning)` → `Status: Implemented`.
- `docs/specs/README.md`: row status → `implemented`.
- `docs/plans/README.md`: add `| [Background prober](2026-07-03-background-prober.md) | done |`.

```bash
git add docs/
git commit -m "docs: background prober shipped — statuses and indexes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Final review gate**

Run `/code-review` on the branch diff (`master...feat/background-prober`) and resolve findings before offering to merge.
