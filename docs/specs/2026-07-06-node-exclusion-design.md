# Node exclusion + pool inventory fix — design

- **Date:** 2026-07-06
- **Status:** Implemented (Phases A, A2, B)
- **Scope:** `packages/server` (config-gen, channels, nodes view, schema) + `packages/web` (Узлы, PoolPicker)
- **Related:** [channel-routing design](2026-07-01-channel-routing-design.md), `modules/nodes/multiConfig.ts`, `modules/channels/pool.ts`

## Problems

1. **Pool subset hides the other nodes (bug).** Selecting a subset in a channel's
   pool makes the *unselected* nodes vanish from the picker and can never be
   re-added. Root cause: `buildMultiConfig` writes only pooled proxies into the
   config's `proxies:` list, so unpooled nodes drop out of mihomo `/proxies`; and
   `PoolPicker` derives its node inventory from `nodes.list` (which is `/proxies`),
   so they disappear from the UI too. A one-way trap.
2. **No way to exclude a node (feature).** Some subscription nodes are unsuitable
   for work (e.g. can't reach blocked resources) yet may be the fastest — so a
   latency race routes work traffic through them. There's no "never use this node"
   control; the per-channel pool is an *allow-list*, the wrong tool for a global
   *deny-list*.
3. **Duplicated copy.** The «Пул» section subtitle ("Пусто — все узлы канала
   берутся автоматически") and the PoolPicker empty-state ("Пул пуст — сейчас
   используются все узлы") say the same thing.

## Core architectural change

**The engine config defines ALL non-excluded inventory nodes; a channel's pool only
picks which subset that channel *races*.** Today `buildMultiConfig` writes only each
channel's pooled proxies into `proxies:` and lists only the Default pool in `PROXY`,
so a node in no pool drops from the engine entirely — it stops being pinged, can't be
manually selected, and (before Phase A) vanished from the UI. That conflates two
separate concerns: *which nodes exist / are measured* vs *which nodes a channel races*.

Split them:
- `proxies:` (definitions) **and** `PROXY.all` (the manual exit-node selector) list
  **every non-excluded inventory node** (`collectProxies(db)` minus exclusions),
  collapsed by the same `groupProxies`.
- Each channel's url-test/select group (`AUTO`, `ch-<id>`) still lists only its **pool
  subset** (empty pool = all non-excluded).
- The background prober already probes exactly `PROXY.all` via `getDelay(name)` (which
  tests any *defined* proxy — see `prober.observe`), so once all non-excluded nodes sit
  in `PROXY` they are **all pinged** with no new url-test group.

Consequences — these are exactly the user's expectations:
- Every node shows a real latency, in or out of any pool.
- A channel's pool never affects other channels or a node's ping — it only constrains
  that channel's own auto-race. Manual override (picking any node on Узлы) stays valid.
- **Byte-identity preserved:** the Default-only, empty-pool case already emits
  `PROXY = [AUTO, …all, DIRECT]` with all nodes defined, so `config.test.ts` holds;
  only the *subset* case changes.

`mergeDbInventory` (Phase A, shipped) stays as the overlay that surfaces **excluded**
nodes — which ARE omitted from the config — as idle, marked rows, so they remain
visible and reversible. `collectProxies(db)` is authoritative and always in sync (it
already generates the config; `refreshSource` overwrites `proxies[]`, disable/delete
drop it).

## Feature: global node exclusion (deny-list)

- **Store:** `excluded_nodes(name TEXT PRIMARY KEY)` — a node is excluded by its
  display name (the collapsed group name, matching the Узлы screen). Small, global,
  channel-independent.
- **Config-gen:** excluded names are dropped from the whole config — the `proxies:`
  definitions, `PROXY.all`, and every channel group. So mihomo never defines, pings,
  routes, or lets you manually select them; they're fully out of the engine.
- **Visibility:** excluded nodes are surfaced by `mergeDbInventory` (they're the DB
  nodes absent from `/proxies`), rendered greyed with an «исключён» badge (idle, no
  ping — expected, they're out of the engine); the toggle flips exclusion, and the
  next `applyConfig` re-adds the node. Not manually selectable while excluded.
- **Pool interaction:** the per-channel pool stays an allow-list ("use only these");
  exclusion is the global deny-list applied on top. `empty pool = all nodes` means
  "all *non-excluded* nodes".

## UI

- **Узлы (NodesScreen):** per-node exclude control (toggle/menu). Excluded rows greyed
  + badge, sorted to the bottom (or a collapsed «Исключённые» section). tRPC:
  `nodes.setExcluded({ name, excluded })`.
- **PoolPicker:** inventory from sources (via the DB-sourced nodes view) so nothing
  vanishes; excluded nodes shown but disabled (can't be pooled while excluded).
- Remove the duplicated empty-pool line (keep the section subtitle).

## Phasing

- **Phase A — shipped.** `mergeDbInventory` unions the DB inventory onto the live view
  as idle rows (fixes the vanish bug) + empty-pool copy fixed. Deployed to prod.
- **Phase A2 — model upgrade (config-gen).** `buildMultiConfig` defines **all**
  non-excluded inventory nodes and lists them in `PROXY.all`; each channel group keeps
  only its pool subset. Result: every node is defined → pinged by the prober → shows a
  real latency, and a channel's pool no longer affects other channels or pinging.
  `applyConfig` passes the full inventory alongside per-channel pools. Blast radius:
  `multiConfig` (byte-identity gate — only the subset case changes), prober, Nodes
  screen. With all non-excluded nodes live in `PROXY`, `mergeDbInventory` now only
  appends excluded nodes.
- **Phase B — exclusion.** `excluded_nodes` table, `nodes.setExcluded`, drop excluded
  from `proxies:`/`PROXY`/all groups, mark them in `mergeDbInventory`, Узлы + PoolPicker
  UI, tests + visual gate.

## Testing

- config-gen: an excluded node is absent from all groups AND from `proxies:`? (decide:
  keep defined-but-ungrouped vs fully omitted — omitted is simpler and honest since the
  DB-sourced view keeps it visible). Byte-identity of the default-only, no-exclusion
  case preserved.
- `resolveChannelProxies`: excluded names dropped from both the empty-pool and explicit
  paths.
- nodes view overlay: a DB node missing from `/proxies` → idle; present → live delay.
- web: PoolPicker lists sources' nodes regardless of pool; excluded node disabled;
  exclude toggle round-trips.
- Visual gate: Узлы + Маршрутизация at 1440 dark + 390.

## Open decisions

1. Exclude keyed by **display name** vs `server:port` (name is what the UI shows and
   what pools already use; go with name unless dedup collisions bite).
2. Excluded node **fully omitted** from config vs defined-but-ungrouped — lean omitted
   (simplest; visibility comes from the DB-sourced view, not the engine).

## Known follow-ups (from Phase B review)

- **Manual-pin reconciliation.** Excluding a node that is a `manual` channel's
  `pinnedNode` leaves a dangling pin: with `onFailure: "hold"` the controller keeps
  trying to select the now-absent node (mihomo rejects, the throw is swallowed) and the
  channel silently stops adapting. Pre-existing shape (source removal already orphans a
  pin); exclusion adds an easy path. Fix later: on exclude, detect + repoint/clear a
  matching `pinnedNode` (or log a decision). `fallback` degrades gracefully.
- **Reload-pending flag window.** The `excluded` flag is set on DB-only (appended)
  nodes; if `applyConfig`'s reload fails (`applied:false`), the running engine still
  returns the node in `/proxies`, so it stays present + unmarked until the next
  successful reload. `warnIfNotApplied` surfaces the failure, so accepted as-is.
