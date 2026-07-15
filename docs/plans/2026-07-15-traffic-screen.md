# Traffic Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the Traffic route and render honest engine-wide live rates, browser-session bytes, active Default-channel latency, and a bounded 60-second throughput history in the approved dark/light/mobile states.

**Architecture:** Keep per-second samples outside broad React context state in one external `TrafficDashboardStore` created by `LiveProvider`. The live subscription feeds traffic, totals, and active-node snapshots into that store; the Traffic screen subscribes with `useSyncExternalStore`, derives deterministic live/fallback states, and mounts the existing Connections query only while visible. No server API or persisted telemetry is added.

**Tech Stack:** TypeScript 6, React 19, TanStack Query/Router, tRPC v11 SSE, Tailwind v4 container queries, Vitest, Testing Library, Playwright, Pencil MCP, Biome.

**Source specification:** [`docs/specs/2026-07-15-traffic-screen-design.md`](../specs/2026-07-15-traffic-screen-design.md)

**Pencil references:** dark `YED5Y`, light `eLeqx`, mobile 390 `Qocs1`, states `yjNoN`.

**Commit rule:** Tasks 1–4 are vertical slices. Every slice must use TDD, pass `pnpm verify:static`, receive an independent incremental `/code-review`, and be committed before the next slice. Task 4 also performs the final wide review and full visual sweep before its commit.

---

## File structure

- `packages/web/src/features/traffic/store.ts` — the only owner of Traffic-specific samples, freshness, session baseline, reset window, and latency window.
- `packages/web/src/features/traffic/state.ts` — pure state precedence and chart-summary helpers.
- `packages/web/src/features/traffic/TrafficScreen.tsx` — route-level queries, state selection, and approved page composition.
- `packages/web/src/features/traffic/TrafficCharts.tsx` — accessible latency/throughput bar charts with no data fetching.
- `packages/web/src/routes/traffic.tsx` — thin route component.
- `packages/web/e2e/traffic-layout.spec.ts` — populated/fallback/responsive/visual geometry evidence.

Do not add a chart dependency or move per-second samples into React context state.

---

## Task 1: Build the persistent Traffic dashboard store

**Files:**

- Create: `packages/web/src/features/traffic/store.ts`
- Create: `packages/web/src/features/traffic/store.test.ts`
- Modify: `packages/web/src/features/live/useLive.ts`
- Delete: `packages/web/src/features/live/trafficStore.test.ts`

- [ ] **Step 1: Write failing store tests**

Define tests around this public contract:

```ts
export interface TimedTrafficSample {
  up: number;
  down: number;
  at: number;
}

export interface TrafficLatencySnapshot {
  node: string | null;
  current: number | null;
  samples: readonly number[];
}

export interface TrafficDashboardSnapshot {
  samples: readonly TimedTrafficSample[];
  lastSampleAt: number | null;
  totals: { up: number; down: number } | null;
  sessionBytes: number | null;
  latency: TrafficLatencySnapshot;
}

export interface TrafficDashboardStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TrafficDashboardSnapshot;
  pushTraffic(sample: TrafficSample, at?: number): void;
  pushTotals(totals: { up: number; down: number }): void;
  pushNodeView(view: NodeView): void;
  reset(): void;
}
```

Cover all of these cases with fake data and `vi.setSystemTime`:

- a new traffic sample creates a new immutable snapshot, records `at`, caps at 60, and notifies once;
- first totals establish the baseline and render `0`, later totals render the combined delta;
- an engine-counter rollback adopts the lower totals as the new baseline and never returns a negative value;
- active-node changes reset and seed the Traffic latency window from that node's history;
- repeated node snapshots append only a genuinely new latest delay and cap at 40;
- `reset()` sets the baseline to current totals, clears both displayed chart windows, retains current node/current delay, and does not mutate shared Nodes-screen latency;
- route unmount is irrelevant because the store object itself owns the state;
- unsubscribe stops notifications.

Run:

```bash
pnpm -F @submerge/web test -- src/features/traffic/store.test.ts
```

Expected: FAIL because `TrafficDashboardStore` does not exist.

- [ ] **Step 2: Implement the minimal external store**

Use one stable snapshot object and private mutable bookkeeping. The important reset/rollback core is:

```ts
const totalBytes = (v: { up: number; down: number }) => v.up + v.down;

function pushTotals(totals: { up: number; down: number }) {
  if (baseline === null || totalBytes(totals) < totalBytes(baseline)) baseline = totals;
  currentTotals = totals;
  publish();
}

function reset() {
  baseline = currentTotals;
  samples = [];
  latencySamples = [];
  publish();
}
```

