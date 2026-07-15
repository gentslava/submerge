# System Direct Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Add one system-managed, configurable, reorderable `Direct` channel that routes every supported matcher family to mihomo's native `DIRECT` target without creating a fake proxy group, pool, policy, or controller.

**Architecture:** Land two compiler-safe foundations first: general CIDR routing, then explicit proxy-target persistence. After the approved Pencil states are updated, switch the shared channel contract to a strict `proxy | direct` union and implement Direct across server/runtime/web as one complete vertical slice so no commit contains a half-migrated or type-broken application. Config generation separates proxy construction from ordered rule targets; the UI reuses the card shell but uses a Direct-only editor.

**Tech Stack:** TypeScript 6, Zod 4, Drizzle ORM + SQLite, tRPC v11, React 19, TanStack Query, Tailwind v4, Vitest, Playwright, Pencil JSON mockup, Biome.

**Source specification:** [`docs/specs/2026-07-13-direct-channel-design.md`](../specs/2026-07-13-direct-channel-design.md)

**Commit rule:** Tasks 1–4 are the only implementation slices. Each slice must pass the exact repository gate `pnpm verify:static`, receive an independent incremental `/code-review`, and be committed before the next slice. Task 4 is intentionally cross-package: changing `Channel` to a union cannot be split into green shared/server/web commits.

---

## Task 1: Ship general CIDR matchers end-to-end

**Files:**

- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/defaults.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `packages/server/src/modules/channels/service.test.ts`
- Modify: `packages/server/src/modules/nodes/multiConfig.ts`
- Modify: `packages/server/src/modules/nodes/multiConfig.test.ts`
- Modify: `packages/server/src/modules/nodes/service.ts`
- Modify: `packages/web/src/features/channels/matcher-summary.ts`
- Modify: `packages/web/src/features/channels/matcher-summary.test.ts`
- Modify: `packages/web/src/features/channels/ChannelCard.test.tsx`
- Modify: `packages/web/e2e/fixtures.ts`
- Modify: `packages/web/e2e/routing-layout.spec.ts`

### 1. Write failing shared and generator tests

Add tests proving:

- tolerant matcher reads default `cidrs` to `[]` and retain malformed legacy strings;
- strict matcher inputs trim and accept valid IPv4/IPv6 CIDRs;
- strict inputs reject bare addresses, invalid prefixes, commas, newlines, and blank values;
- `isValidCidr(value)` and `cidrVersion(value): 4 | 6 | null` share the same validation;
- proxy-channel generation emits valid `IP-CIDR`/`IP-CIDR6` rules at that channel's priority without `no-resolve`;
- invalid CIDRs from the tolerant read model are skipped defensively;
- matcher summaries count/render CIDRs.

Run:

```bash
pnpm -F @submerge/shared test -- schemas.test.ts
pnpm -F @submerge/server test -- src/modules/nodes/multiConfig.test.ts
pnpm -F @submerge/web test -- matcher-summary.test.ts
```

Expected: FAIL because `cidrs` and CIDR rule generation do not exist.

### 2. Implement the single CIDR contract

In shared schemas:

- add tolerant `cidrs: z.array(z.string()).default([])` to `channelMatcherSchema`;
- add a trimmed strict input piped through `z.union([z.cidrv4(), z.cidrv6()])`;
- export `isValidCidr` and `cidrVersion`;
- return `cidrs: []` from `emptyChannelMatcher()`.

In the server generator, add `cidrs` to the existing proxy-channel input and rule builder. Emit by validated family and skip invalid tolerant-read values. Pass persisted CIDRs from `nodes/service.ts`.

In matcher summary, represent CIDRs as monospace items. Update every compiler-required matcher fixture in the listed tests/fixtures to include `cidrs: []`; do not change UI layout in this slice.

### 3. Verify, review, and commit the CIDR slice

Run:

```bash
pnpm verify:static
pnpm -F @submerge/web test:e2e -- routing-layout.spec.ts
```

Invoke `/code-review` on only Task 1. Resolve findings and rerun both commands.

Commit:

```bash
git add packages/shared/src/schemas.ts packages/shared/src/defaults.ts packages/shared/src/schemas.test.ts packages/server/src/modules/channels/service.test.ts packages/server/src/modules/nodes/multiConfig.ts packages/server/src/modules/nodes/multiConfig.test.ts packages/server/src/modules/nodes/service.ts packages/web/src/features/channels/matcher-summary.ts packages/web/src/features/channels/matcher-summary.test.ts packages/web/src/features/channels/ChannelCard.test.tsx packages/web/e2e/fixtures.ts packages/web/e2e/routing-layout.spec.ts
git commit -m "feat(routing): support CIDR matchers" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Make proxy target explicit and migrate storage safely

**Files:**

- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `packages/server/src/db/schema.ts`
- Create: `packages/server/drizzle/0007_system_direct_channel.sql`
- Modify: `packages/server/drizzle/meta/_journal.json`
- Create/Modify: `packages/server/drizzle/meta/0007_snapshot.json`
- Modify: `packages/server/src/db/client.test.ts`
- Modify: `packages/server/src/modules/channels/service.ts`
- Modify: `packages/server/src/modules/channels/service.test.ts`
- Modify: `packages/server/src/modules/channels/pool.ts`
- Modify: `packages/server/src/modules/channels/pool.test.ts`
- Modify: `packages/server/src/modules/channels/controller.ts`
- Modify: `packages/server/src/modules/channels/controller.test.ts`
- Modify: `packages/server/src/modules/channels/registry.test.ts`
- Modify: `packages/web/src/features/channels/pool.ts`
- Modify: `packages/web/src/features/channels/ChannelCard.test.tsx`
- Modify: `packages/web/src/features/channels/pool.test.ts`
- Modify: `packages/web/e2e/fixtures.ts`
- Modify: `packages/web/e2e/routing-layout.spec.ts`

This compatibility slice still exposes only proxy channels. It prepares the real storage shape without making `Channel` a union yet, so every consumer remains type-safe and the commit is deployable.

### 1. Write failing proxy-target and upgrade tests

In shared tests, require the current channel shape to contain literal `target: "proxy"`. Export it as `proxyChannelSchema`/`ProxyChannel`, while keeping `channelSchema = proxyChannelSchema` and `Channel = ProxyChannel` in this slice. Also export the strict, exact `directPresetSettingsSchema` and inferred `DirectPresetSettings` type for the nullable DB column; defining preset storage does not expose a Direct channel yet.

In `client.test.ts`, create a temporary pre-Direct migration folder containing `0000`–`0006` plus a journal truncated to those entries. Migrate an in-memory DB to that real legacy state, seed Default/two channels with negative or tied priorities and multiple pool rows, then point the same Drizzle migrator at the complete tracked folder so it applies `0007` exactly as production does. Assert:

- all rows become `target = 'proxy'` with policy/matcher/reason/order unchanged;
- all pool rows survive;
- proxy rows reject `policy = NULL`;
- Direct-shaped rows reject policy/default/preset violations;
- the partial unique index rejects a second direct target;
- `PRAGMA foreign_key_check` is empty;
- `PRAGMA foreign_key_list(channel_pool)` references final `channels`;
- deleting a channel still cascades its pool rows.

Keep the existing clean full-migration-chain test as a separate assertion. Do not substitute `$client.exec(migrationSql)` for the staged migrator test: it would not exercise Drizzle's statement-breakpoint execution.

Run focused tests and confirm they fail before implementation.

### 2. Define the final DB schema and generate correct Drizzle metadata

Add to `channels`:

- non-null `target: "proxy" | "direct"` defaulting to `"proxy"`;
- nullable JSON `policy`;
- nullable JSON `directPresets`;
- target/policy/default/preset checks;
- partial unique index for `target = 'direct'`.

Edit `schema.ts` first, then generate a **normal**, not custom, migration:

```bash
pnpm -F @submerge/server db:generate -- --name system_direct_channel
```

Audit/replace its SQL with the required child-safe SQLite rebuild while retaining the generated current-schema snapshot. Put `--> statement-breakpoint` between every DDL/DML chunk because the production migrator executes those chunks individually:

1. create `__new_channels` and copy legacy rows as proxy targets;
2. create `__new_channel_pool` referencing the replacement parent and copy all pool rows;
3. drop old child before old parent;
4. rename parent/child replacements;
5. recreate pool indexes and the Direct partial unique index.

The migration must not insert Direct or reorder rows.

Run the same `db:generate` command again and assert it reports no schema changes and creates no new migration artifact.

### 3. Project proxy API rows explicitly

Change the shared proxy schema to strict `target: z.literal("proxy")`. Keep `lastReason`/`lastReasonAt` and policy on `ProxyChannel`.

In `rowToChannel`, construct an explicit proxy API object instead of spreading the DB row with nullable Direct-only columns. Preserve safe policy/matcher fallback behavior. Ensure Default creation writes `target: "proxy"`.

Narrow controller dependencies and pool/group helpers (including web `channelGroupNames`) to `ProxyChannel`. Add `target: "proxy"` to the exact compiler-reported typed fixtures in the listed server/web files; do not add target branches to production web components yet because `Channel` is still proxy-only.

### 4. Verify, review, and commit the storage slice

Run:

```bash
pnpm verify:static
pnpm -F @submerge/server test -- src/db/client.test.ts src/modules/channels/service.test.ts src/modules/channels/pool.test.ts
```

Invoke `/code-review` on Task 2 with explicit migration/FK/data-preservation focus. Resolve findings and rerun.

Commit:

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts packages/server/src/db/schema.ts packages/server/src/db/client.test.ts packages/server/drizzle/0007_system_direct_channel.sql packages/server/drizzle/meta/_journal.json packages/server/drizzle/meta/0007_snapshot.json packages/server/src/modules/channels/service.ts packages/server/src/modules/channels/service.test.ts packages/server/src/modules/channels/pool.ts packages/server/src/modules/channels/pool.test.ts packages/server/src/modules/channels/controller.ts packages/server/src/modules/channels/controller.test.ts packages/server/src/modules/channels/registry.test.ts packages/web/src/features/channels/pool.ts packages/web/src/features/channels/ChannelCard.test.tsx packages/web/src/features/channels/pool.test.ts packages/web/e2e/fixtures.ts packages/web/e2e/routing-layout.spec.ts
git commit -m "refactor(channels): make proxy targets explicit" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Approve Direct states in Pencil before UI code

**Files:**

- Modify: `pencil/web-ui.pen`
- Modify: `docs/design-system.md`

### 1. Update the visual source of truth

Using only existing mockup variables/components, add Direct states to:

- dark populated desktop frame `lYrng`;
- light populated desktop frame `CUEoq`;
- states/mobile frame `HXRTv`.

The approved frames must show system/DIRECT labels, reorder control, enabled/disabled switch, matcher summary, expand control, both system preset switches, all custom matcher editors including CIDR, disabled dimming, and absence of name/pool/policy/active/delete controls. The 390 px state must contain complete chips/controls with no horizontal overflow. Add no new tokens.

Update Routing's frame contract in `docs/design-system.md`.

### 2. Validate, review, and commit the Pencil slice

Run:

```bash
jq empty pencil/web-ui.pen
pnpm verify:static
```

Inspect dark, light, expanded, disabled, and 390 px states independently. Invoke `/code-review` on Task 3 and resolve findings.

Commit:

```bash
git add pencil/web-ui.pen docs/design-system.md
git commit -m "design: specify Direct routing channel states" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Implement Direct as one complete shared/server/web slice

