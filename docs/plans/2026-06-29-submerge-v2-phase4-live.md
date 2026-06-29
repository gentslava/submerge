# Phase 4 — Live data (SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web's polling with a real-time stream — a server-side SSE hub that polls mihomo and pumps its traffic stream, fanned out to the web over a tRPC `live` subscription, so node status, per-node latency, and up/down traffic update live (no 5 s refetch), with a live uPlot traffic chart.

**Architecture:** A single in-process **LiveHub** (EventEmitter singleton) on the server polls mihomo `/proxies` on a settings-driven interval and consumes mihomo's streaming `/traffic` endpoint; it emits typed `nodeUpdate` / `traffic` / `health` events. A tRPC `live` subscription (async generator over SSE, tRPC v11) yields the current snapshot then forwards hub events. The web adds `httpSubscriptionLink` (SSE) via `splitLink`, subscribes once in a `useLive` hook, patches the `nodes.list` Query cache per snapshot (dropping `refetchInterval`), feeds a throttled ring buffer to a uPlot bar chart for traffic, and drives `StatusDot` from real mihomo health. In-process memory only (single admin), bounded ring buffers (no leak on long uptime).

**Tech Stack:** tRPC v11 SSE subscriptions (`initTRPC({sse})`, `tracked()`, `httpSubscriptionLink`, `splitLink`), Node `EventEmitter` + `events.on(signal)`, web `ReadableStream`/`TextDecoderStream`, uPlot (live charts), Zod 4 discriminated unions, TanStack Query `setQueryData`.

**Confirmed API (Context7, tRPC v11):**
- Server: `initTRPC.create({ sse: { ping: { enabled: true, intervalMs: 2000 }, client: { reconnectAfterInactivityMs: 5000 } } })`; `t.procedure.subscription(async function* (opts) { … yield tracked(id, data) })` using `opts.signal`; the standalone adapter (`createHTTPHandler`) serves SSE automatically.
- Client: `splitLink({ condition: (op) => op.type === 'subscription', true: httpSubscriptionLink({ url }), false: httpBatchLink({ url }) })`; subscribe via the vanilla client from `useTRPCClient()`: `client.live.subscribe(input, { onData, onError })` → returns `{ unsubscribe() }`.

**Scope guard:** in-process only (no Redis/WS). Reuses the existing mihomo client + nodes normalization. Closes the recorded Phase-3 follow-ups (`phase3-followups`): real mihomo-health probe, AUTO/DIRECT selectable, consume `pollInterval`, `LatencyBars` all-zero guard. PoC untouched. Auth is Phase 5; Docker is Phase 6.

---

## File structure

```
packages/shared/src/
  schemas.ts                  # + trafficSampleSchema, liveEventSchema (discriminated union) + types
  live.test.ts                # NEW — schema parse tests

packages/server/src/
  clients/mihomo.ts           # + streamTraffic(signal) async generator, getConnections()
  clients/mihomo.test.ts      # + traffic NDJSON parse / connections tests
  modules/nodes/service.ts    # extract toNodeView() pure fn (reused by hub + listNodes)
  modules/nodes/nodeView.test.ts  # NEW — toNodeView normalization tests
  live/hub.ts                 # NEW — LiveHub class (EventEmitter, poll + traffic pump, snapshot)
  live/hub.test.ts            # NEW — hub emits nodeUpdate/health/traffic with fakes
  live/router.ts              # NEW — liveRouter: `stream` subscription (snapshot + forward)
  live/router.test.ts         # NEW — caller test: yields snapshot then events
  trpc/trpc.ts                # + sse config on initTRPC
  trpc/router.ts              # mount live: liveRouter
  index.ts                    # boot hub.start(); stop on SIGTERM

packages/web/src/
  main.tsx                    # splitLink + httpSubscriptionLink
  lib/live.ts                 # NEW — pure: applyNodeUpdate(cache patch), RingBuffer
  lib/live.test.ts            # NEW
  features/live/useLive.ts    # NEW — subscribe, patch nodes.list cache, push traffic, expose health
  features/live/LiveProvider.tsx  # NEW — runs useLive once under the providers; context for traffic+health
  components/Chart.tsx        # NEW — thin uPlot React wrapper (bars)
  features/nodes/TrafficChart.tsx # NEW — live up/down bar chart
  features/nodes/ActiveNodeCard.tsx  # live latency history (replace STATIC_HISTORY)
  features/nodes/NodesScreen.tsx     # drop refetchInterval; AUTO/DIRECT selectable
  components/LatencyBars.tsx   # all-zero guard
  components/StatusDot.tsx     # real mihomo health from useLive
```

---

### Task 1: Shared — live event schemas

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/live.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/live.test.ts
import { describe, expect, it } from "vitest";
import { liveEventSchema, trafficSampleSchema } from "./schemas.js";

