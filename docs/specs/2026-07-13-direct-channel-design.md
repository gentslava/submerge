# System Direct channel — design

- **Date:** 2026-07-13
- **Status:** Accepted
- **Related:** [Channel-based routing](2026-07-01-channel-routing-design.md), [routing Phase 4](2026-07-07-routing-phase4-design.md), `docs/design-system.md`

## 1. Problem

Submerge can route matched traffic only through proxy-backed channels. Direct routing is currently limited to generator fallbacks and internal rule-provider downloads, so the administrator cannot explicitly keep LAN, private addresses, local names, or arbitrary traffic outside the tunnel.

Direct routing must use the same ordered matcher model as proxy routing without pretending that `DIRECT` is a proxy group. A fake group would introduce meaningless node pools, policies, health checks, and controller state.

## 2. Goals

1. Provide exactly one system-managed `Direct` channel.
2. Create it automatically, keep it non-deletable, and allow the administrator to enable, disable, configure, and reorder it.
3. Route every existing matcher family to mihomo's native `DIRECT` target.
4. Provide independently switchable built-in exclusions for private networks and local domains.
5. Add first-class IPv4 and IPv6 CIDR matchers to the shared matcher model.
6. Preserve the existing non-deletable `Default` proxy channel as the terminal catch-all.

## 3. Non-goals

- Multiple direct channels or user-created channels with a direct target.
- A proxy group named `DIRECT`.
- A node pool, selection policy, health controller, decision log, or active node for Direct.
- Automatic bypass lists for services unrelated to local/private connectivity.
- Transparent DNS or TUN-mode changes.

## 4. Channel model

`Channel` becomes a discriminated union with common identity, ordering, enabled state, and matcher fields:

```ts
type ProxyChannel = ChannelBase & {
  target: "proxy";
  policy: ChannelPolicy;
};

type DirectChannel = ChannelBase & {
  id: "direct";
  name: "Direct";
  target: "direct";
  isDefault: false;
  directPresets: DirectPresetSettings;
};

type DirectPresetSettings = {
  privateNetworks: boolean;
  localDomains: boolean;
};
```

Only `ProxyChannel` has a pool, policy, controller state, active node, and decision history. APIs and UI components narrow on `target`; they must not manufacture placeholder policy or pool values for Direct.

The existing `Default` row remains a `target: "proxy"` channel with `isDefault: true`. It is still forced last and emits the terminal `MATCH` rule. “One system Direct channel” means one system-owned channel whose target is `DIRECT`; it does not replace Default.

### Invariants

- Stable Direct id: `direct`.
- Stable reserved name: `Direct`. Reservation compares `name.trim().toLowerCase()` with `"direct"`, and persisted user-channel names are trimmed.
- Exactly one Direct row; it is created by the system, never by channel CRUD.
- Direct and Default cannot be deleted.
- Direct cannot be renamed or assigned a policy or pool.
- Direct participates in the same priority order as non-default proxy channels.
- Direct is inserted at priority `0` initially; Default remains last.
- Disabling Direct omits all of its rules. Matching then continues through later channels and finally Default.
- An enabled Direct with no active presets and no custom matchers is a valid no-op.

## 5. Matchers and built-in presets

Direct supports every shared matcher family:

- preset domains;
- custom domains;
- domain keywords;
- external rule-providers;
- GEOSITE categories;
- GEOIP categories;
- IPv4 and IPv6 CIDRs.

CIDR becomes a general `ChannelMatcher` field, `cidrs: string[]`, not a Direct-only exception. The strict input schema validates each address and prefix; the read model defaults `cidrs` to an empty array and remains tolerant of legacy/corrupt JSON in the same way as the existing matcher fields. Validation uses the existing Zod stack rather than adding a CIDR dependency. The generator emits `IP-CIDR` or `IP-CIDR6` according to the validated address family.

CIDR rules deliberately omit `no-resolve`. A hostname that resolves to a private IPv4 or IPv6 address must be eligible for Direct; `no-resolve` would restrict matching to connections whose destination is already an IP literal.