**Files:**

- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `packages/server/src/modules/channels/service.ts`
- Modify: `packages/server/src/modules/channels/service.test.ts`
- Modify: `packages/server/src/modules/channels/pool.ts`
- Modify: `packages/server/src/modules/channels/pool.test.ts`
- Modify: `packages/server/src/modules/channels/router.ts`
- Modify: `packages/server/src/modules/channels/router.test.ts`
- Modify: `packages/server/src/modules/channels/registry.ts`
- Modify: `packages/server/src/modules/channels/registry.test.ts`
- Modify: `packages/server/src/modules/nodes/multiConfig.ts`
- Modify: `packages/server/src/modules/nodes/multiConfig.test.ts`
- Modify: `packages/server/src/modules/nodes/service.ts`
- Modify: `packages/server/src/modules/nodes/service.test.ts`
- Modify: `packages/server/src/index.ts`
- Create: `packages/web/src/features/channels/CidrTags.tsx`
- Create: `packages/web/src/features/channels/CidrTags.test.tsx`
- Create: `packages/web/src/features/channels/DirectChannelEditor.tsx`
- Create: `packages/web/src/features/channels/DirectChannelEditor.test.tsx`
- Modify: `packages/web/src/features/channels/ChannelCard.tsx`
- Modify: `packages/web/src/features/channels/ChannelCard.test.tsx`
- Modify: `packages/web/src/features/channels/matcher-summary.ts`
- Modify: `packages/web/src/features/channels/matcher-summary.test.ts`
- Modify: `packages/web/src/features/channels/RoutingScreen.tsx`
- Modify: `packages/web/src/features/channels/PoolPicker.tsx`
- Modify: `packages/web/e2e/fixtures.ts`
- Modify: `packages/web/e2e/routing-layout.spec.ts`