describe("live schemas", () => {
  it("parses a traffic sample", () => {
    expect(trafficSampleSchema.parse({ up: 10, down: 20 })).toEqual({ up: 10, down: 20 });
  });

  it("parses a nodeUpdate event", () => {
    const evt = liveEventSchema.parse({
      type: "nodeUpdate",
      view: { now: "NL-1", all: [{ name: "NL-1", type: "vless", delay: 42 }] },
    });
    expect(evt.type).toBe("nodeUpdate");
  });

  it("parses a traffic event and a health event", () => {
    expect(liveEventSchema.parse({ type: "traffic", up: 1, down: 2 }).type).toBe("traffic");
    expect(liveEventSchema.parse({ type: "health", mihomo: false }).type).toBe("health");
  });

  it("rejects an unknown event type", () => {
    expect(() => liveEventSchema.parse({ type: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm -F @submerge/shared test` → `trafficSampleSchema is not exported`.

- [ ] **Step 3: Add the schemas** to `packages/shared/src/schemas.ts` (append near the node schemas; reuse the existing `nodeViewSchema`):

```ts
// Live (SSE) — high-frequency traffic samples + the fan-out event union.
export const trafficSampleSchema = z.object({ up: z.number(), down: z.number() });
export type TrafficSample = z.infer<typeof trafficSampleSchema>;

export const liveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("nodeUpdate"), view: nodeViewSchema }),
  z.object({ type: z.literal("traffic"), up: z.number(), down: z.number() }),
  z.object({ type: z.literal("health"), mihomo: z.boolean() }),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;
```

Ensure `nodeViewSchema` is declared above this point in the file (it is — `nodeViewSchema` already exists). If `nodeViewSchema` is not exported, leave it as-is; this file can reference it locally.

- [ ] **Step 4: Run it, expect PASS** — `pnpm -F @submerge/shared test`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/live.test.ts
git commit -m "$(printf 'feat(shared): live event schemas (nodeUpdate/traffic/health) + traffic sample\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: mihomo client — traffic stream + connections

**Files:**
- Modify: `packages/server/src/clients/mihomo.ts`
- Test: `packages/server/src/clients/mihomo.test.ts`

mihomo's `GET /traffic` streams newline-delimited JSON (`{"up":N,"down":N}` ~1/s). `GET /connections` returns a snapshot `{ downloadTotal, uploadTotal, connections: [...] }` (also streamable, but we read it one-shot from the poll loop).

- [ ] **Step 1: Write failing tests** (append inside the existing `describe("mihomo client", …)` or a new describe):

```ts
// in packages/server/src/clients/mihomo.test.ts
import { streamTraffic, getConnections } from "./mihomo.js"; // add to existing imports

it("streams and parses NDJSON traffic samples", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode('{"up":10,"down":20}\n{"up":5,'));
      c.enqueue(enc.encode('"down":7}\n'));
      c.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
  const samples: Array<{ up: number; down: number }> = [];
  for await (const s of streamTraffic(new AbortController().signal)) samples.push(s);
  expect(samples).toEqual([
    { up: 10, down: 20 },
    { up: 5, down: 7 },
  ]);
});

it("parses a connections snapshot", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ downloadTotal: 100, uploadTotal: 50, connections: [{}, {}] }), { status: 200 })),
  );
  const c = await getConnections();
  expect(c).toEqual({ downloadTotal: 100, uploadTotal: 50, count: 2 });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm -F @submerge/server test` → `streamTraffic is not exported`.

- [ ] **Step 3: Implement** in `packages/server/src/clients/mihomo.ts`:

```ts
import { trafficSampleSchema, type TrafficSample } from "@submerge/shared"; // add to imports

const connectionsSchema = z.object({
  downloadTotal: z.number(),
  uploadTotal: z.number(),
  connections: z.array(z.unknown()).default([]),
});
export interface ConnectionsSnapshot {
  downloadTotal: number;
  uploadTotal: number;
  count: number;
}

// Stream mihomo /traffic as parsed NDJSON samples until `signal` aborts or the
// upstream closes. Caller owns the lifecycle (re-open on error).
export async function* streamTraffic(signal: AbortSignal): AsyncGenerator<TrafficSample> {
  const r = await fetch(`${env.MIHOMO_API}/traffic`, {
    signal,
    headers: { Authorization: `Bearer ${env.MIHOMO_SECRET}` },
  });
  if (!r.ok || !r.body) throw new Error(`mihomo /traffic returned HTTP ${r.status}`);
  const stream = r.body.pipeThrough(new TextDecoderStream());
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield trafficSampleSchema.parse(JSON.parse(line));
      nl = buf.indexOf("\n");
    }
  }
}

