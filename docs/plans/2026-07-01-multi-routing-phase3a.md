# Multi-Channel Routing — Phase 3a (mechanics) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Depends on:** Phases 1 & 2 — now **merged to `master`** (through `9ee9075`). Build this on a branch off current `master` (e.g. `feat/multi-routing`), NOT the stale `feat/channel-routing`. Assumes the `channels` table, the `ChannelPolicy` union, the `ChannelController`, `buildConfig`, and `applyConfig`.
>
> **⚠️ Reconciliation with master (background prober).** Since this plan was drafted, a *rolling background prober* landed on master (`live/prober.ts`): it retired `LiveHub.probeActive`, made `pollInterval` internal (`PULSE_MS`), and `singleton.ts`'s `afterView` now runs **`channelController.tick(view)` then `prober.tick()`**. Consequences for this plan:
> - `LiveHub.afterView` still exists — the registry keeps using it. **Preserve the `prober.tick()` call**: the new wiring is `afterView: async (view) => { await registry.runOnce(); await prober.tick(); }` (registry replaces the single controller.tick; the prober stays).
> - `instance.ts` on master binds the controller with `probe: testDelay` (from `nodes/service.ts`) and `select: selectProxy`. The registry reuses `testDelay`/`selectProxy`/`getProxies` — do NOT reintroduce an inline `getDelay` wrapper.
> - `pollInterval` is internal now — ignore any stray `pollInterval`-setting references below.
> - `toNodeView` is now `toNodeView(raw, meta?)`; the controller only needs group `.now` + member delays, so `toGroupView` stays minimal (no meta overlay).
> - Tasks 1–6 (shared schemas, `channel_pool`, resolver, `buildMultiConfig`, `applyConfig`, controller `group`) are unaffected by the prober and stand as written. Only Tasks 7–8 (live wiring) carry the deltas above.

**Goal:** Route different domains through different node pools by generalizing the single-Default-channel model to **N channels**, each with `{matcher, pool, policy}` — proven end-to-end (domain → channel group → its pool) via tests + the tRPC API. **No routing UI and no domain presets in this slice** (those are Phase 3b).

**Architecture:** A `channel_pool` table maps channels to sources/nodes; a resolver turns a channel into its proxy set. A new multi-channel config generator emits one mihomo group per channel (Default stays `AUTO`; others get stable names), with globally-unique proxy definitions shared across channels, per-channel same-name collapse, and priority-ordered `rules:` (domain → channel group, `MATCH` → Default last). The `ChannelController` is generalized to pin into an arbitrary group, and a registry ticks one controller per channel each poll from mihomo's full `/proxies`.

**Tech Stack:** Node 24, strict TS (ESM `.js` specifiers), tRPC v11, Drizzle + better-sqlite3, Zod 4, Vitest. Biome.

## Global Constraints

