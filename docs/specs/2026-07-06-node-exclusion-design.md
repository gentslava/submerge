# Node exclusion + pool inventory fix — design

- **Date:** 2026-07-06
- **Status:** Draft (awaiting approval)
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

**Node inventory comes from the DB (sources), live status overlays from `/proxies`.**
Today `nodesView(db) = toNodeView(getProxies(), meta)` — `/proxies` is the base, so a
node absent from the engine config is invisible. Flip it: the base list is
`collectProxies(db)` (every enabled source's parsed proxies, collapsed as today);
live `delay`/`now`/member-active overlay by name from `getProxies()`. A node not
currently in the engine shows as **idle (no ping)** but always appears.

This single change fixes the vanish bug (inventory no longer depends on config) and
is the precondition for exclusion (excluded nodes must stay visible to be undone).

**Why the DB is authoritative & always in sync.** `collectProxies(db)` is the enabled
sources' `proxies[]` — the *same* set that already generates the mihomo config, so
`/proxies` is strictly downstream of it. It stays current by construction:
`refreshSource` re-parses the subscription and overwrites `proxies[]` (removed nodes
drop, new ones appear); `toggleSource`/disable filters via `enabled = true`; delete
removes the row. So a DB-sourced inventory reflects the live node set with *less* lag
than `/proxies` (no reload delay), never more.

## Feature: global node exclusion (deny-list)

- **Store:** `excluded_nodes(name TEXT PRIMARY KEY)` — a node is excluded by its
  display name (the collapsed group name, matching the Узлы screen). Small, global,
  channel-independent.
- **Config-gen:** excluded names are filtered out of *every* channel's resolved
  proxies (`resolveChannelProxies` and the empty-pool "all" path both drop them), so
  they land in no url-test/select group and mihomo never routes or races through
  them — even if fastest.
- **Visibility:** excluded nodes still appear in the DB-sourced inventory, rendered
  greyed with an «исключён» badge; the toggle flips exclusion. They are **not**
  manually selectable as the active node while excluded.
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

No stopgap — the clean DB-sourced view fixes the vanish bug directly, so a temporary
PoolPicker patch would be throwaway work. Two phases:

- **Phase A — DB-sourced nodes view (fixes the vanish bug) + copy dedup.** Rebase
  `nodesView`/`toNodeView` on `collectProxies(db)` with a `/proxies` overlay
  (`delay`/`now`/member-active by name; absent → idle). The PoolPicker and Узлы screen
  then list from the DB, so pooling a subset never hides other nodes. Remove the
  duplicated empty-pool line. Blast radius: Nodes screen, collapse, active selection,
  SSE, prober — covered by their existing tests + new overlay tests.
- **Phase B — exclusion.** `excluded_nodes` table, `nodes.setExcluded`, config-gen
  filter (drop excluded from every channel's proxies + the empty-pool "all"), Узлы +
  PoolPicker UI, tests + visual gate.

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
