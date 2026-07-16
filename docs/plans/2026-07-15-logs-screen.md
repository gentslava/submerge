# Logs Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the Logs route with one safe, newest-first timeline combining structured mihomo INFO+ events and a curated set of submerge operational events retained in a process-local 500-entry ring.

**Architecture:** A stateful server `LogHub` starts at boot, assigns monotonic ids and receipt timestamps, retains a bounded ring, pumps the parsed mihomo stream with backoff, and fans out snapshot/append/clear/status messages through a protected tRPC subscription. Upstream mihomo state is explicit and separate from browser-to-submerge SSE state. Existing pino output remains intact; only explicit stable operational keys pass through a per-key field allow-list into the hub. The browser owns local filtering and pause state and never receives raw pino records or upstream errors.

**Tech Stack:** TypeScript 6, Zod 4, pino, tRPC v11 SSE, React 19, TanStack Query/Router, Tailwind v4, Vitest fake timers, Testing Library, Playwright, Pencil MCP, Biome.

**Source specification:** [`docs/specs/2026-07-15-logs-screen-design.md`](../specs/2026-07-15-logs-screen-design.md)

**Pencil references:** dark `ZdPsU`, light `mnDGi`, mobile 390 `zW719`, states `rE094`.

**Commit rule:** Tasks 1–5 are vertical slices. Every slice must start with failing tests, pass `pnpm verify:static`, receive an independent incremental `/code-review`, and be committed before the next slice. Task 5 performs the final wide review and visual sweep before its commit.

---

## File structure

- `packages/shared/src/logs.ts` — browser/server log event and stream-message Zod contract.
- `packages/server/src/modules/logs/hub.ts` — ring, sequence, subscribers, clear marker, and mihomo reconnect pump.
- `packages/server/src/modules/logs/events.ts` — stable submerge event-key registry and per-key field sanitizers.
- `packages/server/src/modules/logs/router.ts` — protected stream and global clear mutation.
- `packages/server/src/modules/logs/singleton.ts` — one process-wide hub wired to the mihomo client.
- `packages/web/src/features/logs/store.ts` — client snapshot/append/clear/status reducer, pause cursor, transport/upstream state, deduplication, and filters.
- `packages/web/src/features/logs/LogsScreen.tsx` — subscription lifecycle and approved UI.
- `packages/web/e2e/logs-layout.spec.ts` — responsive, interaction, state, and visual evidence.

Do not introduce Redis, SQLite tables, files, browser persistence, or a generic pino transport.

---

## Task 1: Define the safe contract and bounded ring

**Files:**

- Create: `packages/shared/src/logs.ts`
- Create: `packages/shared/src/logs.test.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/server/src/modules/logs/hub.ts`
- Create: `packages/server/src/modules/logs/hub.test.ts`

- [ ] **Step 1: Write failing shared-contract tests**

Define and test this contract:

```ts
export const logLevelSchema = z.enum(["debug", "info", "warning", "error"]);
export const logSourceSchema = z.enum(["mihomo", "submerge"]);
export const logScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
export const logUpstreamStateSchema = z.enum(["connecting", "live", "reconnecting"]);

export const logEventSchema = z.object({
  id: z.number().int().positive(),
  time: z.iso.datetime(),
  source: logSourceSchema,
  level: logLevelSchema,
  message: z.string().min(1),
  fields: z.record(z.string(), logScalarSchema).optional(),
});

export const logStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    cursor: z.number().int().nonnegative(),
    upstream: logUpstreamStateSchema,
    nextRetryAt: z.iso.datetime().nullable(),
    events: z.array(logEventSchema),
  }),
  z.object({
    type: z.literal("append"),
    cursor: z.number().int().positive(),
    event: logEventSchema,
  }),
  z.object({ type: z.literal("clear"), cursor: z.number().int().positive() }),
  z.object({
    type: z.literal("status"),
    cursor: z.number().int().positive(),
    upstream: logUpstreamStateSchema,
    nextRetryAt: z.iso.datetime().nullable(),
  }),
]);
```