- English code/comments/commits; Russian UI (n/a this slice — no UI). Zod at boundaries; mihomo responses `.parse()`d in `clients/*`.
- Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Behaviour-preserving for the Default-only case:** with exactly one channel (the Default, empty matcher, all-nodes pool), `applyConfig`'s generated config must be **byte-identical** to today's output. This is the safety invariant gating the config-gen rework.
- mihomo requires **globally-unique** proxy AND proxy-group names. Any generated group/subgroup name must be unique across all channels.
- Controller stays best-effort (a throwing tick must not break the poll).
- Self-verify before each commit: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` (raw biome).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Design Notes (read before Task 4 & 6)

**Group naming.** The Default channel's group stays `AUTO` (preserves Phase 1/2 output + the web card). Non-default channels get `ch-<id>` where `<id>` is the channel's short id (already URL-safe; validate). Collapsed same-name subgroups are named `<groupName>::<base>` (or a deterministic unique suffix) so two channels collapsing a same-named node don't collide.

**Proxy sharing.** A node (same `server:port`) that appears in multiple channels' pools is defined **once** in `proxies:` with one global name; each channel's group references that name. Dedupe by `server:port` across the union of all pools; `dedupeNames` gives each the final unique name; build a `Map<"server:port", finalName>` so each channel resolves its pool members to the shared names.

**Per-channel collapse.** Same-name / distinct-endpoint collapse (the existing `groupProxies`) runs **per channel pool**, not globally — channel A must route only through its own endpoints, never B's. So each channel independently produces its top-level entries (singles → shared proxy names; collapsed → a channel-scoped url-test subgroup referencing the shared member names).

**Rules.** Emit in channel-priority order (ascending `priority`, Default always last). For each non-default channel with matcher domains: one rule per domain, `DOMAIN-SUFFIX,<domain>,<groupName>` (keyword/other rule types are Phase 3b). Terminate with `MATCH,<defaultGroupName>` (or `MATCH,DIRECT` when no proxies exist). Presets expand to domains in Phase 3b; in 3a only `matcher.domains` is used.

**Controller per channel.** `ControllerDeps` gains `group: string`; `apply()` pins into `deps.group` (not the `AUTO` const). Each tick reads a **channel-scoped** view: that group's `.now` + its member `NodeItem`s (built from mihomo `/proxies` via a new `toGroupView(proxies, group)`). A registry holds one `ChannelController` per channel id, created lazily, ticked each poll.

---

## File Structure

**Create:**
- `packages/server/drizzle/0003_channel_pool.sql` — migration (generated).
- `packages/server/src/modules/channels/pool.ts` — `resolveChannelProxies`, `groupNameFor`, pool get/set.
- `packages/server/src/modules/channels/pool.test.ts`
- `packages/server/src/modules/channels/registry.ts` — the multi-channel controller registry + per-poll runner.
- `packages/server/src/modules/channels/registry.test.ts`
- `packages/server/src/modules/nodes/multiConfig.ts` — `buildMultiConfig(channels, secret)`.
- `packages/server/src/modules/nodes/multiConfig.test.ts`

**Modify:**
- `packages/shared/src/schemas.ts` — channel CRUD + pool + list schemas.
- `packages/server/src/db/schema.ts` — `channel_pool` table.
- `packages/server/src/modules/channels/service.ts` — channel CRUD (create/list/update/delete/reorder), `readChannel(db,id)`.
- `packages/server/src/modules/channels/controller.ts` — `group` in deps; `apply`/`tick` generalized; `toGroupView`.
- `packages/server/src/modules/channels/controller.test.ts` — pass `group` in the harness.
- `packages/server/src/modules/channels/instance.ts` — export the registry-backed runner instead of a single controller.
- `packages/server/src/modules/channels/router.ts` — channels CRUD + pool endpoints; `setPolicy` for any id; recentDecisions across channels.
- `packages/server/src/modules/nodes/service.ts` — `applyConfig` gathers all channels + resolved pools → `buildMultiConfig`.
- `packages/server/src/live/singleton.ts` — `afterView` runs the registry runner.

**Out of scope (Phase 3b):** the "Маршрутизация" web screen, domain presets (YouTube/TG/Discord/Torrent), rule-providers, keyword/geo rule types.

---

### Task 1: Shared — channel CRUD + pool schemas

**Files:** Modify `packages/shared/src/schemas.ts`; Test `packages/shared/src/schemas.test.ts`.

**Interfaces — Produces:**
- `channelPoolMemberSchema` = `{ kind: 'source' | 'node', ref: string }`; `ChannelPoolMember`.
- `createChannelInput` = `{ name: string(min1), policy: channelPolicySchema, matcher?: channelMatcherSchema }`.
- `updateChannelInput` = `{ id: string(min1), name?: string(min1), enabled?: boolean, matcher?: channelMatcherSchema }`.
- `deleteChannelInput` = `{ id: string(min1) }`.
- `reorderChannelsInput` = `{ ids: string[] }` (new priority order; Default forced last server-side).
- `setChannelPoolInput` = `{ id: string(min1), members: channelPoolMemberSchema.array() }`.
- `channelWithPoolSchema` = `channelSchema.extend({ pool: channelPoolMemberSchema.array() })`; `ChannelWithPool`.

- [ ] **Step 1: Failing tests** — append parse/reject cases to `schemas.test.ts` (valid create/update/pool; reject empty `name`, reject unknown `kind` in a pool member).
- [ ] **Step 2:** run `pnpm -F @submerge/shared test` → FAIL (symbols missing).
- [ ] **Step 3: Implement** the schemas above in `schemas.ts` (Zod 4 idioms; reuse existing `channelPolicySchema`/`channelMatcherSchema`/`channelSchema`).
- [ ] **Step 4:** `pnpm -F @submerge/shared test` → PASS.
- [ ] **Step 5: Commit** `feat(shared): channel CRUD + pool schemas`.

---

### Task 2: `channel_pool` table + migration

**Files:** Modify `packages/server/src/db/schema.ts`; Create `packages/server/drizzle/0003_*.sql`; Test `packages/server/src/db/client.test.ts`.

**Interfaces — Produces:** table `channel_pool` `{ channel_id text notNull (fk channels.id), kind text notNull, ref text notNull }` with an index on `channel_id`. Composite uniqueness on `(channel_id, kind, ref)` to prevent dup members.

- [ ] **Step 1:** add the `channelPool` Drizzle table to `schema.ts` (camelCase fields, snake_case columns; `channelId`, `kind`, `ref`; a `unique().on(channelId, kind, ref)`; index on channelId). Reference `channels.id` as FK.
- [ ] **Step 2:** `pnpm -F @submerge/server db:generate` → new `drizzle/0003_*.sql`; verify it `CREATE TABLE channel_pool` with the FK + unique index.
- [ ] **Step 3:** extend `client.test.ts` with a case that migrates an in-memory db and selects from `channelPool` without throwing.
- [ ] **Step 4:** `pnpm -F @submerge/server test src/db/client.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(server): channel_pool table + migration`.

---

### Task 3: Channel CRUD service + pool resolver

**Files:** Modify `packages/server/src/modules/channels/service.ts`; Create `packages/server/src/modules/channels/pool.ts` + `pool.test.ts`.

**Interfaces:**
- Consumes: `channels`, `channelPool` tables; `sources` (has `.proxies: ProxyConfig[]`, `.enabled`); `createChannelInput`/`updateChannelInput` types.
- Produces (service.ts):
  - `listChannels(db): Channel[]` — ordered by `priority asc, id asc`.
  - `readChannel(db, id): Channel | undefined` (validated; safeParse fallback like `readDefaultChannel`).
  - `createChannel(db, input): Channel` — generates a short id (deterministic; NOT `Date.now`/random — derive from a monotone counter: `max(priority)+1` and an id like `ch<n>`), `isDefault:false`, appended after existing non-default channels but before Default's terminal priority.
  - `updateChannel(db, id, patch): void`; `deleteChannel(db, id): void` (refuse when `isDefault`; also delete its pool rows); `reorderChannels(db, ids): void` (assign priorities in order; Default forced to the highest priority so it stays the catch-all).
- Produces (pool.ts):
  - `groupNameFor(channel): string` — `channel.isDefault ? "AUTO" : \`ch-${channel.id}\``.
  - `getPool(db, channelId): ChannelPoolMember[]`; `setPool(db, channelId, members): void` (replace-all in a txn; dedupe).
  - `resolveChannelProxies(db, channel, allProxies): ProxyConfig[]` — if the channel's pool is empty → return `allProxies` (all-nodes, like Default today); else union: for each `source` member, that source's `.proxies`; for each `node` member, the proxy(ies) in `allProxies` whose `name === ref` (best-effort). De-dupe by `server:port`, preserve first-seen order.