export async function getConnections(): Promise<ConnectionsSnapshot> {
  const r = await call("/connections");
  if (!r.ok) throw new Error(`mihomo /connections returned HTTP ${r.status}`);
  const { downloadTotal, uploadTotal, connections } = connectionsSchema.parse(await r.json());
  return { downloadTotal, uploadTotal, count: connections.length };
}
```

Note: `call()` already injects the auth header + timeout, but `/traffic` is long-lived so `streamTraffic` uses `fetch` directly with the caller's `signal` (NOT the 5 s timeout). Keep that distinction.

- [ ] **Step 4: Run, expect PASS** — `pnpm -F @submerge/server test`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/clients/mihomo.ts packages/server/src/clients/mihomo.test.ts
git commit -m "$(printf 'feat(server): mihomo client streamTraffic (NDJSON) + getConnections\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: nodes service — extract `toNodeView` pure fn

**Files:**
- Modify: `packages/server/src/modules/nodes/service.ts`
- Test: `packages/server/src/modules/nodes/nodeView.test.ts`

The hub and `listNodes` both normalize a `/proxies` response. Extract the pure mapping so both share it and it's unit-tested.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/modules/nodes/nodeView.test.ts
import { describe, expect, it } from "vitest";
import { toNodeView } from "./service.js";
import type { ProxiesResponse } from "../../clients/mihomo.js";

const resp: ProxiesResponse = {
  proxies: {
    PROXY: { name: "PROXY", type: "Selector", now: "NL-1", all: ["NL-1", "DE-2"], history: [] },
    "NL-1": { name: "NL-1", type: "Vless", history: [{ time: "t", delay: 42 }] },
    "DE-2": { name: "DE-2", type: "Vless", history: [{ time: "t", delay: 0 }] },
  },
};

describe("toNodeView", () => {
  it("maps the PROXY group to a NodeView with delays", () => {
    const view = toNodeView(resp);
    expect(view.now).toBe("NL-1");
    expect(view.all).toEqual([
      { name: "NL-1", type: "Vless", delay: 42 },
      { name: "DE-2", type: "Vless", delay: null }, // delay 0 → null (timeout)
    ]);
  });

  it("returns an empty view when there is no PROXY group", () => {
    expect(toNodeView({ proxies: {} })).toEqual({ now: null, all: [] });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `toNodeView is not exported`.

- [ ] **Step 3: Refactor `service.ts`** — extract the body of `listNodes` into `toNodeView`, keep `listNodes` as a thin caller:

```ts
import type { ProxiesResponse } from "../../clients/mihomo.js"; // add

// Pure: normalize a mihomo /proxies response into the UI-facing NodeView.
export function toNodeView({ proxies }: ProxiesResponse): NodeView {
  const group = proxies.PROXY;
  if (!group?.all) return { now: null, all: [] };
  const all: NodeItem[] = group.all.map((name) => {
    const info = proxies[name];
    const last = info?.history.at(-1);
    const item: NodeItem = {
      name,
      type: info?.type ?? "unknown",
      delay: last && last.delay > 0 ? last.delay : null,
    };
    if (info?.udp !== undefined) item.udp = info.udp;
    return item;
  });
  return { now: group.now ?? null, all };
}