`pushNodeView` resolves `view.now === "AUTO" ? view.autoNow : view.now`, follows the matching `NodeItem`, and retains an internal last-seen history value across `reset()` so the same old delay is not immediately reinserted.

- [ ] **Step 3: Feed the store from the existing live subscription**

In `useLive.ts`, create the dashboard store once with a lazy `useState` initializer, expose it on `LiveState` as `traffic`, and call:

```ts
if (evt.type === "nodeUpdate") traffic.pushNodeView(evt.view);
if (evt.type === "traffic") traffic.pushTraffic({ up: evt.up, down: evt.down });
if (evt.type === "totals") traffic.pushTotals({ up: evt.up, down: evt.down });
```

Keep the existing `LiveState.latency` and `LiveState.totals` fields unchanged for the Nodes screen. Remove the old inline traffic ring implementation only after its tests have moved to `features/traffic/store.test.ts`.

- [ ] **Step 4: Verify, review, and commit the store slice**

Run:

```bash
pnpm -F @submerge/web test -- src/features/traffic/store.test.ts
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 1 only, resolve findings, and rerun both commands.

Commit:

```bash
git add packages/web/src/features/traffic/store.ts packages/web/src/features/traffic/store.test.ts packages/web/src/features/live/useLive.ts packages/web/src/features/live/trafficStore.test.ts
git commit -m "feat(traffic): add session telemetry store" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Activate the route and ship metrics with deterministic states

**Files:**

- Create: `packages/web/src/features/traffic/state.ts`
- Create: `packages/web/src/features/traffic/state.test.ts`
- Create: `packages/web/src/features/traffic/TrafficScreen.tsx`
- Create: `packages/web/src/routes/traffic.tsx`
- Modify: `packages/web/src/routes/tree.ts`
- Modify: `packages/web/src/components/nav.ts`
- Modify: `packages/web/src/features/nodes/nodeView.test.ts`

- [ ] **Step 1: Write failing state-precedence tests**

Implement the state decision as a pure function with this exact ordering:

```ts
export type TrafficViewState =
  | "loading"
  | "no-nodes"
  | "reconnecting"
  | "idle"
  | "populated";

export function trafficViewState(input: {
  nodesResolved: boolean;
  realNodeCount: number;
  connectionCount: number | null;
  sample: TimedTrafficSample | null;
  lastSampleAt: number | null;
  mihomo: boolean | null;
  now: number;
}): TrafficViewState;
```

Tests must prove:

- unresolved nodes and no sample → `loading`;
- resolved zero nodes, zero connections, and no positive traffic → `no-nodes`;
- `mihomo === false` or a last sample older than 5,000 ms → `reconnecting`, retaining data;
- a fresh zero sample with zero connections → `idle`;
- any fresh positive sample or active connection → `populated`;
- missing Connections data does not override valid live traffic.

Run:

```bash
pnpm -F @submerge/web test -- src/features/traffic/state.test.ts
```

Expected: FAIL because `trafficViewState` does not exist.

- [ ] **Step 2: Activate navigation and the TanStack route**

Extend the `NavLink.to` union with `"/traffic"`, convert Traffic from placeholder to link, keep it in `NAV_MOBILE_PRIMARY`, and register:

```ts
const trafficRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/traffic",
  component: TrafficRoute,
});
```

`routes/traffic.tsx` only imports and returns `<TrafficScreen />`.

- [ ] **Step 3: Build the header and metric surface**

`TrafficScreen` must:

- subscribe with `useSyncExternalStore(traffic.subscribe, traffic.getSnapshot)`;
- mount `nodes.list`, `channels.get`, and `connections.list` (`refetchInterval: 1500`) while the route is visible;
- compute the current Default active node from the nodes view;
- rerender a small freshness clock at least once per second so a stalled stream becomes stale without another event;
- render the subtitle «Суммарный трафик всех каналов · mihomo»;
- render four metrics in Pencil order: download rate, upload rate, Connections link, browser-session bytes;
- render `0 Б/с` for a fresh zero sample and `—` for missing data;
- keep valid traffic/session metrics when Connections fails, showing `—` only in that card;
- make the Connections card a keyboard-reachable `<Link to="/connections">`;
- show «Добавьте первый источник» linking to `/sources` for `no-nodes`;
- show stale copy and last values for `reconnecting` rather than replacing them with zero;
- state that retry is automatic without fabricating a countdown: browser EventSource
  does not expose the actual reconnect deadline.

Use existing `formatRate`, `formatBytes`, `realNodes`, `Button`, `Skeleton`, and role tokens. Do not create duplicate formatters.