- [ ] **Step 1: Failing tests** (`pool.test.ts`): `groupNameFor` (default→AUTO, other→ch-<id>); `resolveChannelProxies` empty-pool→all, source-member→that source's proxies, node-member→matching proxy, missing node ref→skipped, dedupe by server:port. Add service CRUD tests (create appends with priority, delete refuses default + removes pool, reorder assigns priorities + Default last).
- [ ] **Step 2:** run the two test files → FAIL.
- [ ] **Step 3: Implement** `service.ts` CRUD + `pool.ts`. Use a Drizzle transaction for `setPool` replace-all and for `deleteChannel` (rows + pool).
- [ ] **Step 4:** `pnpm -F @submerge/server test src/modules/channels/` → PASS.
- [ ] **Step 5: Commit** `feat(server): channel CRUD + pool resolver`.

---

### Task 4: `buildMultiConfig` — the multi-channel generator (CRUX)

**Files:** Create `packages/server/src/modules/nodes/multiConfig.ts` + `multiConfig.test.ts`. Reuse `groupProxies`/`dedupeNames` from `config.ts` (export them if not already).

**Interfaces — Produces:**
```ts
export interface ChannelConfigInput {
  id: string;
  groupName: string;      // from groupNameFor
  isDefault: boolean;
  policy: ChannelPolicy;
  domains: string[];      // matcher.domains (presets expanded in 3b)
  proxies: ProxyConfig[]; // resolved pool
}
export function buildMultiConfig(channels: ChannelConfigInput[], secret?: string): string;
```
Algorithm (per Design Notes): global unique proxy set (dedupe by `server:port` across all pools → `dedupeNames` → `proxies:` + a `server:port → finalName` map); per channel, run `groupProxies` on ITS pool mapped to shared names → the channel's top-level member list + channel-scoped collapsed subgroups (`<groupName>::<base>`, uniqueness-guarded); per channel, one proxy-group (`speed`→url-test, else `select`); a top-level `PROXY` select listing all channel groups + `DIRECT`; `rules:` = per non-default channel (priority order) `DOMAIN-SUFFIX,<domain>,<groupName>`, then `MATCH,<defaultGroupName>` (or `MATCH,DIRECT` if no proxies).

