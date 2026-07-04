# Background node prober — design

- **Date:** 2026-07-03
- **Status:** Implemented
- **Scope:** `packages/server` (live hub, new prober, settings), `packages/web` (Settings, Nodes header copy)
- **Related:** [2026-07-01 channel routing](2026-07-01-channel-routing-design.md), ADR-0004 (anti-overengineering)

## 1. Problem

Node latency measurements are incomplete and go stale, so the panel shows «— ms» /
`timeout` for long stretches and the selection policies work off outdated data:

- Under **sticky/manual** policies the `AUTO` group is a mihomo `select` — mihomo
  never probes select members, and the panel only probes the *active* node. Nothing
  measures the rest.
- Every **config reload** (any settings change) wipes mihomo's entire delay history;
  all nodes read as unmeasured until the next url-test cycle (up to «Интервал
  проверки» later).
- The user faces **two intervals** («Опрос каждые N с» + «Интервал проверки») when
  the mental model is one: *check node liveness every N seconds*.

## 2. UX principles (the contract this design serves)

- **P1 — one knob.** The user sets a single number N: «проверять живость узлов раз
  в N сек». Smaller N = faster reaction; larger N = less load. No other intervals
  are exposed.
- **P2 — complete, fresh measurements.** Every node has a measurement no older than
  N — regardless of policy, config reloads, or whether the tab is open.
- **P3 — selection by policy from that history.** The active node is chosen by the
  configured policy, using up-to-date measurements. *(Already satisfied — see §3.)*
- **P4 — honest, fast reflection.** Timeouts and never-measured are distinct states
  (shipped: «таймаут» vs «— ms»); state changes reach the UI in seconds.

## 3. Verified mihomo facts (what we build on)

| Mechanism | Behavior |
|---|---|
| Events | No push for proxies; `GET /proxies` snapshots only. Traffic is a real stream. |
| url-test group (speed-policy `AUTO`, collapsed same-name subgroups) | mihomo probes **all members** every `interval` with our `url`, picks fastest within our `tolerance`. We author all parameters — its selection IS our speed policy. |
| select group (sticky/manual `AUTO`) | mihomo never probes members. |
| `GET /proxies/{name}/delay` | On-demand probe; the result is recorded into that proxy's history. |
| Config reload | Erases all delay history. |

**Consequence:** selection logic already matches P3 everywhere (mihomo executes our
speed rules; our controller owns sticky/manual). What's broken is **measurement**
(P1/P2). This design changes measurement only; **no selection behavior changes**.

## 4. Design

### 4.1 Prober (new, `packages/server/src/live/prober.ts`)

A gap-filling measurement loop driven by the existing hub tick:

- On every internal pulse (5 s), compute the **stale set**: real nodes (same set as
  «Пинг всех»: top-level non-pseudo entries, groups included — probing a group
  measures its active member) whose latest measurement is **older than N** or
  missing. Freshness comes from mihomo history timestamps (`history[].time`,
  already returned by `/proxies`; currently dropped during normalization — keep the
  latest timestamp per node).
- Probe the stale set in **rolling batches**: at most
  `ceil(totalNodes × pulse / N)` per tick (full sweep completes within N), with a
  hard concurrency cap of 10. Round-robin order; the queue is rebuilt from the
  latest view each tick, so renames/reloads self-heal.
- Probes go through the existing `getDelay(name, testUrl)` client call — mihomo
  records results into history, so the **existing read path (`/proxies` →
  `toNodeView` → SSE) picks them up with zero new display plumbing**.
- Failures are per-node (`testDelay` semantics: timeout/unreachable → recorded 0 by
  mihomo); a failed probe never breaks the pulse. Errors follow the hub's
  once-per-streak `onError` pattern.

Effects per policy:
- **speed:** mihomo's own url-test keeps measuring; the prober only fills gaps
  (right after a reload; nodes a cycle hasn't reached). Fresh nodes are skipped —
  no double probing.
- **sticky/manual:** the prober is the (previously missing) measurement source;
  the controller's decisions now rest on data no older than N.

### 4.2 One knob (settings & UI)

- «Интервал проверки» (`policy.intervalSec`) becomes **the** knob N: it already
  drives mihomo's url-test interval and the active-node probe throttle; now it also
  drives the prober's staleness threshold and batch sizing.
- «Опрос каждые N с» (`pollInterval` setting) is **removed from the UI**; the pulse
  becomes an internal constant (5 s, `INTERNAL_POLL_SEC` in shared defaults). The
  stored setting is ignored (no migration needed).
- Nodes header copy changes from «опрос каждые 5 с» to «проверка каждые N c»
  (value from the policy).
- Settings mockup: the poll-interval row is deleted — recorded here as the product
  decision (mockup update to follow by the design owner).

### 4.3 Non-goals (explicitly out of scope)

- **No selection changes.** Speed stays a mihomo url-test group; sticky/manual
  controller logic is untouched.
- sticky/manual controller still performs its own decision-time probes
  (`pickBest`); migrating it onto the prober's map is a later cleanup.
- No per-node "updated Xs ago" labels or liveness animations (declined).

## 5. Error handling

- mihomo unreachable → prober skips the tick; existing hub health/onError covers
  reporting (once per outage streak).
- Probe of a vanished node (renamed/removed between view and probe) → 404 from
  mihomo → recorded as a per-node failure, dropped from the queue on next rebuild.
- N smaller than the pulse (e.g. 5 s for 90 nodes) → batch = all stale nodes,
  capped at 10 per tick; the sweep simply takes longer than N — acceptable, no
  special casing.

## 6. Testing

- **Prober unit tests:** batch sizing (`ceil(total × pulse / N)`), concurrency cap,
  staleness filter (fresh nodes skipped), queue rebuild after rename/reload,
  failure isolation.
- **Hub integration:** pulse calls prober; prober errors don't affect health.
- **Normalization:** latest-measurement timestamp surfaced from history.
- **Live verification on the stand:** singles get measurements within N; после
  reload all nodes are re-measured within N; sticky policy switches away from a
  killed node within pulse + N.

## 7. Rollout

Built on top of `integration/backlog-batch` (depends on the timeout-display fix).
Ships as one vertical slice: prober + settings simplification + copy change.