- [ ] **Step 4: Add metric/state component tests**

Test pure metric props or the screen's extracted presentational body for:

- missing vs. zero values;
- Connections query failure isolation;
- accessible Connections link text;
- loading/no-nodes/reconnecting/idle copy;
- long active-node names with full `title` text.

Run:

```bash
pnpm -F @submerge/web test -- src/features/traffic
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 2 only, resolve findings, and rerun.

Commit:

```bash
git add packages/web/src/features/traffic/state.ts packages/web/src/features/traffic/state.test.ts packages/web/src/features/traffic/TrafficScreen.tsx packages/web/src/routes/traffic.tsx packages/web/src/routes/tree.ts packages/web/src/components/nav.ts packages/web/src/features/nodes/nodeView.test.ts
git commit -m "feat(traffic): add live metrics screen" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Add bounded charts and non-destructive session reset

**Files:**

- Create: `packages/web/src/features/traffic/TrafficCharts.tsx`
- Create: `packages/web/src/features/traffic/TrafficCharts.test.tsx`
- Modify: `packages/web/src/features/traffic/TrafficScreen.tsx`
- Modify: `packages/web/src/features/traffic/state.ts`
- Modify: `packages/web/src/features/traffic/state.test.ts`

- [ ] **Step 1: Write failing chart-model and accessibility tests**

Add pure helpers:

```ts
export interface ChartSummary {
  current: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export function chartSummary(values: readonly number[]): ChartSummary;
export function throughputPeak(samples: readonly TimedTrafficSample[]): number;
```

Test empty, all-zero, mixed, and timeout-containing latency data. Component tests must verify that decorative bars are `aria-hidden`, each chart has a concise screen-reader summary containing its actual sample window (not a hard-coded 60 minutes), and an empty latency series says «Нет данных о задержке» without failing throughput.

- [ ] **Step 2: Build the two CSS bar charts**

`TrafficCharts.tsx` exports:

```tsx
export function TrafficLatencyChart(props: {
  node: string | null;
  current: number | null;
  samples: readonly number[];
  checkIntervalSec: number;
})

export function ThroughputChart(props: {
  samples: readonly TimedTrafficSample[];
})
```

Requirements:

- latency uses a maximum of 40 bars, with `0` as a full-height timeout spike;
- throughput uses a maximum of 60 bars, scales by the maximum `up + down`, and draws download/upload as labelled token-colour segments;
- zero samples keep a minimum visible baseline without pretending to be non-zero data;
- no absolute-positioned labels over bars and no new chart dependency;
- reduced motion disables non-essential bar transitions;
- chart headings and axis copy match Pencil, including Default channel/node attribution only on latency.

- [ ] **Step 3: Wire «Сбросить» exactly to the browser session**

The header button calls `traffic.reset()` and then `toast.success("Сессия сброшена")`. It must not invoke tRPC, mutate mihomo, clear Connections, or alter the Nodes-screen shared latency.

Compact mode uses the same button with an accessible name even if only the reset icon is visible. Disable it only when no totals/sample/latency session data exists.

- [ ] **Step 4: Verify, review, and commit the chart slice**

Run:

```bash
pnpm -F @submerge/web test -- src/features/traffic
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 3 only, resolve findings, and rerun.

Commit:

```bash
git add packages/web/src/features/traffic/TrafficCharts.tsx packages/web/src/features/traffic/TrafficCharts.test.tsx packages/web/src/features/traffic/TrafficScreen.tsx packages/web/src/features/traffic/state.ts packages/web/src/features/traffic/state.test.ts
git commit -m "feat(traffic): add session charts and reset" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Match responsive Pencil states and run the final gate

**Files:**

- Modify: `packages/web/src/styles/responsive.css`
- Modify: `packages/web/e2e/fixtures.ts`
- Create: `packages/web/e2e/traffic-layout.spec.ts`
- Modify: `packages/web/e2e/layout-contract.spec.ts`
- Modify if review finds a defect: `packages/web/src/features/traffic/TrafficScreen.tsx`
- Modify if review finds a defect: `packages/web/src/features/traffic/TrafficCharts.tsx`

- [x] **Step 1: Add deterministic SSE fixture support**

Extend `installTrpcFixture` with an optional third argument so all upcoming stream screens share one fixture boundary:

```ts
export interface TrpcFixtureOptions {
  subscriptions?: Record<
    string,
    { events: readonly unknown[]; end?: "return" | "disconnect" }
  >;
}
```

When `options.subscriptions[path]` exists, fulfill an SSE body using the real tRPC wire shape:

```ts
const body = [
  "event: connected\ndata: {}\n\n",
  ...subscription.events.map(
    (event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`,
  ),
  subscription.end === "disconnect" ? "" : "event: return\ndata:\n\n",
].join("");
```

The `event` value is the tracked subscription payload. Traffic passes `{subscriptions: {"live.stream": {events: [...]}}}`, so fixtures can send `nodeUpdate`, `totals`, `traffic`, and `health` without a production-only test hook. Normal fixtures end with tRPC's `return` event so the client does not report a false failure; reconnecting fixtures use `end: "disconnect"`. Existing callers remain source-compatible because both new arguments default to empty objects.

- [x] **Step 2: Implement semantic container-query layouts**

Add `.responsive-page--traffic` rules under the existing `app-page` container:

- compact `<42rem`: stacked header, icon-sized reset affordance where Pencil requires it, 2×2 `minmax(0, 1fr)` metrics, stacked compact charts that aggregate the complete bounded history into fewer slots;
- inline `≥42rem`: title/action row and balanced two-column metrics;
- data `≥48rem`: four metrics in one row and full-width desktop chart heights;
- every grid child uses `min-width: 0`; page remains the only scroll owner.

Do not use viewport breakpoints for page content.

- [x] **Step 3: Add populated and fallback browser tests**

`traffic-layout.spec.ts` must cover:

- populated dark desktop at 1440×1024;
- populated light desktop at 1440×1024;
- populated mobile at 390;
- loading, fresh idle, reconnecting with retained values, no nodes, and Connections partial error;
- reset changes session bytes/charts but leaves the mocked engine values and Connections count intact;
- chart/link/button accessible names;
- no overflow at 320/390/425/768/1024/1440;
- app-page container widths 320/480/640/671/672/767/768;
- bottom navigation does not cover the final chart.

Add `/traffic` to the common `layout-contract.spec.ts` path list.

Run with zero retries:

```bash
pnpm -F @submerge/web test:e2e -- traffic-layout.spec.ts layout-contract.spec.ts
pnpm verify:static
```

Expected: PASS.

- [x] **Step 4: Capture visual evidence and run the final review**

At 1440×1024 compare dark against `YED5Y` and light against `eLeqx`; at 390 compare against `Qocs1`; compare fallback states against `yjNoN`. Inspect exact geometry/computed styles, internal scroll ownership, and long-value clipping. Record frame, viewport/theme, risky states, reviewer, and resolved findings in the active plan.

Invoke `/code-review` on the whole Traffic feature, including all previous Traffic commits and the current Task 4 diff. Resolve every finding, then rerun both commands from Step 3.

### Final evidence

- **Pencil / visual:** `YED5Y` dark 1440×1024, `eLeqx` light 1440×1024,
  `Qocs1` dark 390×844, and `yjNoN` fallback states. Captures:
  `/tmp/traffic-dark-1440.png`, `/tmp/traffic-light-1440.png`,
  `/tmp/traffic-mobile-390.png`.
- **Responsive:** viewports 320/390/425/768/1024/1440 and app-page inline sizes
  288/448/608/671/672/767/768; the app page remains the only scroll owner.
- **States:** populated, loading, live idle, real disconnect with retained stale
  values, no nodes, Connections partial error, and local session reset.
- **Independent reviewer:** Codex wide review over `363cfcd..HEAD` plus the final
  diff. Resolved its two final findings: compact layouts visibly name the active
  latency node; Traffic typography and radii use design-system tokens. Earlier
  incremental findings resolved honesty of node/Connections errors, first-sample
  freshness, no-node precedence, latency snapshot identity/window math, pending
  Connections, stale retry wording, compact full-window aggregation, unknown
  connection count, persistent monitoring ownership, throughput screen-reader
  minimum, loading precedence, and non-replaying disconnect fixtures.
- **Intentional Pencil deviation:** no reconnect countdown. tRPC/EventSource exposes
  no real retry deadline, so the UI truthfully says that retry is automatic.
- **Verification:** `pnpm verify:static` green; focused Playwright suite 14/14 with
  one worker and zero retries.

- [x] **Step 5: Commit the final Traffic slice**

```bash
git add packages/web/src/styles/responsive.css packages/web/e2e/fixtures.ts packages/web/e2e/traffic-layout.spec.ts packages/web/e2e/layout-contract.spec.ts packages/web/src/features/traffic/TrafficScreen.tsx packages/web/src/features/traffic/TrafficCharts.tsx
git commit -m "test(traffic): verify responsive live states" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Do not push. Update the spec/plan status only after the complete feature is green and the user asks to ship.