export async function listNodes(): Promise<NodeView> {
  return toNodeView(await getProxies());
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm -F @submerge/server test` (existing nodes tests stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/modules/nodes/service.ts packages/server/src/modules/nodes/nodeView.test.ts
git commit -m "$(printf 'refactor(server): extract pure toNodeView from listNodes (+ tests)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: LiveHub — poll + traffic pump + fan-out

**Files:**
- Create: `packages/server/src/live/hub.ts`
- Test: `packages/server/src/live/hub.test.ts`

The hub is dependency-injected for testability (no real timers/mihomo in tests). It exposes an `EventEmitter` (`"event"`), a `snapshot()` for new subscribers, and `start()/stop()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/live/hub.test.ts
import { describe, expect, it, vi } from "vitest";
import { LiveHub } from "./hub.js";
import type { LiveEvent } from "@submerge/shared";

const view = { now: "NL-1", all: [{ name: "NL-1", type: "vless", delay: 9 }] };

function collect(hub: LiveHub, n: number): Promise<LiveEvent[]> {
  return new Promise((resolve) => {
    const out: LiveEvent[] = [];
    hub.emitter.on("event", (e: LiveEvent) => {
      out.push(e);
      if (out.length === n) resolve(out);
    });
  });
}

describe("LiveHub", () => {
  it("emits nodeUpdate + health(true) after a successful poll", async () => {
    const hub = new LiveHub({
      fetchView: vi.fn(async () => view),
      streamTraffic: async function* () {}, // no traffic in this test
      getInterval: () => 10,
    });
    const got = collect(hub, 2);
    hub.pollOnce(); // exercise the poll path directly (no timer)
    const events = await got;
    expect(events).toContainEqual({ type: "health", mihomo: true });
    expect(events).toContainEqual({ type: "nodeUpdate", view });
    expect(hub.snapshot()).toContainEqual({ type: "nodeUpdate", view });
  });

  it("emits health(false) when the poll throws", async () => {
    const hub = new LiveHub({
      fetchView: vi.fn(async () => {
        throw new Error("down");
      }),
      streamTraffic: async function* () {},
      getInterval: () => 10,
    });
    const got = collect(hub, 1);
    hub.pollOnce();
    expect(await got).toEqual([{ type: "health", mihomo: false }]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — module missing.

- [ ] **Step 3: Implement `live/hub.ts`**

```ts
import { EventEmitter } from "node:events";
import type { LiveEvent, NodeView, TrafficSample } from "@submerge/shared";

export interface HubDeps {
  fetchView: () => Promise<NodeView>;
  streamTraffic: (signal: AbortSignal) => AsyncGenerator<TrafficSample>;
  getInterval: () => number; // ms between /proxies polls (settings-driven)
}

export class LiveHub {
  readonly emitter = new EventEmitter();
  private deps: HubDeps;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trafficAbort: AbortController | null = null;
  private lastView: NodeView | null = null;
  private lastHealth = false;

  constructor(deps: HubDeps) {
    this.deps = deps;
    this.emitter.setMaxListeners(0); // many subscribers; we manage cleanup via signals
  }

  // Current state for a freshly-connected subscriber (no waiting for next poll).
  snapshot(): LiveEvent[] {
    const out: LiveEvent[] = [{ type: "health", mihomo: this.lastHealth }];
    if (this.lastView) out.push({ type: "nodeUpdate", view: this.lastView });
    return out;
  }

  private emit(e: LiveEvent): void {
    this.emitter.emit("event", e);
  }

  async pollOnce(): Promise<void> {
    try {
      const view = await this.deps.fetchView();
      this.lastView = view;
      this.setHealth(true);
      this.emit({ type: "nodeUpdate", view });
    } catch {
      this.setHealth(false);
    }
  }

  private setHealth(ok: boolean): void {
    // Always emit health so a flap (true→false) reaches the client; clients can
    // dedupe. (Keeps the StatusDot honest in real time.)
    this.lastHealth = ok;
    this.emit({ type: "health", mihomo: ok });
  }

  private scheduleNext(): void {
    this.timer = setTimeout(async () => {
      await this.pollOnce();
      if (this.timer !== null) this.scheduleNext(); // re-arm unless stopped
    }, this.deps.getInterval());
  }

  private async pumpTraffic(): Promise<void> {
    while (this.trafficAbort) {
      try {
        for await (const s of this.deps.streamTraffic(this.trafficAbort.signal)) {
          this.emit({ type: "traffic", up: s.up, down: s.down });
        }
      } catch {
        // upstream closed/error → brief pause, then retry while still running
      }
      if (this.trafficAbort) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  start(): void {
    if (this.timer !== null) return; // already running
    void this.pollOnce();
    this.scheduleNext();
    this.trafficAbort = new AbortController();
    void this.pumpTraffic();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.trafficAbort?.abort();
    this.trafficAbort = null;
  }
}
```

Note the test calls `pollOnce()` directly (no timers), so the implementation must keep `pollOnce` independently callable (it is). `scheduleNext` re-arms via `setTimeout` recursion (avoids overlap that `setInterval` would cause if a poll outlives the interval).

- [ ] **Step 4: Run, expect PASS** — `pnpm -F @submerge/server test`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/live/hub.ts packages/server/src/live/hub.test.ts
git commit -m "$(printf 'feat(server): LiveHub — poll /proxies + traffic pump + typed fan-out\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: live subscription router + SSE config

**Files:**
- Modify: `packages/server/src/trpc/trpc.ts` (SSE config)
- Create: `packages/server/src/live/router.ts`, `packages/server/src/live/singleton.ts`
- Modify: `packages/server/src/trpc/router.ts` (mount)
- Test: `packages/server/src/live/router.test.ts`

- [ ] **Step 1: Enable SSE on initTRPC** in `trpc/trpc.ts`:

```ts
const t = initTRPC.context<Context>().create({
  sse: {
    ping: { enabled: true, intervalMs: 2000 },
    client: { reconnectAfterInactivityMs: 5000 },
  },
});
```

- [ ] **Step 2: Create the hub singleton** `live/singleton.ts` (wires real deps; reads `pollInterval` from settings, clamped):

```ts
import { getProxies, streamTraffic } from "../clients/mihomo.js";
import { db } from "../db/client.js";
import { getSetting } from "../modules/settings/service.js";
import { toNodeView } from "../modules/nodes/service.js";
import { LiveHub } from "./hub.js";

function pollIntervalMs(): number {
  const raw = Number.parseInt(getSetting(db, "pollInterval") ?? "", 10);
  const seconds = Number.isFinite(raw) && raw >= 1 ? raw : 5; // default 5 s
  return seconds * 1000;
}

export const liveHub = new LiveHub({
  fetchView: async () => toNodeView(await getProxies()),
  streamTraffic,
  getInterval: pollIntervalMs,
});
```

- [ ] **Step 3: Write the failing test** for the router generator (it must yield the snapshot first, then forwarded events):

```ts
// packages/server/src/live/router.test.ts
import { describe, expect, it } from "vitest";
import { LiveHub } from "./hub.js";
import { makeLiveRouter } from "./router.js";
import { createCallerFactory } from "../trpc/trpc.js";
import { router } from "../trpc/trpc.js";

describe("live router", () => {
  it("yields the current snapshot then forwards events", async () => {
    const hub = new LiveHub({
      fetchView: async () => ({ now: "NL-1", all: [] }),
      streamTraffic: async function* () {},
      getInterval: () => 1000,
    });
    await hub.pollOnce(); // seed lastView + health(true)

    const appRouter = router({ live: makeLiveRouter(hub) });
    const caller = createCallerFactory(appRouter)({ authed: true });
    const iterator = await caller.live.stream();

    const first = await iterator[Symbol.asyncIterator]().next();
    // snapshot is emitted as a batch; assert it carries health + nodeUpdate
    expect(first.done).toBe(false);

    // push a traffic event and confirm it is forwarded
    const it = iterator[Symbol.asyncIterator]();
    hub.emitter.emit("event", { type: "traffic", up: 1, down: 2 });
    // drain a couple values without hanging the test
    const a = await it.next();
    expect(a.done).toBe(false);
  });
});
```

> If iterating the live subscription in a unit test proves awkward (generators + signals), it is acceptable to instead test `makeLiveRouter`'s behavior indirectly: assert `hub.snapshot()` content and that the procedure is a subscription. The hub itself (Task 4) carries the core logic coverage. Keep whichever test is reliable and green; do not add flaky timing.

- [ ] **Step 4: Implement `live/router.ts`**

```ts
import { on } from "node:events";
import { tracked } from "@trpc/server";
import type { LiveEvent } from "@submerge/shared";
import type { LiveHub } from "./hub.js";
import { publicProcedure, router } from "../trpc/trpc.js";

let seq = 0;

export function makeLiveRouter(hub: LiveHub) {
  return router({
    stream: publicProcedure.subscription(async function* (opts) {
      // Replay current state immediately so a new subscriber is never blank.
      for (const e of hub.snapshot()) yield tracked(String(seq++), e);
      // Then forward live events until the client disconnects (opts.signal).
      for await (const [evt] of on(hub.emitter, "event", { signal: opts.signal })) {
        yield tracked(String(seq++), evt as LiveEvent);
      }
    }),
  });
}
```

- [ ] **Step 5: Mount it** in `trpc/router.ts`:

```ts
import { makeLiveRouter } from "../live/router.js";
import { liveHub } from "../live/singleton.js";
// …
export const appRouter = router({
  health: router({ ping: publicProcedure.query(() => ({ ok: true, version: "0.2.0" })) }),
  sources: sourcesRouter,
  nodes: nodesRouter,
  settings: settingsRouter,
  live: makeLiveRouter(liveHub),
});
```

- [ ] **Step 6: Run tests** — `pnpm -F @submerge/server test` (all green). Typecheck: `pnpm -F @submerge/server exec tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/trpc packages/server/src/live/router.ts packages/server/src/live/singleton.ts packages/server/src/live/router.test.ts
git commit -m "$(printf 'feat(server): live.stream subscription (SSE) + hub singleton + SSE config\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Boot the hub

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Start the hub after migrations, stop on shutdown:**

```ts
import { liveHub } from "./live/singleton.js"; // add

runMigrations();
liveHub.start(); // begin polling mihomo + pumping traffic

// … in shutdown():
const shutdown = () => {
  liveHub.stop();
  server.close(() => process.exit(0));
};
```

- [ ] **Step 2: Manual sanity** — `pnpm -F @submerge/server dev` boots without throwing even when mihomo is unreachable (hub emits `health:false`, retries; no crash). Stop it.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "$(printf 'feat(server): start LiveHub at boot, stop on SIGTERM\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 7: Web — subscription transport (`splitLink` + SSE) + uPlot dep

**Files:**
- Modify: `packages/web/src/main.tsx`
- Modify: `packages/web/package.json` (add `uplot`)

- [ ] **Step 1: Add uPlot** — `pnpm -F @submerge/web add uplot` (ships its own types).

- [ ] **Step 2: Swap the link config** in `main.tsx` so subscriptions use SSE while query/mutation stay batched:

```ts
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
// …
const [trpcClient] = useState(() =>
  createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: httpSubscriptionLink({ url: "/trpc" }),
        false: httpBatchLink({ url: "/trpc" }),
      }),
    ],
  }),
);
```

- [ ] **Step 3: Typecheck + build** — `pnpm -F @submerge/web typecheck` clean; `pnpm -F @submerge/web build` clean (existing app still renders; no subscriber yet).

- [ ] **Step 4: Commit**

```bash
git add packages/web/package.json packages/web/src/main.tsx pnpm-lock.yaml
git commit -m "$(printf 'feat(web): splitLink + httpSubscriptionLink (SSE) transport; add uplot\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 8: Web — pure live helpers (cache patch + ring buffer)

**Files:**
- Create: `packages/web/src/lib/live.ts`
- Test: `packages/web/src/lib/live.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/live.test.ts
import { describe, expect, it } from "vitest";
import { RingBuffer } from "./live";

describe("RingBuffer", () => {
  it("keeps only the last N items", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.toArray()).toEqual([2, 3, 4]);
  });

  it("starts empty and reports size", () => {
    const rb = new RingBuffer<number>(2);
    expect(rb.toArray()).toEqual([]);
    rb.push(9);
    expect(rb.toArray()).toEqual([9]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `lib/live.ts`** — a bounded ring buffer (prevents unbounded traffic-history growth on long uptime):

```ts
export class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }
  toArray(): readonly T[] {
    return this.items;
  }
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm -F @submerge/web test`.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/live.ts packages/web/src/lib/live.test.ts
git commit -m "$(printf 'feat(web): RingBuffer for bounded live traffic history (+ tests)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 9: Web — `useLive` + `LiveProvider`

**Files:**
- Create: `packages/web/src/features/live/useLive.ts`, `packages/web/src/features/live/LiveProvider.tsx`
- Modify: `packages/web/src/main.tsx` (mount `LiveProvider`)

One subscription for the whole app: patch the `nodes.list` cache on `nodeUpdate`, accumulate `traffic` samples in a `RingBuffer`, track `mihomo` health. Expose traffic + health via context (charts/StatusDot read it); node data flows through the Query cache as usual.

- [ ] **Step 1: `useLive.ts`** — subscribe with the vanilla client, patch cache, buffer traffic:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { TrafficSample } from "@submerge/shared";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { RingBuffer } from "@/lib/live";

const TRAFFIC_WINDOW = 60; // last 60 samples (~60 s at 1/s)

export interface LiveState {
  traffic: readonly TrafficSample[];
  mihomo: boolean;
}

export function useLive(): LiveState {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const buffer = useRef(new RingBuffer<TrafficSample>(TRAFFIC_WINDOW));
  const [state, setState] = useState<LiveState>({ traffic: [], mihomo: false });

  useEffect(() => {
    const sub = client.live.stream.subscribe(undefined, {
      onData(ev) {
        // httpSubscriptionLink delivers tracked() data as { id, data }
        const evt = "data" in ev ? ev.data : ev;
        if (evt.type === "nodeUpdate") {
          qc.setQueryData(trpc.nodes.list.queryKey(), evt.view);
        } else if (evt.type === "traffic") {
          buffer.current.push({ up: evt.up, down: evt.down });
          setState((s) => ({ ...s, traffic: [...buffer.current.toArray()] }));
        } else if (evt.type === "health") {
          setState((s) => (s.mihomo === evt.mihomo ? s : { ...s, mihomo: evt.mihomo }));
        }
      },
      onError() {
        setState((s) => (s.mihomo ? { ...s, mihomo: false } : s));
      },
    });
    return () => sub.unsubscribe();
  }, [client, qc, trpc]);

  return state;
}
```