Also export `LogLevel`, `LogSource`, `LogUpstreamState`, `LogEvent`, and `LogStreamMessage`. Tests reject nested fields, invalid time/id/level, inconsistent retry values, empty messages, and unknown stream-message shapes. Require `nextRetryAt` only for `reconnecting`; it is null for `connecting` and `live`.

Run:

```bash
pnpm -F @submerge/shared test -- src/logs.test.ts
```

Expected: FAIL because the log contract does not exist.

- [ ] **Step 2: Write failing ring and hand-off tests**

`LogHub` exposes:

```ts
export interface LogDraft {
  source: LogSource;
  level: LogLevel;
  message: string;
  fields?: Record<string, string | number | boolean>;
}

export class LogHub {
  readonly emitter: EventEmitter;
  push(draft: LogDraft): LogEvent;
  snapshot(): Extract<LogStreamMessage, { type: "snapshot" }>;
  clear(): Extract<LogStreamMessage, { type: "clear" }>;
  setUpstream(
    upstream: LogUpstreamState,
    nextRetryAt: string | null,
  ): Extract<LogStreamMessage, { type: "status" }> | null;
}
```

With fake time, prove:

- event ids are strictly increasing across both sources and after clear, while allowed to have gaps from clear/status control messages;
- receipt time comes from the injected/current clock, not mihomo's timestamp;
- the 501st push evicts only the oldest event;
- snapshot events stay chronological and include the current upstream/retry state;
- one private sequence advances for append, clear, and changed status messages; snapshot cursor equals its current value and the sequence never resets;
- clear empties the ring and emits a clear marker without resetting sequence;
- duplicate `setUpstream` values do not emit, while changed values emit a status message with the next cursor;
- two subscribers receive the same append/clear/status messages;
- constructing the async iterator/listener before yielding snapshot queues an event pushed during the snapshot/live hand-off, so no gap exists.

Run:

```bash
pnpm -F @submerge/server test -- src/modules/logs/hub.test.ts
```

Expected: FAIL because `LogHub` does not exist.

- [ ] **Step 3: Implement the contract and ring only**

Use a fixed `LOG_CAPACITY = 500`, one `EventEmitter` with unlimited listeners, and a private sequence that is never reset. Event ids reuse the sequence value assigned to their append, so control messages can create harmless gaps. Initialize upstream state as `connecting`. Keep hub events as `LogStreamMessage`; do not expose the pino logger here.

The subscription generator must register its event iterator before taking the snapshot:

```ts
async *messages(signal?: AbortSignal): AsyncGenerator<LogStreamMessage> {
  const live = on(this.emitter, LOG_STREAM_EVENT, { signal });
  yield this.snapshot();
  for await (const [message] of live) yield message as LogStreamMessage;
}
```

Handle an already-aborted signal as clean completion in tests.

- [ ] **Step 4: Verify, review, and commit the ring slice**

Run:

```bash
pnpm -F @submerge/shared test -- src/logs.test.ts
pnpm -F @submerge/server test -- src/modules/logs/hub.test.ts
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 1 only, resolve findings, and rerun.

Commit:

```bash
git add packages/shared/src/logs.ts packages/shared/src/logs.test.ts packages/shared/src/index.ts packages/server/src/modules/logs/hub.ts packages/server/src/modules/logs/hub.test.ts
git commit -m "feat(logs): add bounded event hub" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Capture structured mihomo logs from server boot

**Files:**

- Modify: `packages/server/src/clients/mihomo.ts`
- Modify: `packages/server/src/clients/mihomo.test.ts`
- Modify: `packages/server/src/modules/logs/hub.ts`
- Modify: `packages/server/src/modules/logs/hub.test.ts`
- Create: `packages/server/src/modules/logs/router.ts`
- Create: `packages/server/src/modules/logs/router.test.ts`
- Create: `packages/server/src/modules/logs/singleton.ts`
- Modify: `packages/server/src/trpc/router.ts`
- Modify: `packages/server/src/trpc/router.test.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write failing structured-stream client tests**

Add a parsed upstream shape and an opener that does not resolve until mihomo has returned a successful response with a readable body:

```ts
export interface MihomoLogFrame {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  fields: Record<string, string | number | boolean>;
}

