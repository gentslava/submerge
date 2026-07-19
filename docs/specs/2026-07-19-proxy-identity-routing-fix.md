# Exact proxy identity in channel routing — design

- **Date:** 2026-07-19
- **Status:** Implemented
- **Scope:** `packages/server` proxy grouping, channel-pool resolution, and multi-channel config generation
- **Related:** [Channel routing](2026-07-01-channel-routing-design.md), [node collapse](2026-07-01-node-collapse-design.md)

## Problem

Submerge currently treats `server:port` as a proxy identity in three routing paths.
That is only a socket address, not a complete mihomo outbound. Two profiles may share
the same address and port while differing in UUID, Reality public key, SNI, flow,
transport options, or another protocol-specific field.

This caused a production routing violation: a channel pool selected
`YouTube — Без Рекламы`, but that profile shared `server:port` with an earlier
`AUTO — Англия` profile. Multi-channel config generation reused the earlier flat
proxy definition, so the generated channel contained England even though England
had never been selected in its pool.

The same assumption can also:

- discard a distinct profile while resolving a source/node pool union; and
- discard a distinct same-named profile before building a collapsed url-test group.

## Identity invariant

Two proxies are the same only when their complete validated `Proxy` objects are
deeply equal. The comparison includes `name`, protocol, socket address, credentials,
TLS/Reality fields, transport options, and every other emitted mihomo property.

Consequences:

- exact repeated records are still de-duplicated;
- different profiles on one `server:port` remain independent;
- a non-default channel reuses only the exact definition already emitted by an
  earlier channel;
- same-name profiles on one `server:port` collapse into a subgroup when any
  configuration field differs.

Scale is one admin and hundreds of nodes, so direct deep comparison is preferable
to a custom serialized fingerprint: it is order-independent for object properties,
avoids maintaining a protocol-field allow-list, and is easily fast enough here.

## Implementation

Add one server-internal equality helper based on Node's `isDeepStrictEqual`, then use
it consistently in:

1. `groupProxies` when dropping exact duplicates;
2. `resolveChannelProxies` when unioning source and node pool members;
3. `buildMultiConfig` when sharing already-emitted proxy definitions across channels.

No database, shared contract, API, or web changes are required.

## Regression coverage

- Same name + same `server:port` + different UUID produces a collapsed group with
  both members.
- A pool union retains two differently configured profiles sharing `server:port`,
  while an exact repeat remains de-duplicated.
- A non-default channel selecting the second of two same-address profiles references
  that exact profile, never the first profile emitted by Default.

## Verification

- Focused server tests for config grouping, pool resolution, and multi-channel config.
- Repository-wide `pnpm verify:static`.
- Independent incremental and final code reviews. This is server-only and has no UI
  or visual-gate impact.