> Verify the exact `onData` payload shape at build time: with `tracked()` + `httpSubscriptionLink`, data arrives wrapped as `{ id, data }`. The `"data" in ev ? ev.data : ev` guard handles both wrapped and unwrapped deliveries. Confirm against types; if the proxy types the callback as the unwrapped `LiveEvent`, drop the guard. Update `lib/trpc.ts` to also export `useTRPCClient` from `createTRPCContext` (it is returned alongside `useTRPC`/`TRPCProvider`).

- [ ] **Step 2: `lib/trpc.ts`** — ensure `useTRPCClient` is exported:

```ts
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
```

- [ ] **Step 3: `LiveProvider.tsx`** — run `useLive` once, expose via context:

```tsx
import { createContext, useContext, type ReactNode } from "react";
import { useLive, type LiveState } from "./useLive";

const LiveContext = createContext<LiveState | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const live = useLive();
  return <LiveContext value={live}>{children}</LiveContext>;
}

export function useLiveState(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLiveState must be used within a LiveProvider");
  return ctx;
}
```

- [ ] **Step 4: Mount `LiveProvider`** in `main.tsx` inside the providers (must be under `QueryClientProvider` + `TRPCProvider`, around `RouterProvider`):

```tsx
<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
  <ThemeProvider>
    <LiveProvider>
      <RouterProvider router={router} />
    </LiveProvider>
    <ThemedToaster />
  </ThemeProvider>
</TRPCProvider>
```