export async function openLogStream(
  signal: AbortSignal,
): Promise<AsyncGenerator<MihomoLogFrame>>;
```

Tests must prove:

- the request uses `/logs?level=info&format=structured` with the current Bearer secret;
- split NDJSON chunks reconstruct complete frames;
- `warn` and `warning` normalize to `warning` if mihomo emits either spelling;
- non-scalar/unknown sensitive fields are dropped by a small mihomo field allow-list;
- isolated malformed frames are skipped;
- 30 consecutive malformed frames throw a schema-drift error;
- `openLogStream` rejects non-2xx/no-body before returning a generator;
- abort before headers, while reading, or between frames ends cleanly.

Run:

```bash
pnpm -F @submerge/server test -- src/clients/mihomo.test.ts
```

Expected: FAIL because `openLogStream` does not exist.

- [ ] **Step 2: Add the reconnecting pump to `LogHub`**

Add idempotent `start()`/`stop()` methods and inject `openLogStream` as a hub dependency. Keep upstream `connecting` until the opener resolves, emit `live` immediately after a successful open (even before the first log line), map every valid frame to `source: "mihomo"`, and emit `reconnecting` with the exact `nextRetryAt` after a failure or unexpected close. Use capped exponential backoff `1s → 2s → 4s → … → 30s`. Match the existing LiveHub stability rule: a stream must stay open for 30 seconds before the failure counter resets. `stop()` aborts the current stream, clears retry metadata without inventing a user-facing failure, and prevents another retry.

Fake-timer tests must verify connecting → live before the first frame, first-failure reporting with deterministic `nextRetryAt`, bounded backoff, live → reconnecting on clean upstream EOF, stable reset, stop-during-backoff, and no duplicate pumps after repeated `start()` calls.

- [ ] **Step 3: Expose snapshot/live/clear through tRPC**

`makeLogsRouter(logHub)` contains:

```ts
stream: protectedProcedure.subscription(({ signal }) =>
  trackLogMessages(logHub.messages(signal)),
),
clear: protectedProcedure.mutation(() => {
  logHub.clear();
  return { ok: true as const };
}),
```

Wrap each message with `tracked(String(messageCursor), message)` and publish a nameable `TrackedLogMessage` type, following `live/router.ts`. Router tests use an in-process caller to assert snapshot, append, clear broadcast, and abort cleanup.

Register `logs` in `appRouter` and create one singleton wired to `openLogStream`.

- [ ] **Step 4: Start and stop capture with the server process**

In `index.ts`, start `logHub` before accepting requests and stop it in the existing shutdown function alongside `liveHub`. Collection must run even with no `/logs` subscriber.

- [ ] **Step 5: Verify, review, and commit the mihomo stream slice**

Run:

```bash
pnpm -F @submerge/server test -- src/clients/mihomo.test.ts src/modules/logs/hub.test.ts src/modules/logs/router.test.ts src/trpc/router.test.ts
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 2 with stream cleanup, retry, and snapshot hand-off focus; resolve findings and rerun.

Commit:

```bash
git add packages/server/src/clients/mihomo.ts packages/server/src/clients/mihomo.test.ts packages/server/src/modules/logs/hub.ts packages/server/src/modules/logs/hub.test.ts packages/server/src/modules/logs/router.ts packages/server/src/modules/logs/router.test.ts packages/server/src/modules/logs/singleton.ts packages/server/src/trpc/router.ts packages/server/src/trpc/router.test.ts packages/server/src/index.ts
git commit -m "feat(logs): stream structured mihomo events" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Add the curated submerge/pino path with redaction

**Files:**

- Create: `packages/server/src/modules/logs/events.ts`
- Create: `packages/server/src/modules/logs/events.test.ts`
- Modify: `packages/server/src/log.ts`
- Create: `packages/server/src/log.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/modules/nodes/service.ts`
- Modify: `packages/server/src/modules/settings/router.ts`
- Modify: `packages/server/src/live/singleton.ts`
- Modify: `packages/server/src/modules/nodes/service.test.ts`
- Create: `packages/server/src/modules/settings/router.test.ts`
- Modify: `packages/server/src/live/singleton.test.ts`

- [ ] **Step 1: Write failing event-registry/redaction tests**

Define exactly these v1 keys:

```ts
export type OperationalEventKey =
  | "server-listening"
  | "boot-config-apply-failed"
  | "config-reload-failed"
  | "secret-rotation-write-failed"
  | "mihomo-live-failed";
