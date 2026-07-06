# Channel-based routing & active node selection — design

- **Date:** 2026-07-01
- **Status:** Implemented (Phases 1–2: channel abstraction + sticky controller; Phases 3a/3b: multi-channel routing mechanics + Routing UI + domain presets)
- **Supersedes:** the current single-`AUTO`-group model in `packages/server/src/modules/nodes/config.ts`
- **Related:** [2026-07-01-node-collapse plan](../plans/2026-07-01-node-collapse.md), `docs/architecture.md`, ADR-0004 (anti-overengineering)

## 1. Problem

Automatic active-node selection today is opaque and uncontrollable for real usage scenarios.

**How it works now (established from the code):**

- The submerge server never switches nodes itself. It only generates `config.yaml` and reads state over the Clash REST API. All switching is mihomo's `url-test` logic.
- `config.ts` emits exactly one automatic group, `AUTO` (`type: url-test` by default), plus a user-facing `PROXY` (`type: select`), plus collapsed url-test subgroups for same-named nodes. Routing is a single catch-all rule: `MATCH,PROXY`.
- The setting `switchOnTimeout` maps to mihomo as `lazy: !switchOnTimeout`. `lazy` does **not** mean "switch on timeout" — it means "skip periodic health-checks while the current node is alive." With the default `switchOnTimeout: true` → `lazy: false`, mihomo re-tests every `interval` and, under `url-test`, re-picks the lowest-latency node whenever another beats the current by more than `tolerance` (default 50 ms). The deployed config uses `interval: 30`, so the active node (and thus the exit IP) can hop every 30 s. That is the "non-obvious switching": the setting label describes timeouts, but the mechanism is continuous latency chasing.

**What is missing:**

- A true "stay on one IP as long as possible" mode with an understandable trigger (the closest native option, `fallback`, is order-based, not "hold the current good node until it actually dies").
- Any per-domain / multi-mode routing (e.g. YouTube via one set of nodes, messengers via another, torrents via a third). Everything goes through one global group.

## 2. Goals

1. Replace opaque strategy knobs with **explicit, documented, controllable policies**.
2. Support the three real scenarios in one coherent model:
   - **Speed** — lowest latency / best responsiveness; IP rotation acceptable; optionally "universal" against blocked resources.
   - **Stable IP** — hold one exit IP as long as possible to avoid session resets / re-logins.
   - **Multi-mode** — route domain sets through different pools of nodes.
3. Make every switch **explainable** ("switched A→B because A failed 3 health-checks" / "B is 120 ms faster") so the current "why did it switch?" confusion never recurs.

### Non-goals (this design)

- No TUN mode / system-wide transparent routing changes.
- No GeoIP auto-tagging of nodes (pools are assigned manually).
- No rule-provider (external ruleset URL) support in v1 — deferred to phase 4.
- No persistent decision history/analytics in v1 — in-memory only (see §7).

## 3. The unifying abstraction: Channels

One entity subsumes both presets and multi-routing:

```
Channel = {
  matcher:  which domains/traffic land here   (empty = catch-all)
  pool:     which nodes/sources are available (manual selection)
  policy:   how to pick a node from the pool  (speed | sticky | manual)
}
```

Routing is an **ordered list of channels + a Default** (catch-all at the end):

- One `Default` channel, `policy = speed` → today's behaviour.
- One `Default` channel, `policy = sticky` → the long-lived-IP mode.
- Several channels (`Media` → YouTube nodes, `Messengers` → stable nodes, `Torrent` → no-DMCA nodes) → multi-mode routing.

All three are special cases of the same model. mihomo receives `rules:` (domain → channel group) and one group per channel.

**Rejected alternative:** a flat "global strategy" setting plus a separate "rules" feature — two unrelated subsystems instead of one. Rejected in favour of the unified model.

## 4. Data model

New tables (snake_case columns, mapped in `schema.ts`; camelCase in TS):

**`channels`**

| column | type | notes |
|---|---|---|
| `id` | text (pk) | |
| `name` | text | |
| `priority` | integer | lower = evaluated first; Default is always last |
| `enabled` | integer (bool) | |
| `policy` | text | `speed` \| `sticky` \| `manual` |
| `policy_params` | text (JSON) | per-policy knobs (see §5) |
| `matcher` | text (JSON) | `{ presets: string[], domains: string[] }` |
| `is_default` | integer (bool) | exactly one row; non-deletable |
| `last_reason` | text (nullable) | last switch/hold reason (see §7) |
| `last_reason_at` | integer (nullable) | epoch ms of last decision |

**`channel_pool`** (membership)

| column | type | notes |
|---|---|---|
| `channel_id` | text (fk) | |
| `kind` | text | `source` \| `node` |
| `ref` | text | `source` → sourceId (durable); `node` → node name (best-effort) |

### Durability / the node-identity problem

Nodes are live-only (they come from mihomo, keyed by name). Therefore:

- **Source membership is durable** — sources persist in the DB; "all nodes from source X" survives subscription refreshes.
- **Node membership is best-effort** — keyed by node name. If a subscription refresh drops or renames a node, its pool entry becomes **stale**. The pool resolves against the current live node set; stale entries are surfaced in the UI as "unavailable" and excluded from selection. The policy picks from the remaining live pool. We do not silently substitute.

The **Default channel** is seeded by a migration: it inherits the current `autoStrategy`/`autoTestUrl`/`autoTestInterval`/`autoTestTolerance` settings as its `policy = speed` params, and its pool is "all nodes" (empty pool = all live nodes). This makes phase 1 a behaviour-preserving refactor.

## 5. Policies

### `speed` (Optimal) — lowest latency, rotation acceptable

- **Mechanism (hybrid):** native mihomo `url-test` group. The server sets `url` (the channel test target), `interval`, `tolerance`, and `lazy`.
- **Universality against blocked resources, for free:** the channel test target can be set to a representative of that channel's traffic (a `Media` channel tests against `youtube.com`). "Fastest" then means "fastest to the resource that matters," which also filters out nodes that cannot reach it.
- **Server role:** passive supervision. It records latency history and reconstructs the switch reason from mihomo's per-node delay history when `.now` changes (`B faster: 40 vs 180 ms` / `A did not respond`).
- **Params:** `testUrl: string`, `intervalSec: number`, `toleranceMs: number`, `reevaluateWhileHealthy: boolean` (this replaces the mislabelled `switchOnTimeout`; it maps to mihomo `lazy = !reevaluateWhileHealthy`).

### `sticky` (Stable IP) — hold one IP as long as possible

- **Mechanism (hybrid, server-controlled):** the channel's mihomo group is a dumb `select`. The server measures the pool, picks the best node once, **pins** it via `PUT /proxies/{group}`, then monitors **only the active node**. It switches **only** after `K` consecutive health-check failures (a real outage) → re-pick best, pin, record reason.
- **Params:**
  - `testUrl: string`, `intervalSec: number` — active-node health probe.
  - `failureThreshold: number` (K) — consecutive failures before switching.
  - `maxHoldHours: number | null` — optional forced re-pick after N hours even if healthy (default `null` = never).
  - `initialCriterion: 'fastest' | 'lowest-loss' | 'highest-bandwidth'` — how the "best" node is chosen when (re)picking (see Scoring inputs below; `highest-bandwidth` uses cached values and is a phase-4 addition).

### `manual` (Pinned)

- The user pins a specific node for the channel; the server holds it.
- **Params:** `pinnedNode: string`, `onFailure: 'hold' | 'fallback'` — on pinned-node failure, either keep it (and surface an error) or fall back to a server-picked node from the pool.

### Scoring inputs

The "best node" decision (used by `sticky` re-pick and surfaced for `speed`) can draw on several signals. They differ sharply in cost, which dictates where each is used.

| signal | how measured | cost | use |
|---|---|---|---|
| **latency** | `/proxies/{name}/delay` (HTTP GET to test URL) | cheap, active, per-node | primary; every tick |
| **jitter** | variance across a short series of latency probes | ~same as latency | quality proxy; cheap tiebreaker |
| **loss** | failed vs total delay probes over a window | cheap | `lowest-loss` criterion |
| **passive bandwidth** | observed up/down bytes/sec of the active node from `/traffic` counters (already streamed) | free | display + cached scoring; **active node only, demand-limited** |
| **on-demand bandwidth** | download a fixed test payload through a specific node, bytes/sec | expensive — burns real quota, seconds per node, disrupts the node | user-triggered only; cached as a scoring weight |

**Latency measures responsiveness (ping); it does not measure capacity (throughput).** A low-latency node can still be bandwidth-limited. Capacity is therefore treated as a **cached, secondary** signal, never a per-tick active probe (see §11 for the quota rationale).

**On-demand speed test (mechanism).** mihomo has no "request through node X" endpoint and no throughput test. To measure a specific node in isolation without disturbing live routing, use a dedicated hidden `PROBE` `select` group containing all nodes plus a rule routing a reserved probe host to `PROBE`: the server sets `PROBE.now = node`, issues an HTTP GET for a fixed-size payload on that host through mihomo's local proxy port, measures bytes/sec, then restores. Exposed as a per-node/per-pool **"Speed test"** UI action with an explicit traffic-cost warning. Results are cached (last value + timestamp) per node.

Adds a `sticky` criterion: `initialCriterion: 'fastest' | 'lowest-loss' | 'highest-bandwidth'`. `highest-bandwidth` ranks by the **cached** bandwidth value (on-demand or passive); nodes without a cached value fall back to `fastest` ordering.

## 6. Controller (single server-side loop)

Extends the existing `LiveHub` poll in `packages/server/src/live/`; no new fleet of workers.

```
each tick:
  read mihomo /proxies (already done)
  for each channel:
    speed        → passive: record history; reconstruct "why" on .now change
    sticky/manual→ active:  evaluate active-node health from delay history / active probe
                            decide hold vs switch per policy
                            on switch: PUT /proxies/{group}, append a decision-log entry
```

