# Logs screen — design

- **Date:** 2026-07-15
- **Status:** proposed · **Scope:** server log stream and `packages/web` Logs screen
- **Related:** [design-system.md](../design-system.md),
  [adaptive layout](2026-07-12-adaptive-layout-design.md), Pencil frames
  `ZdPsU` / `mnDGi` / `zW719` / `rE094`

## Problem and goal

The «Логи» navigation entry is still an inert placeholder. Mihomo exposes a live
engine log stream, while submerge already emits a small set of useful operational
events through pino. Looking at only one source leaves gaps; showing every future
server log without curation would turn the screen into noise.

Ship one chronological stream that answers two questions: **what is mihomo doing
now, and did submerge itself fail to apply or observe something?** Each row must
name its source so the combined stream remains readable.

## Product invariants

1. **One timeline, explicit source.** Mihomo and submerge events are interleaved by
   receipt time and every row carries `MIHOMO` or `SUBMERGE`.
2. **Bounded and volatile.** The server retains the newest 500 events in process
   memory. A server restart clears the history; Redis, SQLite, and file persistence
   are deliberately not involved.
3. **Submerge events are curated.** Only user-relevant operational events enter the
   UI stream. Future request traces and routine CRUD logs do not appear merely
   because they use the process-wide pino logger.
4. **Capture is independent from the page.** Collection starts at server boot, not
   when somebody opens `/logs`, so boot and pre-navigation failures remain visible.
5. **Pause freezes presentation, not capture.** The server ring and live client
   connection continue receiving events while one browser tab is paused.
6. **Clear is global for the current process.** «Очистить» empties the server ring
   and every connected Logs view, but does not alter, restart, or clear mihomo.
7. **No secrets reach the browser.** Subscription URLs, proxy credentials,
   authorization headers, the mihomo secret, and raw error objects are never part
   of the UI event payload.

## Event contract and sources

The shared Zod contract contains:

| Field | Meaning |
|---|---|
| `id` | Process-local monotonic event id used for deduplication and ordering. |
| `time` | Server receipt timestamp in ISO format. |
| `source` | `mihomo` or `submerge`. |
| `level` | Normalized `debug`, `info`, `warning`, or `error`. |
| `message` | Short, already-sanitized display message. |
| `fields` | Optional allow-listed scalar context such as `scope`, `host`, `port`, or HTTP status. |

### Mihomo

- Add a long-lived client method in `packages/server/src/clients/mihomo.ts` for
  `/logs?level=info&format=structured`.
- Parse every external frame with Zod at the client boundary. A malformed isolated
  frame may be skipped; a sustained invalid run must fail the stream so the normal
  reconnect path becomes visible.
- Normalize mihomo `warning` to the visible `WARN` label. Event messages stay in
  their original technical language; translating arbitrary engine messages would
  be misleading.
- Reconnect with bounded backoff. While reconnecting, keep the last valid ring
  snapshot instead of replacing it with an empty list.

### Submerge / pino

`log.ts` keeps stdout logging and also offers an explicit UI-event path. An event
enters the Logs screen only when the call marks a stable operational event key; the
UI never receives the raw serialized pino record.

The first version exposes the useful events that exist today:

- submerge server listening (`host`, `port`);
- boot config apply failed;
- config written but mihomo reload failed;
- config write after secret rotation failed;
- mihomo live polling or traffic failure (`scope`).

Messages are normalized for display before insertion into the ring. Safe scalar
fields are allow-listed per event key. Error stacks, environment values, request
bodies, headers, and arbitrary nested objects remain server-side/stdout-only.

## Stream, buffer, and ordering

Introduce one process-wide `LogHub` with two producers (mihomo and curated pino)
and any number of subscribers.

- The ring holds at most 500 events and evicts the oldest entry on overflow.
- Initial subscription and subsequent events use one ordered stream: the server
  sends a snapshot with its cursor, then only events after that cursor, avoiding a
  snapshot/live hand-off gap.
- The web renders newest first. Simultaneous events are ordered by server-assigned
  id rather than browser time.
- The counter `N из 500` means current ring occupancy versus capacity; filtering
  does not mutate the ring.
- «Очистить» is a tRPC mutation that resets the ring and broadcasts a clear marker
  to active subscribers. It needs no confirmation and has no effect on stdout logs.

No log data is restored after process restart. This is an intentional diagnostic
window, not an audit trail.

## Filters and interaction

All filters are local to a browser tab and apply to the current snapshot plus new
events:

- case-insensitive text search over the sanitized message and visible safe fields;
- source select: «Все источники» / `mihomo` / `submerge`;
- severity segmented control: «Все» / `INFO` / `WARN` / `ERROR`.

The initial state is all sources, all severities, empty search, newest first. Filter
choices are not persisted between page loads.