```

Each registry entry fixes level, Russian UI message, stdout message, and allowed scalar fields:

| Key | Level | Allowed fields |
|---|---|---|
| `server-listening` | info | `host`, `port` |
| `boot-config-apply-failed` | warning | none |
| `config-reload-failed` | warning | none |
| `secret-rotation-write-failed` | warning | none |
| `mihomo-live-failed` | warning | `scope` (`poll` or `traffic`) |

Tests pass objects containing `password`, `secret`, `authorization`, nested `err`, stack, URL credentials, arrays, and extra fields, then assert none appear in the returned UI draft or its JSON serialization.

- [ ] **Step 2: Add an explicit operational logger without a generic pino transport**

Keep `export const log = pino(...)`. Add:

```ts
type UiEventSink = (draft: LogDraft) => void;
let uiEventSink: UiEventSink = () => {};

export function setUiEventSink(sink: UiEventSink): void {
  uiEventSink = sink;
}

export function operationalLog(
  key: OperationalEventKey,
  fields: Record<string, unknown> = {},
  err?: unknown,
): void;
```

`operationalLog` sends raw `err` only to pino stdout, obtains the safe draft from `events.ts`, then calls `uiEventSink`. Unit tests spy on both sinks and prove raw error/secret separation.

- [ ] **Step 3: Wire only the approved existing call sites**

At boot, call `setUiEventSink((draft) => logHub.push(draft))` before any operational event can fire. Replace the five existing pino-only calls with `operationalLog` while preserving their stdout meaning:

- server listening;
- boot apply failure;
- config written but mihomo reload failed;
- secret-rotation config write failure;
- live poll/traffic outage streak.

Do not route request logs, CRUD logs, channel decisions, source URLs, or arbitrary future `log.*` calls to the UI.

- [ ] **Step 4: Verify, review, and commit the curation slice**

Run:

```bash
pnpm -F @submerge/server test -- src/modules/logs/events.test.ts src/log.test.ts src/modules/nodes/service.test.ts src/modules/settings/router.test.ts src/live/singleton.test.ts
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 3 with secret/PII/redaction focus, resolve findings, and rerun.

Commit:

```bash
git add packages/server/src/modules/logs/events.ts packages/server/src/modules/logs/events.test.ts packages/server/src/log.ts packages/server/src/log.test.ts packages/server/src/index.ts packages/server/src/modules/nodes/service.ts packages/server/src/modules/settings/router.ts packages/server/src/live/singleton.ts packages/server/src/modules/nodes/service.test.ts packages/server/src/modules/settings/router.test.ts packages/server/src/live/singleton.test.ts
git commit -m "feat(logs): curate submerge operational events" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Build the browser log store, filters, pause, and route

**Files:**

- Create: `packages/web/src/features/logs/store.ts`
- Create: `packages/web/src/features/logs/store.test.ts`
- Create: `packages/web/src/features/logs/LogsScreen.tsx`
- Create: `packages/web/src/routes/logs.tsx`
- Modify: `packages/web/src/routes/tree.ts`
- Modify: `packages/web/src/components/nav.ts`

- [ ] **Step 1: Write failing reducer/store tests**

Use this browser state:

```ts
export interface LogsClientState {
  connection: "connecting" | "live" | "reconnecting";
  nextRetryAt: string | null;
  cursor: number | null;
  events: readonly LogEvent[];
  paused: boolean;
  pausedEvents: readonly LogEvent[];
  pausedCursor: number | null;
  unseen: number;
}
```

Pure reducer/actions must prove:

- snapshot establishes its explicit upstream state/retry timestamp, cursor, and newest-first order;
- status updates connection/retry metadata without replacing retained events;
- append deduplicates by id and keeps newest first;
- upstream reconnecting and browser transport reconnecting both retain all events;
- pause freezes `pausedEvents` and `pausedCursor`, new unique event ids after that cursor increment `unseen`, and continue merges atomically;
- clear advances the cursor and empties live/frozen/queued state and unseen count but preserves `paused`;
- a reconnect snapshot cannot duplicate existing ids;
- source/severity/text filters are case-insensitive over message plus visible safe field values;
- filtered-empty is distinct from a genuinely empty ring;
- reset filters returns all sources, all levels, empty query.

Run:

```bash
pnpm -F @submerge/web test -- src/features/logs/store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 2: Activate route/navigation and subscribe**