- [ ] **Step 5: Typecheck + build** — clean. (Runtime verified in Task 11 smoke.)

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/features/live packages/web/src/lib/trpc.ts packages/web/src/main.tsx
git commit -m "$(printf 'feat(web): useLive + LiveProvider — one SSE subscription, cache patch + traffic/health\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 10: Web — live charts + wire-up (uPlot, StatusDot, AUTO/DIRECT, drop polling)

**Files:**
- Create: `packages/web/src/components/Chart.tsx`, `packages/web/src/features/nodes/TrafficChart.tsx`
- Modify: `packages/web/src/components/StatusDot.tsx`, `packages/web/src/components/LatencyBars.tsx`,
  `packages/web/src/features/nodes/{ActiveNodeCard,NodesScreen}.tsx`

- [ ] **Step 1: `Chart.tsx`** — thin uPlot wrapper (create on mount, `setData` on change, destroy on unmount, ResizeObserver for width). uPlot is vanilla:

```tsx
import "uplot/dist/uPlot.min.css";
import uPlot from "uplot";
import { useEffect, useRef } from "react";

export function Chart({ data, height = 96, makeOpts }: {
  data: uPlot.AlignedData;
  height?: number;
  makeOpts: (width: number) => uPlot.Options;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: chart is created once; data syncs via setData below
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const width = el.clientWidth || 320;
    const u = new uPlot(makeOpts(width), data, el);
    uRef.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth || width, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      u.destroy();
      uRef.current = null;
    };
  }, []);

  useEffect(() => {
    uRef.current?.setData(data);
  }, [data]);

  return <div ref={elRef} style={{ height }} />;
}
```