- [ ] **Step 1: Failing tests** (`multiConfig.test.ts`) — parse the YAML and assert:
  1. **Behaviour-preservation:** a single Default channel (isDefault, empty domains, pool = `[A,B]`) yields the SAME `proxy-groups` (PROXY + AUTO) and `rules: [MATCH,PROXY]`... — assert it matches the existing `buildConfig([A,B], DEFAULT_SPEED_POLICY)` output byte-for-byte (compare `yaml.dump` strings, or deep-equal the parsed objects). *(This is the invariant — write it first.)*
  2. Two channels (`Default` speed pool[A,B]; `media` sticky pool[B,C] domains `["youtube.com"]`): `proxies` contains A,B,C once each (B shared, one definition); groups include `AUTO` (url-test) and `ch-media` (select) with the right members; `rules` = `["DOMAIN-SUFFIX,youtube.com,ch-media","MATCH,AUTO"]`.
  3. Shared same-name collapse stays per-channel: a name collapsed in one channel's pool doesn't pull in the other channel's endpoint.
  4. No proxies anywhere → `rules: [MATCH,DIRECT]`.
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3: Implement** `buildMultiConfig`. Keep the emitted key order identical to `config.ts` for the Default group so test (1) passes. (If matching byte-for-byte proves impractical, make `config.ts`'s `buildConfig` delegate to `buildMultiConfig` for the single-channel case and assert equality that way — decide during impl, document in the report.)
- [ ] **Step 4:** run → PASS (esp. the byte-identity test).
- [ ] **Step 5: Commit** `feat(server): buildMultiConfig multi-channel generator`.

---

### Task 5: `applyConfig` uses all channels + resolved pools

**Files:** Modify `packages/server/src/modules/nodes/service.ts`. Test: full suite green.

**Interfaces:** `applyConfig(db, ...)` now: `const all = collectProxies(db)` (all enabled sources' proxies); `const channels = listChannels(db)`; build `ChannelConfigInput[]` via `groupNameFor` + `resolveChannelProxies(db, ch, all)` + `ch.matcher.domains`; `buildMultiConfig(inputs, readMihomoSecret(db))`; write + reload (unchanged fs/reload logic).

- [ ] **Step 1:** rewrite `applyConfig`'s content assembly to the above (keep the atomic write + `reloadConfig`). Import `listChannels`, `resolveChannelProxies`, `groupNameFor`, `buildMultiConfig`.
- [ ] **Step 2:** `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` → all green. (Existing `config.test.ts` still covers `buildConfig`; the Default-only path must stay behaviour-identical — confirm no snapshot/test breaks.)
- [ ] **Step 3: Commit** `feat(server): applyConfig generates config for all channels`.

---

### Task 6: Generalize `ChannelController` to an arbitrary group

**Files:** Modify `packages/server/src/modules/channels/controller.ts` + `controller.test.ts`.

**Interfaces:**
- `ControllerDeps` gains `group: string`.
- `apply()` uses `this.deps.group` instead of the `AUTO_GROUP` const (delete the const).
- Add `export function toGroupView(proxies: ProxiesResponse["proxies"], group: string): NodeView` — like `toNodeView` but for an arbitrary group name: `{ now: g.now ?? null, autoNow: g.now ?? null, all: g.all.map(→ NodeItem with delay/history) }`. (For the controller, `autoNow` = the group's current selection.)
- `tick`, `tickSticky`, `tickManual` unchanged in logic — they already read `view.autoNow`/`selectableNames(view)`; now the view is the channel's group view.

- [ ] **Step 1:** update `controller.test.ts` — the harness `ControllerDeps` must pass `group: "AUTO"` (or any name); assert `select` is called with that group. Add a test that a non-`AUTO` group name is used in `select`.
- [ ] **Step 2:** run → FAIL (deps type / group not honored).
- [ ] **Step 3: Implement** the `group` dep + `apply` change + `toGroupView`. Keep `PSEUDO`, `selectableNames`, `pickBest` as-is.
- [ ] **Step 4:** `pnpm -F @submerge/server test src/modules/channels/controller.test.ts` → PASS.
- [ ] **Step 5: Commit** `refactor(server): ChannelController pins into a configurable group`.

---

### Task 7: Multi-channel controller registry + per-poll runner

**Files:** Create `packages/server/src/modules/channels/registry.ts` + `registry.test.ts`; Modify `instance.ts`.

**Interfaces — Produces (`registry.ts`):**
```ts
export class ControllerRegistry {
  constructor(deps: {
    listChannels: () => Channel[];
    fetchProxies: () => Promise<ProxiesResponse>;
    probe: (name, url) => Promise<number|null>;
    select: (group, name) => Promise<void>;
    persistReason: (channelId, reason, at) => void;
    now: () => number;
  });
  async runOnce(): Promise<void>;               // tick every channel this poll
  recent(): DecisionEntry[];                      // merged, newest-first, across channels
  reset(channelId: string): void;                 // drop one channel's transient state
}
```
`runOnce`: `const chs = listChannels()`; `const px = (await fetchProxies()).proxies`; for each channel: get-or-create a `ChannelController` keyed by id (deps bound to that channel: `readChannel: () => ch`, `group: groupNameFor(ch)`, `persistReason: (r,a)=>persistReason(ch.id,r,a)`); build `toGroupView(px, groupNameFor(ch))`; `await ctrl.tick(view)` (best-effort try/catch per channel). Drop controllers for channels that no longer exist.

- [ ] **Step 1: Failing tests** (`registry.test.ts`) with fake deps: two channels → each gets ticked with its own group view; a sticky channel pins into its own group (assert `select` called with `ch-<id>`); `recent()` merges decisions; removing a channel drops its controller; a throwing channel tick doesn't stop the others.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `ControllerRegistry`. Then rewrite `instance.ts` to export a `registry` wired to the real db + mihomo client (`fetchProxies: getProxies`, `probe: testDelay` (reuse the master helper — NOT an inline getDelay wrapper), `select: selectProxy`, `persistReason: setChannelLastReason(db, channelId, …)`, `now: Date.now`). The old single `channelController` export is removed; update its importers (`singleton.ts`, `channels/router.ts`) to the registry.
- [ ] **Step 4:** `pnpm -F @submerge/server test src/modules/channels/registry.test.ts` + full suite → PASS.
- [ ] **Step 5: Commit** `feat(server): multi-channel controller registry`.

---

### Task 8: Wire the runner + channels CRUD/pool tRPC

**Files:** Modify `packages/server/src/live/singleton.ts`, `packages/server/src/modules/channels/router.ts`. Test: full suite + typecheck.

**Interfaces:**
- `singleton.ts`: change `afterView` from the single-controller form to `afterView: async (view) => { await registry.runOnce(); await prober.tick(); }` — the registry replaces `channelController.tick(view)`, and **`prober.tick()` MUST be preserved** (it's the rolling background prober). The runner fetches `/proxies` itself, so it ignores the `view` arg. Keep it best-effort (the hub already swallows afterView throws).
- `router.ts` — `channelsRouter`:
  - `list: query → listChannels(db)` (with pool? add `listChannelsWithPool` or a separate `pool.get`).
  - `get(default)` retained; `create`/`update`/`delete`/`reorder` mutations (each → persist + `applyConfig(db)`).
  - `setPolicy(id)` generalized (already takes id) → persist + `registry.reset(id)` + `applyConfig`.
  - `pool.get(id)` / `pool.set(id)` → `applyConfig`.
  - `recentDecisions: query → registry.recent()`.

- [ ] **Step 1:** implement the singleton wiring + router endpoints (each mutation that changes routing calls `applyConfig(db)`; `setPolicy`/pool changes also `registry.reset(id)` where a policy/pool change should re-baseline).
- [ ] **Step 2:** `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` → green. Update `trpc/router.test.ts` if it asserts the channel router shape.
- [ ] **Step 3: Commit** `feat(server): wire multi-channel runner + channels CRUD/pool API`.

---

### Task 9: Verification sweep (tests + live routing proof)

**Files:** none (verification).

- [ ] **Step 1: Full gate** — `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` green.
- [ ] **Step 2: Behaviour-preservation** — with only the Default channel, dump the generated config and confirm it equals the pre-Phase-3a output (AUTO group + `MATCH,PROXY`).
- [ ] **Step 3: Live routing proof** (against a running mihomo, per the dev instance): via the tRPC API, create a channel `media` (policy sticky, pool = one source or node, domains `["youtube.com"]`); confirm the regenerated `mihomo/config.yaml` has a `ch-media` group with the pool's members and `rules` contains `DOMAIN-SUFFIX,youtube.com,ch-media` above `MATCH,AUTO`; confirm the registry pins a node into `ch-media` (mihomo `ch-media.now` set). Delete the channel; confirm config reverts to Default-only.
- [ ] **Step 4: Risky states** — channel with empty pool (falls back to all nodes); channel whose only node ref disappeared after a source refresh (skipped, no crash); reorder puts Default last; deleting Default is refused.
- [ ] **Step 5: Incremental review** — review the whole Phase-3a diff against the spec §3/§4/§8 and these Design Notes; run `/code-review`; resolve findings.

---

## Self-Review

**Spec coverage (§ of `docs/specs/2026-07-01-channel-routing-design.md`):** §3 channels list → Tasks 1,3,8. §4 `channel_pool` + durability (source durable / node best-effort) → Tasks 2,3. §8 config gen (per-channel groups + rules, Default catch-all) → Task 4,5. §6 controller per channel → Tasks 6,7,8. Deferred (documented): §9 routing UI + matcher presets (Phase 3b), rule-providers/bandwidth (Phase 4).

**Placeholder scan:** the algorithmic tasks (4,6,7) are specified via interfaces + concrete test cases rather than full literal code — deliberate for a design-heavy rework driven by TDD; each names its exact test assertions. Mechanical tasks (1,2,3,5,8) carry exact shapes.

**Type consistency:** `groupNameFor`, `resolveChannelProxies`, `ChannelConfigInput`, `buildMultiConfig`, `toGroupView`, `ControllerRegistry`, `ControllerDeps.group` are referenced identically across tasks 3→8. `channel_pool` columns (`channelId/kind/ref`) match the `channelPoolMemberSchema` (`kind/ref`). Default group name `"AUTO"` is preserved end-to-end (config gen + controller + web card from Phase 2).
