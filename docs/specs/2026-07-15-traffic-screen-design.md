# Traffic screen — design

- **Date:** 2026-07-15
- **Status:** proposed · **Scope:** `packages/web` Traffic screen with minimal live-state extensions
- **Related:** [design-system.md](../design-system.md),
  [adaptive layout](2026-07-12-adaptive-layout-design.md), Pencil frames
  `YED5Y` / `eLeqx` / `Qocs1` / `yjNoN`

## Problem and goal

The «Трафик» navigation entry is still an inert placeholder even though the
application already receives the required live telemetry from mihomo: aggregate
upload/download rates, cumulative byte totals, active-node latency history, and
active connections.

Ship one observability screen that answers the primary question: **what traffic is
mihomo carrying right now?** The screen must remain honest in the multi-channel
model. Aggregate rates belong to the whole engine, not to one active node.

## Product invariants

1. **Global traffic is labelled global.** `/traffic`, `/connections` totals, and
   the connection count cover all mihomo routes and channels.
2. **Only latency is node-specific.** The latency card follows the Default
   (primary) channel and names the node it currently measures.
3. **A browser session is not an engine counter.** «За сессию» and «Сбросить»
   are client-side concepts. The action never mutates or restarts mihomo and does
   not clear the shared latency series used by the Nodes screen.
4. **Zero is real data.** A live zero-rate sample renders as `0 Б/с`; missing or
   not-yet-received data renders as `—` or a loading state.
5. **Partial failure stays partial.** A failed connections query must not hide
   valid traffic or latency telemetry.

## Screen content and data mapping

| Surface | Source | Behaviour |
|---|---|---|
| **СКОРОСТЬ ↓** | latest live `traffic.down` | Adaptive `Б/с` → `КБ/с` → `МБ/с` formatting. |
| **СКОРОСТЬ ↑** | latest live `traffic.up` | Same formatting; never hard-code MB/s. |
| **СОЕДИНЕНИЯ** | mounted `connections.list` query | `connections.length`; card links to `/connections`; query failure renders `—`. |
| **ЗА СЕССИЮ** | `(totals.up + totals.down) − session baseline` | Combined bytes since the browser session baseline. Clamp at zero. |
| **ЗАДЕРЖКА · ОСНОВНОЙ КАНАЛ · {node}** | existing Default-channel latency series | Reset the history when the active node changes; the current value remains textual. |
| **ПРОПУСКНАЯ СПОСОБНОСТЬ** | last 60 live traffic samples | Download and upload are separately identified by label and colour. |

The header subtitle is «Суммарный трафик всех каналов · mihomo». The mock data
(`nl-ams-01`, `9.4 МБ/с`, and similar values) is illustrative only.

## Browser-session semantics

The first cumulative `totals` event after `LiveProvider` starts establishes the
baseline. It survives route navigation while the SPA remains mounted and resets on
a full page reload.

«Сбросить» performs one non-destructive, local operation:

- set the baseline to the latest totals;
- clear the displayed 60-s throughput window;
- clear only the Traffic screen's latency history window while keeping the current
  numeric latency and the shared Nodes-screen history intact;
- leave active connections and all mihomo counters unchanged;
- confirm with the toast «Сессия сброшена».

If mihomo restarts and its cumulative totals drop below the baseline, adopt the new
totals as the baseline and show `0 Б` rather than a negative session value.

## Live and fallback states

State precedence is deterministic:

1. **Loading** — nodes/live state is not resolved and no traffic sample has arrived.
2. **No nodes** — there are no real proxy nodes, no active connections, and no
   current traffic. Show «Добавьте первый источник» with a `/sources` action.
3. **Reconnecting** — tRPC live subscription failed, mihomo health is false, or the
   traffic stream has produced no sample for more than five seconds. Keep the last
   known values visible at reduced emphasis, label them stale, and show the next
   automatic retry. Do not replace them with zeroes.
4. **Live idle** — fresh samples are arriving with zero rates and zero active
   connections. Show valid zero values and «Трафик появится после первого запроса».
5. **Live populated** — render the normal dashboard.

The traffic store exposes the last-sample timestamp so the screen can distinguish a
fresh zero sample from a stalled stream. An unavailable latency series gets its own
empty chart message and does not fail the entire screen.