Because the read model is intentionally tolerant, generation defensively skips an invalid CIDR found in a legacy or manually corrupted row. Valid writes cannot create that state.

Direct has two independently switchable built-in presets, both enabled on first creation:

### Private networks

Generated as explicit rules so basic local connectivity never depends on downloading geodata:

```text
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.168.0.0/16
::1/128
fc00::/7
fe80::/10
```

### Local domains

Generated as these exact rules, in this order:

```text
DOMAIN-SUFFIX,localhost,DIRECT
DOMAIN-SUFFIX,local,DIRECT
DOMAIN-SUFFIX,lan,DIRECT
DOMAIN-SUFFIX,home.arpa,DIRECT
```

`DOMAIN-SUFFIX` intentionally covers both the listed name and its subdomains. The built-in presets do not silently enable `GEOSITE,private`; an administrator may add that custom matcher explicitly, accepting the existing geodata download behavior.

## 6. Persistence and migration

The `channels` table gains:

- `target`: `proxy | direct`, non-null, defaulting existing rows to `proxy`;
- nullable proxy policy storage so Direct does not persist a fake policy;
- `direct_presets`: nullable JSON mapped to `directPresets`, present only for Direct and validated as exactly `{ privateNetworks: boolean, localDomains: boolean }`.

The shared read model validates the complete discriminated union. Database checks constrain the two targets and require proxy rows to have a policy while Direct has `policy = NULL`, `is_default = false`, and non-null presets. A partial unique database index enforces at most one `target = 'direct'` row, while service invariants require its stable id and ensure it exists.

Changing `policy` from non-null to nullable requires a SQLite table rebuild. The migration performs it transactionally and preserves pool membership explicitly:

1. Create the replacement `channels` shape and copy every existing channel as `target = 'proxy'`, preserving its policy and priority.
2. Create a replacement `channel_pool` referencing the replacement channels table and copy every pool row.
3. Drop the old child table before the old parent table, rename both replacements, and recreate their indexes, including a partial unique index for `target = 'direct'`.
4. Do not insert Direct or mutate priorities in migration SQL; boot-time system-row initialization is the single authority for both fresh and upgraded databases.

Boot calls `ensureDefaultChannel` first and then an idempotent `ensureDirectChannel`. When Direct is absent, `ensureDirectChannel` runs one transaction:

1. Capture existing non-default channels in deterministic `(priority, id)` order before changing any row.
2. Rename any user channel whose trimmed, ASCII-case-folded name is `direct` to `Direct (custom)`, then `Direct (custom 2)`, `Direct (custom 3)`, and so on against similarly normalized existing names.
3. Insert Direct at priority `0`, enabled, with both system presets enabled and an empty custom matcher.
4. Assign the captured non-default channels priorities `1..N` in their captured order and Default priority `N + 1`.

This same sequence covers a fresh database, an upgrade with negative or tied priorities, and restoration after a missing Direct row. If Direct already exists, `ensureDirectChannel` never overwrites its enabled state, presets, matcher, or priority.

Channel create/rename rejects the reserved `Direct` name. Delete, policy, and pool mutations reject Direct server-side even if a custom client bypasses the UI.

## 7. mihomo generation and runtime

Rule generation walks enabled non-default channels in priority order. Each channel supplies a target:

- proxy channel → its generated `ch-<id>` group;
- Direct → the literal `DIRECT` target.

At Direct's position, the generator emits the enabled local-domain rules listed in §5, then the enabled private-network CIDRs as `IP-CIDR`/`IP-CIDR6`, then its custom matcher rules. CIDR rules omit `no-resolve` so domains resolving to private addresses can match. First match wins across channels. The existing speed-test probe rule remains first, and Default's terminal `MATCH` remains last.

Direct creates no proxy group and contributes no proxies to `PROXY`. The channel controller registry filters to `target: "proxy"`, so Direct cannot be probed, selected, or shown as an active node.