«Пауза» captures a per-tab cursor and keeps the displayed list frozen. New captured
events increment «N новых». «Продолжить» applies the accumulated events in one
update and then reapplies current filters. Clearing while paused empties the frozen
list and resets the unseen counter, but the tab remains paused.

An active filter with no matches shows «По фильтрам ничего не найдено» and actions
to clear search/filters. It is distinct from a genuinely empty live stream.

## DEBUG boundary and future enhancement

The first release keeps the generated mihomo config at `log-level: info`. Asking
the `/logs` endpoint for `level=debug` cannot create DEBUG events when the engine
itself runs at INFO, so the implementation must not imply otherwise.

The DEBUG sample rows remain in the Pencil frames only as a visual reference for a
future enhancement. They are not fixture expectations and do not require DEBUG
capture in v1.

Future work may add «Включить DEBUG на 15 минут»:

- patch the running mihomo config to `log-level: debug` without changing the
  generated persistent config;
- show the remaining time and the increased-volume state;
- restore `info` automatically after 15 minutes and on failure/restart;
- add a visible DEBUG filter while the temporary mode is active.

This temporary control is explicitly out of scope for the first Logs implementation.

## Live and fallback states

State precedence is deterministic:

1. **Connecting** — no initial snapshot has arrived; show «Подключаем поток
   событий…».
2. **Live empty** — subscription is healthy and the ring is empty; show «Событий
   пока нет».
3. **Live populated** — render the unified chronological list.
4. **Paused** — keep the frozen list and expose the unseen count plus
   «Продолжить».
5. **Reconnecting** — retain last-known events, show the retry status, and resume
   without duplicating rows when the stream returns.
6. **Filtered empty** — healthy stream with retained events, but no current matches.

Source and severity are always represented by text, not colour alone.

## Responsive behaviour

Follow the named page-container contract rather than viewport breakpoints.

| Container | Layout |
|---|---|
| **compact `<42rem`** | Header actions become two icon buttons with accessible names; search is full width; source and severity share a compact second row; each event stacks metadata above a wrapping message. |
| **inline `≥42rem`** | Controls may wrap into two balanced rows; messages retain the stacked layout if the metadata column would crowd them. |
| **data `≥48rem`** | Header, filters, counter, and dense single-line event rows match the desktop Pencil frame. |

At 320/390/425 widths messages wrap without page-level horizontal overflow, the
bottom navigation does not cover the final row, and the log list does not create a
second horizontal scroll owner. Dark and light themes use tokens only.

## Accessibility

- «Пауза», «Продолжить», and «Очистить» are real buttons with visible focus and
  explicit accessible names in icon-only mode.
- Search has an associated label; source and severity controls expose their current
  selection to assistive technology.
- New log rows are not placed in an assertive live region. Continuous engine output
  must not interrupt a screen-reader user.
- Pause, reconnecting, empty, and error states include text; colour is supplemental.
- The list uses semantic time values and preserves keyboard navigation without
  trapping focus inside the scroll owner.

## Testing and visual evidence

### Server/shared

- Zod parsing and normalization of structured mihomo frames.
- Reconnect after upstream close, HTTP error, malformed-frame streak, and abort.
- 500-entry eviction, stable ordering, snapshot/live hand-off, and clear broadcast.
- Curated pino inclusion plus redaction tests proving secrets and raw errors cannot
  enter the shared payload.

### Web

- Source, severity, and text-filter combinations; filtered-empty reset.
- Newest-first ordering and duplicate suppression after reconnect.
- Pause/unseen/continue and clear-while-paused semantics.
- Connecting, live-empty, populated, paused, reconnecting, and filtered-empty
  fixtures.

### Browser

- Dark 1440×1024 comparison with Pencil `ZdPsU`.
- Light 1440×1024 comparison with Pencil `mnDGi`.
- Mobile 390 comparison with Pencil `zW719`.
- State comparison with Pencil `rE094`.
- Responsive checks at 320/390/425/768/1024/1440 and changed container boundaries,
  with zero retries; inspect `html`, `.app-main`, and `.responsive-page--logs` for
  overflow and scroll ownership.

## Out of scope

- Redis, SQLite, files, or any history across a submerge restart.
- A full-text log database, audit trail, export, or remote log shipping.
- Raw HTTP request/response logs and routine CRUD messages.
- Persisted filters or a user-selectable ring size.
- Expanded raw pino objects or server stack traces in the browser.
- Permanent DEBUG logging or the temporary 15-minute control described above.

## Resolved decisions

1. Logs combine mihomo and curated submerge events in one newest-first timeline.
2. Every row identifies its source; filtering is local and non-persistent.
3. The server keeps one 500-event in-memory ring; Redis and SQLite are unnecessary.
4. Pause is per tab, while clear resets the process-wide ring for all tabs.
5. DEBUG examples remain in the mockup as a future reference, but v1 stays at INFO.