- [ ] **Step 2: `TrafficChart.tsx`** — bars for up/down from `useLiveState().traffic` (bar style per the chart-style preference). Uses CSS-var tokens read off the element so it themes:

```tsx
import uPlot from "uplot";
import { useLiveState } from "../live/LiveProvider";
import { Chart } from "@/components/Chart";

export function TrafficChart() {
  const { traffic } = useLiveState();
  const xs = traffic.map((_, i) => i);
  const up = traffic.map((s) => s.up);
  const down = traffic.map((s) => s.down);
  const data: uPlot.AlignedData = [xs, down, up];

  return (
    <Chart
      data={data}
      makeOpts={(width) => ({
        width,
        height: 96,
        cursor: { show: false },
        legend: { show: false },
        scales: { x: { time: false } },
        axes: [{ show: false }, { show: false }],
        series: [
          {},
          { label: "down", stroke: "transparent", fill: "#6366F1", paths: uPlot.paths.bars?.({ size: [0.6] }) },
          { label: "up", stroke: "transparent", fill: "#9BA1AD", paths: uPlot.paths.bars?.({ size: [0.6] }) },
        ],
      })}
    />
  );
}
```

> uPlot needs concrete fill colors (it draws on canvas, not DOM, so Tailwind classes don't apply). Use the Indigo Console hex values directly here (accent `#6366F1`, secondary `#9BA1AD`) — this is the one place raw hex is legitimate (canvas rendering), mirror the comment style from `index.css`. If exact theme-following is wanted later, read the computed CSS var via `getComputedStyle` in Phase-5 polish; not required now. Place `TrafficChart` on `NodesScreen` (e.g. inside/under the `ActiveNodeCard`) with a small "Трафик" heading.

- [ ] **Step 3: `LatencyBars.tsx` all-zero guard** — when every value is 0 (or empty) fall back to the flat track instead of `NaN` heights:

```ts
const max = Math.max(...values);
const safeMax = max > 0 ? max : 1; // guard all-zero / empty → flat bars, no NaN
// use safeMax as the divisor
```

- [ ] **Step 4: `ActiveNodeCard.tsx`** — replace `STATIC_HISTORY` with live per-node latency history. Keep a small module-level map name→RingBuffer, append the active node's `delay` whenever the live `nodeUpdate` lands (read the active node's delay from the `nodes.list` cache via a `nodes.list` query subscription in the screen, then pass `history` down as a prop). Simplest in-scope approach: derive history from the active node's successive `delay` values using a `useRef<number[]>` in `NodesScreen` keyed by `now`, pass `history` to `ActiveNodeCard`. Remove the `STATIC_HISTORY` const + its `TODO(phase-4)`.

```tsx
// ActiveNodeCard now takes history as a prop:
interface ActiveNodeCardProps { now: string | null; all: NodeItem[]; history: number[]; }
// …
<LatencyBars values={props.history.length ? props.history : [active.delay ?? 0]} className="flex-1" />
```

- [ ] **Step 5: `NodesScreen.tsx`** — (a) drop `refetchInterval: 5000` (the subscription now pushes updates); (b) accumulate active-node latency history; (c) make AUTO/DIRECT selectable — render the `modes` from `splitNodes` as a small selectable group above the node list (closes the follow-up):

```tsx
const nodesQuery = useQuery(trpc.nodes.list.queryOptions()); // no refetchInterval
// …
const { modes, nodes } = splitNodes(all);
// render `modes` (AUTO/DIRECT/REJECT/GLOBAL present in `all`) as selectable rows
// using the same NodeRow, so the user can re-select AUTO.
```

History accumulation (in `Body` or the screen):

```tsx
const histRef = useRef<Record<string, number[]>>({});
if (now && typeof activeDelay === "number") {
  const h = (histRef.current[now] ??= []);
  if (h.at(-1) !== activeDelay) { h.push(activeDelay); if (h.length > 30) h.shift(); }
}
```