## Architecture

### Server

No new module or persisted telemetry is required.

- Reuse the existing `live.stream` traffic/totals/health events.
- Reuse `connections.list` while the route is mounted, at the same 1.5-s cadence
  as the Connections screen.
- Keep all mihomo access in `packages/server/src/clients/mihomo.ts`; no browser-to-
  controller connection is introduced.

### Web

- Add `/traffic` and activate the desktop/sidebar and phone-tab navigation entry.
- `TrafficScreen` consumes `useLiveState()` and subscribes to the existing external
  traffic store with `useSyncExternalStore`, so per-second samples rerender only
  this telemetry surface.
- Extend the traffic store/live state with last-sample freshness and a persistent,
  Traffic-specific session view (baseline, chart windows, and reset action). Keep
  the existing shared `LiveState.latency` series intact for the Nodes screen. Do not
  route per-second samples through broad React context state.
- Reuse the existing latency-bar visual language and byte/rate formatters. The
  throughput chart is a bounded 60-slot CSS bar chart; it does not require a new
  charting dependency.
- Keep the page as the only vertical scroll owner. Charts do not create nested
  horizontal or vertical scrolling.

## Responsive behaviour

Follow the named `app-page` container contract rather than viewport breakpoints.

| Container | Layout |
|---|---|
| **compact `<42rem`** | Header action becomes an icon button with an accessible name; metrics stay in a 2×2 `minmax(0, 1fr)` grid; charts stack and use compact heights. |
| **inline `≥42rem`** | Header title/action share a row; metric cards retain a balanced two-column arrangement while space is constrained. |
| **data `≥48rem`** | Four metrics appear in one row; both charts use the full desktop width and the Pencil plot height. |

At 320/390/425 widths values must not clip, the fixed bottom navigation must not
cover content, and no page-level horizontal overflow is allowed. Dark and light
themes use tokens only; the approved references are `YED5Y` and `eLeqx`.

## Interaction and accessibility

- «Сбросить» is a real button with visible focus and an explicit accessible
  name in compact icon-only mode.
- The Connections metric is a real link, keyboard reachable, and announces both
  the current count and destination.
- Charts expose a concise text summary (`current`, `minimum`, `maximum`, time
  window) while decorative bars are hidden from the accessibility tree.
- Status is never conveyed by colour or opacity alone: loading, stale, idle, and
  error states all include text.
- Live samples are not placed in an assertive `aria-live` region; this would cause
  continuous screen-reader announcements.
- Reduced-motion mode disables non-essential bar transitions.

## Testing and visual evidence

### Unit/component

- Session delta, reset, engine-counter rollback, and preservation of the shared
  Nodes-screen latency series.
- Fresh zero sample vs. stale stream detection.
- State precedence: loading / no nodes / reconnecting / idle / populated.
- Active-node switch resets the latency history label and window.
- Connection query error leaves other metrics visible.
- Connections card navigation and compact button accessible names.

### Browser

- Populated, loading, idle, reconnecting, no-nodes, and partial-error fixtures.
- Dark 1440×1024 comparison with Pencil `YED5Y`.
- Light 1440×1024 comparison with Pencil `eLeqx`.
- Mobile 390 comparison with Pencil `Qocs1`.
- Responsive checks at 320/390/425/768/1024/1440 and page-container boundaries
  320/480/640/671/672/767/768px, with zero retries.
- Inspect `html`, `.app-main`, and `.responsive-page--traffic` for overflow and
  confirm the bottom bar does not cover the final chart.

## Out of scope

- Historical persistence, selectable time ranges, and database storage.
- Per-channel or per-node throughput attribution.
- Provider quota/limits and billing-period traffic.
- Resetting mihomo counters or closing connections from this screen.
- Exporting telemetry.

## Resolved decisions

1. Implementation order begins with Traffic, then Logs, then Diagnostics.
2. Rates and session bytes are aggregate engine telemetry; only latency names the
   primary channel/node.
3. «Сбросить» is local and non-destructive.
4. The first release uses a 60-s in-memory window and existing endpoints only.
5. Responsive, light, and fallback-state Pencil references are required before code.