- Probes are throttled, reusing the existing `probeActive` throttle so we never exceed a channel's own interval.
- The loop is idempotent and driven by DB state, so config reloads and restarts are safe.

## 7. Observability — kills the "non-obvious" problem

- **Decision log:** an **in-memory ring buffer** of the last N decisions per channel (`{ ts, channelId, from, to, reason }`). The **last decision per channel is persisted** as `last_reason` + `last_reason_at` columns on the `channels` table, so the UI shows something meaningful immediately after a restart; older ring entries are lost on restart (acceptable for a single-admin tool).
- **UI per channel:** current node, policy, and the last decision + reason + relative time ("holding — node alive 2 h 14 m" / "switched A→B: A failed ×3").
- **Latency history:** bar chart, consistent with the rest of the UI (see the project chart-style convention).
- **Passive bandwidth:** show the active node's observed up/down Mbps from the live `/traffic` counters (free; reflects real usage, not capacity).

## 8. mihomo config generation

Changes to `packages/server/src/modules/nodes/config.ts`:

- **One group per channel:**
  - `speed` → `url-test` (native), members = resolved channel pool.
  - `sticky` / `manual` → `select` (server pins), members = resolved channel pool.
- Existing collapsed url-test subgroups for same-named nodes are preserved and nest inside a channel's members.
- **`rules:`** generated by channel priority: each non-Default channel with a matcher emits domain rules (`DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`) → that channel's group; the Default channel emits the terminal `MATCH,<default-group>`.
- The top-level `PROXY` `select` group is retained as a global manual override; it lists the channel groups + `DIRECT`.
- If no proxies exist at all, keep the current `MATCH,DIRECT` fallback.

Matchers in v1 are **presets + custom domains**: bundled curated domain lists per preset (`youtube`, `telegram`, `discord`, `torrent`, …) expanded into rules at generation time, plus a free-text domain list. Rule-providers (external URLs) are deferred.

## 9. UI

New **Routing** section:

- List of channels, drag to reorder (= priority). Default pinned at the bottom, non-deletable.
- Per channel editor: name, matcher (preset chips + custom-domain field), pool (checkboxes over sources and live nodes), policy selector + that policy's knobs.
- Per channel status: current node, last decision + reason (from §7).
- Nodes screen: show which channel(s) route through each node and the active pick per channel; show the active node's passive Mbps; a per-node/per-pool **"Speed test"** action (on-demand bandwidth, §5) gated behind a traffic-cost warning.

All controls follow the design-system gates (tokens-in-config, measure-don't-invent, control-type fidelity, visual verification at 1440×1024 dark + breakpoints).

## 10. Phasing (vertical slices)

Even as one model, ship incrementally; each slice is behaviour-verifiable.

1. **Abstraction + Default (no behaviour change).** Introduce `channels`/`channel_pool`, seed a single Default channel from current settings, route everything through it, rename `switchOnTimeout` → `reevaluateWhileHealthy`. Settings become honest; behaviour identical.
2. **`sticky` + controller.** Add the `sticky` policy, the server pin loop, the decision log, and the "why" UI on the Default channel. **Delivers the immediate IP-stability win.**
3. **Multiple channels + rules.** Channel CRUD, preset+custom matchers, per-channel groups and `rules:` generation. **This is multi-mode routing.**
4. **Polish.** Reachability-weighted test targets, scheduled rotation (`maxHoldHours`), rule-providers, on-demand speed test + `highest-bandwidth` criterion.

Passive-bandwidth display (§7) is nearly free and may land earlier (alongside phase 2/3) rather than waiting for phase 4; active bandwidth (the `PROBE`-group speed test and `highest-bandwidth`) stays in phase 4 because of its traffic cost.

## 11. Risks & tradeoffs

- **Duplicating engine logic (ADR-0004).** For `speed`, native `url-test` is simpler and proven — we deliberately keep it native and only supervise. Server-side control is reserved for what mihomo cannot express (hold-until-dead, max-hold, scheduled rotation, explainable decisions, unified per-channel policy). This is the reason the controller is *hybrid*, not *full*.
- **Sticky failover latency.** With server-controlled pin, worst-case failover is one control-loop tick (~5–10 s) plus `K × intervalSec` to confirm the outage. Acceptable for a single-admin self-hosted tool; the active node is probed more frequently than the interval to keep this tight.
- **Stale node pool entries.** Handled explicitly (§4): surfaced, excluded, never silently substituted.
- **Rules ordering correctness.** Channel priority must deterministically produce rule order; the Default terminal `MATCH` must always be last. Covered by unit tests on config generation.
- **Bandwidth probing burns quota.** Many subscriptions are metered (some are device-bound via HWID). Active throughput measurement consumes real traffic, so it is never run on a periodic schedule — only user-triggered, one node/pool at a time, behind an explicit warning, with results cached. Latency/jitter/loss (cheap, active) and passive bandwidth (free) carry the periodic scoring; capacity is a cached secondary signal only.
```