Rule-providers referenced by Direct retain the existing `proxy: DIRECT` download behavior and emit `RULE-SET,<provider>,DIRECT`. Custom GEOSITE/GEOIP matchers retain the existing conditional geodata configuration. Built-in Direct presets alone never trigger geodata downloads.

When no exit proxies exist, the existing engine-safety fallback remains `MATCH,DIRECT`; Direct settings do not add redundant rules to that minimal configuration. This fallback is independent of the Direct channel's enabled state because there is no proxy target available.

## 8. API and UI

Channel list responses expose the discriminated target. Creation continues to create only proxy channels; no public “create Direct” input exists.

Existing proxy-channel mutations become proxy-only. Direct uses one atomic `channels.updateDirect` mutation:

```ts
type UpdateDirectInput = {
  enabled?: boolean;
  matcher?: ChannelMatcherInput;
  directPresets?: DirectPresetSettings;
};
```

The input must contain at least one field and the mutation returns the updated `DirectChannel`. The complete input is validated before any database write; allowed and forbidden fields cannot be mixed because rename, policy, pool, id, and delete fields are not part of this schema. The mutation writes one transaction and regenerates the config only after commit. Reorder remains a separate common operation. Proxy rename/create normalizes with `trim` and rejects the reserved name before any write.

The Routing screen renders Direct in the ordered list:

- it has the normal drag handle, enabled switch, matcher summary, and expand control;
- it is labelled as system-owned and `DIRECT`;
- its expanded editor shows the two built-in preset switches and every matcher editor, including CIDR;
- it has no name editor, pool picker, policy editor, active-node status, or delete action;
- disabling it visibly dims the card while preserving its configuration;
- mobile and tablet layouts follow the existing adaptive card and contextual-action system.

The matcher summary counts enabled system presets and custom matcher values consistently with the existing dynamic `+N` behavior.

## 9. Error handling

- Invalid CIDRs are rejected at the shared write boundary before config generation.
- Structurally corrupt custom matcher JSON falls back to an empty custom matcher without disabling valid system presets; invalid tolerant-read CIDR entries are skipped during generation.
- Corrupt Direct preset JSON falls back to both safety presets enabled.
- Forbidden Direct mutations and empty `updateDirect` inputs return a typed client-visible error and do not change the database or regenerate mihomo config.
- Config reload failure keeps the previous running configuration and uses the existing error/toast path.

## 10. Verification

### Shared and server

- discriminated channel schemas and strict CIDR validation;
- migration on empty, populated, conflicting-name, and already-migrated databases, proving every `channel_pool` row survives the table rebuild;
- deterministic Direct-first priority repair with negative and tied legacy priorities;
- singleton, reserved-name, deletion, policy, and pool invariants;
- reorder with Direct first, middle, last-before-Default, and disabled;
- exact rules for both system presets and every custom matcher family;
- IPv4 versus IPv6 rule selection, omission of `no-resolve`, and a hostname resolved to a private address;
- no Direct proxy group/controller and no built-in-triggered geodata;
- disabled and empty Direct behavior.

### Web and browser

- Direct card labels, switches, matcher editors, and absence of proxy-only controls;
- drag ordering, disable/re-enable state preservation, CIDR validation, and matcher summary;
- no delete/rename/policy/pool paths for Direct and atomic rejection of invalid mutation shapes;
- responsive checks at 390 px, the sm/md boundaries, and 1440×1024 dark;
- horizontal-overflow and contextual-action safety checks.

All slices pass raw Biome, design-token check, typecheck, unit/integration tests, production builds, and Playwright. Each slice receives an independent incremental review; the completed feature receives the full final review required by `AGENTS.md` before any push.

## 11. Delivery slices

1. Shared union, CIDR matcher, database migration, and Direct invariants.
2. Config generation and controller exclusion.
3. Approved Routing desktop/mobile frames in `pencil/web-ui.pen`, then the matching UI and responsive browser coverage.
4. Full integration verification and final review.

No unrelated channel, Docker, workflow, or design-token refactoring belongs in these slices.