This is one vertical slice and one commit. Do not commit after the shared or server substeps: once `Channel` becomes a union, all server and web consumers must narrow before the repository can be green.

### 1. RED — define the strict shared union

Add failing tests for:

- strict `ProxyChannel` and `DirectChannel` variants;
- Direct literal identity `id/name/target/isDefault = direct/Direct/direct/false`;
- `DirectPresetSettings` requiring exactly both booleans;
- Direct rejecting policy/controller fields instead of stripping them;
- `updateDirectInput` being strict, non-empty, and rejecting every proxy-only/unknown field.

Implement:

```ts
const channelBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  matcher: channelMatcherSchema,
});

export const proxyChannelSchema = channelBaseSchema.extend({
  target: z.literal("proxy"),
  isDefault: z.boolean(),
  policy: channelPolicySchema,
  lastReason: z.string().nullable(),
  lastReasonAt: z.number().nullable(),
}).strict();

export const directChannelSchema = channelBaseSchema.extend({
  id: z.literal("direct"),
  name: z.literal("Direct"),
  target: z.literal("direct"),
  isDefault: z.literal(false),
  directPresets: directPresetSettingsSchema,
}).strict();

export const channelSchema = z.discriminatedUnion("target", [
  proxyChannelSchema,
  directChannelSchema,
]);
```

Export `Channel`, `ProxyChannel`, `DirectChannel`, `DirectPresetSettings`, `updateDirectInput`, and inferred `UpdateDirectInput`. Narrow `channelGroupName`/pool schemas to `ProxyChannel`.

### 2. RED — enforce lifecycle, singleton, and mutation invariants

Add service/router/pool tests for:

- boot creates Direct at priority `0`, enabled, both presets on, empty matcher;
- idempotency preserves existing Direct enabled/presets/matcher/priority;
- `(priority, id)` capture repacks existing non-default channels `1..N` and Default `N + 1`;
- normalized legacy name conflicts become `Direct (custom)`, `Direct (custom 2)`, etc.;
- a persisted malformed Direct identity or `id = "direct"` proxy row causes a deterministic, explicit boot failure before any insert/update rather than a unique-index crash or silent overwrite;
- corrupt Direct matcher falls back without resetting valid presets, and corrupt presets fall back without resetting a valid matcher;
- proxy create/rename trims and rejects reserved normalized `Direct`;
- update/delete/policy/pool reject Direct with exact tRPC `BAD_REQUEST` codes/messages and do not regenerate config;
- atomic non-empty `updateDirect` returns the updated `DirectChannel` and regenerates only after commit;
- reorder accepts Direct first/middle/last-before-Default and still forces Default terminal.

Implementation requirements:

- `rowToChannel` projects a target-specific object before strict parsing; Direct never exposes DB-only nullable policy/reason fields;
- `ensureDefaultChannel` runs first, then transactional `ensureDirectChannel`;
- `requireProxyChannel` guards all proxy-only service paths;
- `updateDirect` changes only enabled/matcher/presets in one transaction;
- boot imports/calls both ensure functions in authority order.

### 3. RED — generate native ordered Direct rules and exclude runtime state

Add generator/service/registry tests for:

- exact local-domain rule order;
- exact nine private CIDRs as `IP-CIDR`/`IP-CIDR6` without `no-resolve`;
- every custom matcher family targets literal `DIRECT`;
- invalid tolerant-read CIDRs are skipped;
- Direct rules occupy Direct's cross-channel priority;
- disabled Direct is filtered by `nodes/service.ts` before generation;
- enabled empty Direct is a no-op;
- Direct adds no group/new selector member, while the existing single built-in `DIRECT` member in `PROXY` stays unchanged;
- providers/geodata work for Direct, but built-ins alone add no geodata;
- Default + Direct-only preserves terminal `MATCH,PROXY`; only a non-default proxy channel changes it to `MATCH,<default-group>`;
- zero exits remains minimal `MATCH,DIRECT` regardless of Direct enabled state;
- registry never creates/probes/selects/caches Direct.