Extend `NavLink.to` with `"/logs"`, convert Logs to a real link while keeping it in mobile primary navigation, register `/logs`, and create a thin route component.

`LogsScreen` subscribes once while mounted:

```ts
const sub = client.logs.stream.subscribe(undefined, {
  onData: (message) => dispatch({ type: "message", message: message.data }),
  onError: () => dispatch({ type: "connection-lost" }),
  onConnectionStateChange: (state) =>
    state.state === "connecting" && dispatch({ type: "connection-lost" }),
});
```

The installed tRPC v11 client exposes `onConnectionStateChange`; use it directly. Initialize with `connection: "connecting"` and `cursor: null`. `connection-lost` keeps `connecting` before the first snapshot and becomes `reconnecting` after any snapshot, preserving rows. A later snapshot/status message restores the server-reported upstream state. Unsubscribe on unmount.

- [ ] **Step 3: Build the complete desktop interaction surface**

The screen includes:

- title/subtitle, counter `N из 500`, pause/continue, and global clear;
- labelled text search;
- existing `Select` with «Все источники», `mihomo`, `submerge`;
- existing `Segmented` with «Все», `INFO`, `WARN`, `ERROR` (DEBUG remains visible under «Все» if ever received, but has no v1 filter button);
- newest-first rows with semantic `<time>`, source text, level text, message, and safe fields;
- connecting, live empty, populated, paused, reconnecting, and filtered-empty copy from the spec; reconnecting may show the safe retry time but never a raw upstream error;
- filter-reset action only for filtered empty;
- clear mutation with no confirmation; server clear marker remains authoritative across tabs.

Do not put continuously arriving rows in an assertive live region.

- [ ] **Step 4: Verify, review, and commit the browser behavior slice**

Run:

```bash
pnpm -F @submerge/web test -- src/features/logs
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 4 only, resolve findings, and rerun.

Commit:

```bash
git add packages/web/src/features/logs/store.ts packages/web/src/features/logs/store.test.ts packages/web/src/features/logs/LogsScreen.tsx packages/web/src/routes/logs.tsx packages/web/src/routes/tree.ts packages/web/src/components/nav.ts
git commit -m "feat(logs): add unified event timeline" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Match responsive Pencil states and run the final gate

**Files:**

- Modify: `packages/web/src/styles/responsive.css`
- Modify: `packages/web/e2e/fixtures.ts`
- Create: `packages/web/e2e/logs-layout.spec.ts`
- Modify: `packages/web/e2e/layout-contract.spec.ts`
- Modify if review finds a defect: `packages/web/src/features/logs/LogsScreen.tsx`
- Modify if review finds a defect: `packages/web/src/features/logs/store.ts`

- [ ] **Step 1: Reuse the generalized subscription fixtures**

Use the `TrpcFixtureOptions.subscriptions` helper introduced by the Traffic plan. Add deterministic `logs.stream` arrays containing snapshot/append/clear/status messages and keep ordinary query overrides separate. Use a status message to model an upstream mihomo reconnect while browser SSE stays open; use `end: "disconnect"` separately to model a browser-to-submerge transport loss. Do not add a production test hook.

- [ ] **Step 2: Implement semantic container-query layouts**

