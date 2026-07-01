# Spec: Collapse same-named nodes into url-test groups

**Date:** 2026-07-01
**Status:** Accepted (v1)
**Scope:** `packages/server/src/modules/nodes/config.ts`, `packages/server/src/modules/nodes/service.ts` (`toNodeView`), `packages/shared/src/schemas.ts` (`NodeItem`), `packages/web/src/features/nodes/nodeView.ts` + node-row component.

## Problem

Subscription providers ship several distinct servers under an identical display
name (e.g. `🇪🇺 AUTO — Самый быстрый ⚡️` appears 5× with 5 different
`server:port`). mihomo requires unique proxy names, so `dedupeNames` in
[config.ts](../../packages/server/src/modules/nodes/config.ts) suffixes the
duplicates `-2/-3/…`. The web groups nodes to a source by exact name match
([nodeView.ts `groupNodes`](../../packages/web/src/features/nodes/nodeView.ts)),
so the suffixed duplicates match no source and fall into the synthetic "Прочие"
bucket. Observed live: 44 proxies = 27 unique base names + 17 dedup duplicates;
UI showed Opengate 26 + Subscription 1 + **Прочие 17**.

## Goal

Present each set of same-named servers as **one node** that auto-selects the
fastest member — a mihomo `url-test` proxy-group. This matches the provider's
intent ("any of these fast EU servers") and, as a side effect, empties "Прочие"
because every top-level entry then matches a source by name.

## Non-goals (v1)

- **Pinning a specific member.** A `url-test` group cannot be manually pinned in
  mihomo (it re-selects on each test). Manual pin would require a two-level
  `select → [url-test, server₁…]` structure — deferred. The `members` data model
  below is designed to accept it later without reworking config generation.

## Behavior decisions (locked)

1. **Selection granularity:** group only. `Выбрать` sets the whole group active;
   members are **view-only** when expanded.
2. **Group ping:** the **active member** (`now`) — consistent with how the
   top-level `AUTO` already reports its `now`.

## Design

### 1. Grouping key (server, `config.ts`)

- Group the raw proxies from `collectProxies` (**before** dedupe) by **exact
  `name`** — no `-N` suffix stripping, so a provider node honestly named `…-2`
  is never merged by accident.
- Within a same-name set, collapse **true duplicates** by `server:port` (keep
  the first occurrence, drop the rest).
- After that: 1 remaining → singleton (plain proxy, unchanged). ≥2 → collapsed
  `url-test` group.

### 2. Config generation (`buildConfig`)

For each base name with ≥2 distinct-endpoint members:

- Members get unique mihomo names `«<base> #1» … «#N»` in source order; the
  **group** keeps the clean `<base>` name.
- Emit `proxy-group { name: <base>, type: url-test, url, interval, tolerance,
  lazy, proxies: [member names] }`, reusing the AUTO tuning (`url`, `interval`,
  `tolerance`, `lazy`) from settings.

Top-level entries = singletons + group names, preserving source/sortOrder; a
group takes the position of its first member.

- `PROXY` (select): `["AUTO", ...topLevel, "DIRECT"]`
- `AUTO` (url-test): `[...topLevel]`

`proxies:` contains all real servers (members + singletons); the final
`dedupeNames` stays as a uniqueness safety net.

**Reserved-name guard:** if a base name equals a reserved group name
(`AUTO`, `PROXY`, `DIRECT`, `REJECT`, `GLOBAL`), rename the emitted group
(deterministic suffix) to avoid colliding with the system groups.

Backward-compat: with no same-name duplicates the output is byte-for-byte the
previous config (feature is a no-op).

### 3. Data contract (`shared`) + normalization (`toNodeView`)

- Extend `NodeItem` with `members?: NodeMember[]`, where a member is
  `{ name, delay, history, active }` (`active` = it is the group's `now`).
- In `toNodeView`: a `PROXY.all` entry whose mihomo type is `URLTest` (and is not
  the top-level `AUTO`) is a collapsed group — build `members` from
  `proxies[name].all`, mark the active one, and set the **group's `delay`/history
  to the active member's** (decision 2). Singletons unchanged.

### 4. UI (`web/nodeView.ts` + node-row component)

- `groupNodes` logic unchanged (match by name); a node may now carry `members`.
- Node row: with `members`, show an expand chevron; expanded lists members
  **read-only** (each member's ping + active marker). Row ping = active member.
- `Выбрать` on a group → `selectNode("PROXY", <base>)` (API unchanged); mihomo
  keeps the fastest member.

### 5. Delay test (⚡) & live polling

`getDelay(name)` and the periodic poller
([live/singleton.ts](../../packages/server/src/live/singleton.ts)) iterate
`PROXY.all` names — which now include group names. mihomo's delay endpoint on a
`url-test` group tests its members and returns the group delay; member histories
populate via mihomo's own periodic url-test. So ⚡ on a group = test the group,
and expanding shows fresh member pings. No new wiring.

## Edge cases

- All members share one `server:port` → collapse to 1 → singleton (no group).
- A member times out → `url-test` routes through a working one; group ping
  follows `now`.
- Ordering: group sits at the position of its first member.
- Chart/history for a group = the active member's history; it "jumps" when
  mihomo switches members (accepted).

## Known limitation

**Selection reset on upgrade.** submerge does not persist the selected node —
mihomo owns that state. A previously hand-picked raw duplicate is renamed to a
member (`#k`, absent from `PROXY.all`) after upgrade, so mihomo drops that
`PROXY` selection and falls back to its default. One-time, non-critical;
documented as expected.

**Reserved-name collapse falls into "Прочие".** If a subscription literally
names a node `AUTO`/`PROXY`/`DIRECT`/`REJECT`/`GLOBAL` and ships ≥2 of them, the
reserved-name guard renames the emitted group (e.g. `AUTO-2`) to avoid colliding
with the system groups. The source still stores the raw base name, so the
UI's exact-name `groupNodes` match fails and this one group lands in "Прочие".
Pathological input; cosmetic only (the group still routes and is selectable). Not
fixed in v1 — a proper fix would carry the original base name through to the
web for source-matching.

**Same name across sources merges.** `groupProxies` groups the flat
`collectProxies` stream by name across all sources, so identical names shipped by
two different subscriptions collapse into one group, attached (by `groupNodes`)
to whichever source lists that name first (by `sortOrder`). Consistent with "one
node over N servers" regardless of origin, but a behavior change worth noting.

## Verification (source-driven, do before implementing)

- **Nested url-test:** confirm mihomo allows a `url-test` group (`AUTO`) to
  reference other `url-test` groups. clash-meta supports group nesting, but
  verify against current mihomo docs. If unsupported, `AUTO` references the flat
  member/singleton proxies instead of the groups (feature still works; only
  `AUTO`'s membership changes).

## Testing (TDD, failing tests first)

- `config.test.ts`: group by exact name; collapse `server:port` duplicates;
  singleton when all endpoints identical; unique member names; `PROXY`/`AUTO`
  reference groups; url-test subgroup shape; reserved-name guard; no-duplicate
  input is a no-op.
- server `toNodeView`/nodeView test: group node carries members, `delay` = active
  member, singletons untouched.
- web `groupNodes`: collapsed input produces no orphans ("Прочие" empty).