Split generator input into a discriminated union. Only proxy inputs may enter proxy flattening, group allocation, policy tuning, pool resolution, or controller code. Enabled non-default inputs may enter ordered rule/provider/geodata generation. Determine terminal rule from non-default **proxy** count, not Direct presence.

### 4. RED — implement the target-specific Routing UI

Write component tests proving:

- `CidrTags` reuses shared validation, trims, deduplicates, rejects, and removes;
- Direct collapsed card renders system/DIRECT, preset-aware matcher summary, switch, reorder, expand;
- Direct editor exposes both preset switches and every matcher editor including CIDR;
- Direct has no name, pool, policy, active-node, or delete path;
- proxy/Default behavior is unchanged;
- summary counts active system presets + custom matchers with complete-chip `+N` fitting;
- the empty-user-channel message is truthful: Direct handles configured bypasses and Default handles everything else.

Keep component boundaries narrow:

- `CidrTags` is a thin `TagInput` wrapper;
- `DirectChannelEditor` accepts only `{ channel: DirectChannel; onChange(patch: UpdateDirectInput) }` and imports no pool/policy code;
- `ChannelCard` uses a discriminated prop union pairing `ProxyChannel` with proxy actions and `DirectChannel` with `onUpdateDirect`; no optional callback bag/no-op Direct actions;
- Direct stays in the sortable non-default list; Default stays outside and last;
- `PoolPicker` filters list results to proxy targets before calling the Task 2 `channelGroupNames(ProxyChannel[])` helper.

Add an actual reorder interaction test (mobile arrows or keyboard DnD) that asserts the `channels.reorder` payload includes Direct at the requested position and excludes Default. Fixture-order rendering alone is not sufficient.

### 5. GREEN — verify behavior and visual fidelity

Run focused suites while implementing, then the complete gate:

```bash
pnpm verify:static
pnpm -F @submerge/web test:e2e -- routing-layout.spec.ts
```

Browser evidence must use populated Direct fixtures and cover:

- viewport widths `320`, `390`, `425`, `768`, `1024`, `1440`;
- the exact current Routing container transition on both sides (including the existing 983/984 viewport regression boundary while it remains the measured 42rem content boundary);
- dark 1440×1024 versus Pencil `lYrng`;
- light 1440×1024 versus Pencil `CUEoq`;
- mobile versus `HXRTv`;
- overflow/scroll measurements for `html`, `.app-main`, and `.responsive-page`;
- expanded, disabled, empty, and error states.

Record screenshots/computed evidence in the active implementation notes before review; do not rely only on Playwright's pass result.

**Implementation evidence — 2026-07-13:**

- The Routing Playwright matrix passed at `320`, `390`, `425`, `768`, `983`, `984`, `1024`, and `1440` px with no document, `.app-main`, or `.responsive-page` overflow.
- At 390 px the Direct header measured `flex-direction: column`, `10px` row gap, `12px 14px` padding, with the matcher summary fully below the identity/control row and every visible chip contained. The first chip measured `10px` text with `7px` horizontal and `3px` vertical padding.
- The 390 px editor measured `14px` section padding, `11px` captions, and `10px 12px` preset-card padding.
- At 1440×1024, dark expanded Direct used the approved elevated header color `rgb(22, 25, 34)`; the light collapsed card remained on `rgb(255, 255, 255)`; the disabled dark card remained visible at `0.5` opacity with an unchecked switch.
- Browser evidence was captured outside the repository at `/tmp/submerge-direct-{compact-dark-390,expanded-dark-390,expanded-dark-1440,collapsed-light-1440,disabled-dark-1440}.png`; computed compact/editor evidence was written alongside it as JSON.
- The real local-stack smoke preserved Direct matcher/preset/enabled/priority state across disable, update, reorder, and restart. Generated YAML contained the nine built-in private CIDRs plus custom domain/CIDR rules targeting literal `DIRECT` and no `ch-direct` group. A request to Docker alias `direct-smoke.test` succeeded through the existing mihomo proxy; mihomo logged `match IPCIDR(172.16.0.0/12) using DIRECT`. The temporary alias was removed and the normal development Compose topology restored.