Add `.responsive-page--logs` rules:

- compact `<42rem`: header actions become icon buttons with accessible names; search is full width; source/severity controls share or wrap onto a compact row; each event stacks time/source/level above a wrapping message;
- inline `≥42rem`: balanced control rows without fixed metadata widths;
- data `≥48rem`: dense single-line rows matching desktop Pencil;
- long technical messages wrap in their message cell and never widen the page;
- the page is the scroll owner; the timeline may use normal document flow, not an independent full-height horizontal scroller.

- [ ] **Step 3: Add browser behavior and geometry tests**

`logs-layout.spec.ts` covers:

- dark and light populated desktop at 1440×1024;
- populated mobile at 390;
- connecting, live empty, paused with `N новых`, upstream reconnecting with retained rows/retry time, transport reconnecting with retained rows, and filtered empty;
- source/severity/search combinations;
- pause → append → continue, clear while paused, and duplicate append after reconnect;
- keyboard-accessible pause/continue/clear and filter controls;
- no secret-like fixture field is rendered;
- no overflow at 320/390/425/768/1024/1440 and changed container boundaries;
- bottom navigation does not cover the last row.

Add `/logs` to `layout-contract.spec.ts`.

Run with zero retries:

```bash
pnpm -F @submerge/web test:e2e -- logs-layout.spec.ts layout-contract.spec.ts
pnpm verify:static
```

Expected: PASS.

- [ ] **Step 4: Capture visual evidence and run the final review**

Compare dark 1440×1024 to `ZdPsU`, light to `mnDGi`, mobile 390 to `zW719`, and risky states to `rE094`. Inspect row density, wrapping, control types, focus return, scroll ownership, and colour-independent status copy. Record evidence and resolved findings in the active plan.

Invoke `/code-review` on the entire Logs feature across server/shared/web. Require explicit review of ring hand-off, reconnect cleanup, clear semantics, pino curation/redaction, pause behavior, and responsive visual fidelity. Resolve findings and rerun Step 3.

### Implementation evidence — 2026-07-16

- **Pencil frames:** dark `ZdPsU` at 1440×1024, light `mnDGi` at 1440×1024,
  mobile `zW719` at 390×900, and states `rE094`. Pencil MCP was retried before
  and after browser verification but returned `Transport closed`; exact geometry
  was read from the tracked plain-JSON `pencil/web-ui.pen` source of truth.
- **Screenshots:** `/tmp/logs-dark-1440.png`, `/tmp/logs-light-1440.png`,
  `/tmp/logs-mobile-390.png`, and `/tmp/logs-paused-390.png`.
- **Risky states:** populated, first-load empty, filtered-empty, paused, upstream
  reconnect with retained rows, light theme, and compact/wide filter layouts.
- **Responsive sweep:** 320, 390, 425, 768, 983/984 container boundary, 1024,
  and 1440; document, `.app-main`, and `.responsive-page` remained overflow-free,
  and the timeline stayed the internal scroll owner above mobile navigation.
- **Browser gate:** 62 Playwright tests passed with zero retries; the Logs desktop
  fixture additionally asserted a clean browser console.
- **Review:** full branch review covered ring hand-off, monotonic cursors, clear and
  pause semantics, pump cleanup/backoff, protected tRPC procedures, curated pino
  fields, responsive fidelity, and accessible control names. Resolved findings:
  raw mihomo message URLs/credentials now pass through defense-in-depth redaction;
  mobile rows use stacked metadata/message layout; only paused unseen counts use a
  live region, avoiding announcements on every incoming event.

- [ ] **Step 5: Commit the final Logs slice**

```bash
git add packages/web/src/styles/responsive.css packages/web/e2e/fixtures.ts packages/web/e2e/logs-layout.spec.ts packages/web/e2e/layout-contract.spec.ts packages/web/src/features/logs/LogsScreen.tsx packages/web/src/features/logs/store.ts
git commit -m "test(logs): verify responsive stream states" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Do not implement temporary DEBUG mode in this plan and do not push without an explicit user request.