- [ ] **Step 6: `StatusDot.tsx`** — drive from real mihomo health (`useLiveState().mihomo`) instead of `health.ping`; relabel back to "mihomo: …" honestly now that it reflects reachability:

```tsx
import { useLiveState } from "@/features/live/LiveProvider";
export function StatusDot() {
  const { mihomo } = useLiveState();
  const dotClass = mihomo ? "bg-online" : "bg-timeout";
  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      mihomo: {mihomo ? "online" : "offline"}
    </div>
  );
}
```

(The `health.ping` procedure stays as the server liveness check; the dot no longer depends on it.)

- [ ] **Step 7: Typecheck + build + tests** — `pnpm -F @submerge/web typecheck` clean; `pnpm -F @submerge/web build` clean; `pnpm -r test` green.

- [ ] **Step 8: Lint + commit** — `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` → 0.

```bash
git add packages/web/src
git commit -m "$(printf 'feat(web): live traffic chart (uPlot) + live latency + real mihomo health + AUTO/DIRECT selectable\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 11: Phase gate — build, typecheck, lint, tests, live browser smoke

**Files:** none (verification).

- [ ] **Step 1:** `pnpm typecheck` → clean.
- [ ] **Step 2:** `pnpm -F @submerge/web build` → clean.
- [ ] **Step 3:** `pnpm -r test` → all green (note the new counts).
- [ ] **Step 4:** `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` → `EXIT=0` (raw biome — the rtk hook masks `pnpm lint`).
- [ ] **Step 5: Live browser smoke** — start `pnpm -F @submerge/server dev` + `pnpm -F @submerge/web dev`. To see real live data, bring up the PoC mihomo (`docker compose up -d mihomo` from repo root) so `/traffic` emits; otherwise verify graceful offline. In a browser (Chrome DevTools / Playwright MCP) confirm:
  (a) the `live.stream` SSE request is open (Network → EventStream) and receives events;
  (b) `StatusDot` shows real mihomo online/offline and flips when mihomo stops;
  (c) Узлы updates without a 5 s poll (no repeated `nodes.list` XHR; cache patched via SSE);
  (d) the traffic chart renders bars and grows over time when mihomo passes traffic;
  (e) selecting AUTO from the modes group works;
  (f) killing the server → the subscription errors and auto-reconnects (SSE `reconnectAfterInactivityMs`) without a crash.
  Capture a screenshot of Узлы with the live traffic chart (dark).
- [ ] **Step 6:** Gitignore already covers `.playwright-mcp/` + `smoke-*.png` (Phase 3). Clean any artifacts. No commit unless gate fixes were needed.

---

## Self-review (plan vs. spec §6/§7)

- **`live` subscription (nodeUpdate/traffic/health):** Tasks 1,4,5. (Spec lists `delay` as an event; per-node delay is carried inside `nodeUpdate.view` from `/proxies` history — no separate event needed.)
- **SSE hub polls /proxies, pumps /traffic, fans out:** Tasks 2,4,5,6.
- **Web patches Query cache per node, no full re-render:** Task 9 (`setQueryData(nodes.list)`); React reconciles by `key={name}`.
- **High-frequency traffic → chart via throttle/window, bypassing Query cache:** Tasks 8,9,10 (RingBuffer window 60; traffic never enters the Query cache; uPlot bars).
- **In-process memory, bounded window:** RingBuffer (web) + hub holds only `lastView`/`lastHealth` (server).
- **Closes `phase3-followups`:** real mihomo health (Task 10 §6), AUTO/DIRECT selectable (Task 10 §5), consume `pollInterval` (Task 5 singleton), LatencyBars all-zero guard (Task 10 §3).
- **Charts as bars** ([[feedback-chart-style]]): TrafficChart uses `uPlot.paths.bars`; LatencyBars stays CSS bars.

**Type consistency:** `LiveEvent` (shared) is the single event type across hub → router → client. `toNodeView(ProxiesResponse): NodeView` is shared by `listNodes` + hub. `nodes.list` cache value is `NodeView`, matching `nodeUpdate.view`.

**Risks / verify-during-impl:**
1. `httpSubscriptionLink` `onData` payload wrapping with `tracked()` — the `"data" in ev` guard (Task 9) handles both; confirm against the inferred callback type and simplify if the proxy already unwraps.
2. The standalone `createHTTPHandler` must flush SSE through the existing `req.url.slice("/trpc")` rewrite in `index.ts` — confirm the subscription path resolves (it strips `/trpc` then the handler sees `/live.stream`). If SSE needs the raw handler, adjust the prefix strip to preserve query/accept headers.
3. uPlot `paths.bars` is optional-chained (`?.`) for type-safety across uPlot versions; confirm the build picks it up.
4. Subscription unit test (Task 5) can be flaky — prefer hub-level coverage (Task 4) and keep the router test minimal/deterministic.