### 6. Verify a real disposable local stack

Use existing project commands/ports only. Start infrastructure normally, then start the server with an isolated database:

```bash
pnpm dev:infra
DB_PATH=.local-run/direct-channel-smoke.db pnpm dev:server
pnpm dev:web
```

Do not change Docker/CI or add helper scripts/ports. Verify create/update/disable/reorder/restart persistence and inspect generated YAML.

For the hostname-to-private-IP requirement, create a temporary untracked Compose override under `/tmp` that gives the existing `happ-decoder` service the Docker-network alias `direct-smoke.test` (deliberately outside the built-in `.local`/`.lan` domain presets). Recreate the dev sidecars with that override, request `http://direct-smoke.test:8080/health` through the existing mihomo proxy, and assert HTTP success plus a mihomo connection/log target of `DIRECT`. Remove the override and recreate `happ-decoder` with the normal `docker-compose.dev.yml` afterward. This uses the existing service/network/internal port and proves hostname resolution reaches a private CIDR rule rather than merely asserting that `no-resolve` is absent.

### 7. Review and commit the complete Direct slice

Invoke `/code-review` on all Task 4 changes with independent shared/API, migration/server, mihomo/runtime, UI/responsive/accessibility, and code-simplification passes. Remove unrelated edits and unnecessary abstractions. Resolve findings, rerun `pnpm verify:static` plus full Routing Playwright.

Commit:

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts packages/server/src/modules/channels/service.ts packages/server/src/modules/channels/service.test.ts packages/server/src/modules/channels/pool.ts packages/server/src/modules/channels/pool.test.ts packages/server/src/modules/channels/router.ts packages/server/src/modules/channels/router.test.ts packages/server/src/modules/channels/registry.ts packages/server/src/modules/channels/registry.test.ts packages/server/src/modules/nodes/multiConfig.ts packages/server/src/modules/nodes/multiConfig.test.ts packages/server/src/modules/nodes/service.ts packages/server/src/modules/nodes/service.test.ts packages/server/src/index.ts packages/web/src/features/channels/CidrTags.tsx packages/web/src/features/channels/CidrTags.test.tsx packages/web/src/features/channels/DirectChannelEditor.tsx packages/web/src/features/channels/DirectChannelEditor.test.tsx packages/web/src/features/channels/ChannelCard.tsx packages/web/src/features/channels/ChannelCard.test.tsx packages/web/src/features/channels/matcher-summary.ts packages/web/src/features/channels/matcher-summary.test.ts packages/web/src/features/channels/RoutingScreen.tsx packages/web/src/features/channels/PoolPicker.tsx packages/web/e2e/fixtures.ts packages/web/e2e/routing-layout.spec.ts
git commit -m "feat: add the system Direct channel" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Final integration review and documentation closure

**Files:**

- Modify: `docs/specs/2026-07-13-direct-channel-design.md`
- Modify: `docs/specs/README.md`
- Modify: `docs/plans/README.md`
- Modify only when required by an accepted final-review finding: files from Tasks 1–4

### 1. Run final gates

Run:

```bash
pnpm verify:static
pnpm -F @submerge/web test:e2e
```

Re-run the disposable DB upgrade/boot/restart and hostname-private-IP smoke. Recheck the complete viewport/theme/state matrix and record evidence.

### 2. Run the required wide final review

Invoke `/code-review` from the parent of Task 1's commit through `HEAD`, with independent passes for shared/API soundness, migration/data preservation, runtime rule semantics/security, UI fidelity/accessibility, and whole-diff simplification/unrelated churn. Resolve every actionable finding and rerun the complete gates.

### 3. Close documentation and stop before deploy

Set the spec/index status to `implemented` and this plan to `done`. Commit only documentation closure if no code fix is pending:

```bash
git add docs/specs/2026-07-13-direct-channel-design.md docs/specs/README.md docs/plans/README.md
git commit -m "docs: mark the Direct channel implemented" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Report commit ids and verification evidence. Do not push `master` unless the user explicitly authorizes production deployment.
