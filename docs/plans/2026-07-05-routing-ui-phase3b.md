# Routing UI + Domain Presets — Phase 3b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.
>
> **Depends on:** Phase 3a (branch `feat/multi-routing`). Backend channels CRUD/pool/policy tRPC endpoints exist (`channels.list/create/update/remove/reorder/getPool/setPool/setPolicy/recentDecisions`); `buildMultiConfig`/`resolveChannelProxies`/`ControllerRegistry` are live. This phase adds the **«Маршрутизация» UI** and **domain presets**, and folds in the deferred 3a review minors.

**Goal:** Ship the «Маршрутизация» screen (create/edit/reorder/enable/delete channels; per-channel matcher, pool, policy) exactly matching the approved mockup, and make matcher **presets** (YouTube/Telegram/Discord/Torrent) real by expanding them to domains at config generation.

**Architecture:** Presets are curated domain lists on the server, expanded into rules by `applyConfig`; the shared layer exposes only preset `{id,label}` for the UI. The web screen reuses the existing Settings policy editor (extracted into a shared `PolicyEditor`) and the Section/Row/Segmented/Select/Switch/Input/Badge/Button primitives; it wires to the Phase-3a tRPC endpoints.

**Tech Stack:** Node 24, strict TS, tRPC v11, Drizzle, Zod 4, React 19 + TanStack Router/Query + shadcn/ui + Tailwind v4. Biome. Pencil MCP for the visual gate.

## Global Constraints
- English code/comments/commits; **UI strings Russian**.
- **Visual fidelity is a gate** (design-system.md): build to the mockup frames, measure don't invent, render at **1440×1024 dark** and compare element-by-element to the frame + cross-check with `browser_evaluate`; also the **390** mobile breakpoint. Match control *types* (segmented stays segmented, preset chips are toggle-chips, custom domains are a tag-input, pool is grouped checkboxes) — no downgrades. Tokens-in-config only.
- **Visual source (frame map):** `P7RAD` «Маршрутизация · Populated» (main child `fSRZN`; cards `VICOv` collapsed / `Z7zRtE` expanded editor / `muQ15` Default) · `HXRTv` states (create / disabled / mobile 390) · `CUEoq` light. Read exact values via Pencil MCP `batch_get … resolveVariables:true`.
- No faked controls — every control backs a real endpoint. Do NOT build rule-providers (Phase 4).
- Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM `.js`. Self-verify `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` before each commit. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure
**Create:**
- `packages/server/src/modules/channels/presets.ts` — preset domain registry + `resolveMatcherDomains(matcher)`.
- `packages/server/src/modules/channels/presets.test.ts`.
- `packages/web/src/features/channels/PolicyEditor.tsx` — the policy segmented + knobs, extracted (shared by Settings + Routing).
- `packages/web/src/features/channels/RoutingScreen.tsx` — the screen.
- `packages/web/src/features/channels/ChannelCard.tsx` — collapsed summary + expanded editor.
- `packages/web/src/features/channels/PresetChips.tsx`, `DomainTags.tsx`, `PoolPicker.tsx` — matcher + pool controls.
- `packages/web/src/routes/routing.tsx` — the route.

**Modify:**
- `packages/shared/src/schemas.ts` (or a new `presets.ts` in shared) — `CHANNEL_PRESETS: {id,label}[]` + `PresetId` type.
- `packages/server/src/modules/nodes/service.ts` — `applyConfig` uses `resolveMatcherDomains(ch.matcher)` for a channel's `domains`.
- `packages/server/src/modules/nodes/multiConfig.ts` — collision guard (deferred 3a minor).
- `packages/web/src/features/settings/SettingsScreen.tsx` — use the extracted `PolicyEditor` (no behavior change).
- `packages/web/src/components/nav.ts` (+ Sidebar) — activate «Маршрутизация», remove «СКОРО».
- `packages/web/src/routes/tree.ts` — register the route.

**Out of scope (Phase 4):** rule-providers, `DOMAIN-KEYWORD`/geo rule types, bandwidth/on-demand speed test.

---

### Task 1: Domain presets — registry + expansion (backend + shared contract)
**Files:** create `channels/presets.ts` + `presets.test.ts`; modify `shared/src/schemas.ts`, `nodes/service.ts`.

**Interfaces — Produces:**
- Shared: `CHANNEL_PRESETS: readonly {id: string; label: string}[]` (ids `youtube`,`telegram`,`discord`,`torrent`; labels `YouTube`,`Telegram`,`Discord`,`Torrent`) + `type PresetId`.
- Server `presets.ts`: `PRESET_DOMAINS: Record<PresetId, string[]>` (curated) + `resolveMatcherDomains(matcher: ChannelMatcher): string[]` — union of `matcher.domains` + each known preset's domains; dedupe; ignore unknown preset ids; stable order (custom domains first, then presets in `CHANNEL_PRESETS` order).

**Curated domain lists (starter — keep conservative, extend later):**
- `youtube`: `youtube.com`, `googlevideo.com`, `ytimg.com`, `youtu.be`, `youtubei.googleapis.com`, `ggpht.com`.
- `telegram`: `telegram.org`, `t.me`, `telegram.me`, `tdesktop.com`, `telesco.pe`, `telegra.ph`.
- `discord`: `discord.com`, `discord.gg`, `discordapp.com`, `discordapp.net`, `discord.media`, `discordcdn.com`.
- `torrent`: `rutracker.org`, `nnmclub.to`, `rutor.info`, `1337x.to`, `thepiratebay.org`, `torrentgalaxy.to`.

- [ ] Step 1 — failing tests (`presets.test.ts`): `resolveMatcherDomains({presets:["youtube"],domains:["ex.com"]})` = `["ex.com", ...youtube domains]`; dedupe when a custom domain repeats a preset domain; unknown preset id skipped; empty matcher → `[]`.
- [ ] Step 2 — run → FAIL.
- [ ] Step 3 — implement shared `CHANNEL_PRESETS`/`PresetId`, server `PRESET_DOMAINS`/`resolveMatcherDomains`; in `applyConfig`, change the channel input's `domains: ch.matcher.domains` → `domains: resolveMatcherDomains(ch.matcher)`.
- [ ] Step 4 — run `pnpm -F @submerge/shared test && pnpm -F @submerge/server test` → PASS. (An `applyConfig`/config-gen test that a channel with `presets:["youtube"]` emits `DOMAIN-SUFFIX,youtube.com,ch-<id>` is a good addition.)
- [ ] Step 5 — commit `feat(server): domain presets + matcher expansion`.

---

### Task 2: Extract reusable `PolicyEditor` (web)
**Files:** create `features/channels/PolicyEditor.tsx`; modify `features/settings/SettingsScreen.tsx`. Visual gate: Settings unchanged.

**Interface — Produces:** `PolicyEditor({ policy, onChange, nodeNames }: { policy: ChannelPolicy; onChange: (p: ChannelPolicy) => void; nodeNames: string[] })` — the segmented «По задержке / Стабильный IP / Приоритетный узел» + per-kind knobs (speed: testUrl/interval/tolerance/reevaluate; sticky: url/interval/failureThreshold/maxHoldHours/criterion; manual: pinnedNode Select/onFailure) EXACTLY as they exist today in `SettingsScreen`. Pure controlled component (no tRPC inside) — the parent owns persistence.

- [ ] Step 1 — extract the existing policy segment + `switchPolicy`/`updateSpeed`/`updateSticky`/`updateManual` logic from `SettingsScreen.tsx` into `PolicyEditor` (parameterize `nodeNames` for the manual dropdown; `onChange(fullPolicy)` replaces the inline mutate calls).
- [ ] Step 2 — refactor `SettingsScreen` to render `<PolicyEditor policy={policy} nodeNames={nodeNames} onChange={(p) => setPolicyMutation.mutate({ id: "default", policy: p })} />`. No visual/behavior change.
- [ ] Step 3 — gate: `biome ci && typecheck && pnpm -F @submerge/web test`; render Settings at 1440 dark, confirm the auto-select card is pixel-identical to before (it still matches Настройки `w6qeY`).
- [ ] Step 4 — commit `refactor(web): extract reusable PolicyEditor`.

---

### Task 3: Routing route + screen scaffold + channel list (collapsed cards)
**Files:** create `routes/routing.tsx`, `features/channels/RoutingScreen.tsx`, `features/channels/ChannelCard.tsx`; modify `routes/tree.ts`, `components/nav.ts` (+ Sidebar).

**Wiring:** `useQuery(trpc.channels.list.queryOptions())`. Render `RoutingScreen` matching `P7RAD`/`fSRZN`: header (`h1` «Маршрутизация» + sub + primary «Новый канал» button), then the `Channels` stack — a **collapsed** `ChannelCard` per channel (measure `VICOv`): drag-handle · name · policy Badge (accent, label from policy kind) · matcher summary (preset chips + «+N доменов») · pool summary («N узлов» / «Все узлы») · active node (from `channels.recentDecisions`/live — or omit if unavailable, honesty gate) · enabled Switch · expand chevron. Default card pinned LAST, styled per `muQ15` (accent-border, «catch-all», no drag/delete). Empty state (only Default) per `HXRTv`. Activate «Маршрутизация» in the sidebar (remove «СКОРО»).

- [ ] Step 1 — route + nav activation + `RoutingScreen` shell + `channels.list` query + loading/empty states.
- [ ] Step 2 — collapsed `ChannelCard` (summary row) measured against `VICOv`; Default variant against `muQ15`.
- [ ] Step 3 — gate + **visual gate**: render `/routing` at 1440×1024 dark, screenshot, compare element-by-element to `P7RAD` collapsed cards (`get_screenshot P7RAD`); cross-check paddings/type/colors with `browser_evaluate`.
- [ ] Step 4 — commit `feat(web): routing screen + channel list`.

---

### Task 4: Channel editor — matcher (preset chips + custom domains)
**Files:** create `features/channels/PresetChips.tsx`, `DomainTags.tsx`; expand `ChannelCard.tsx` (expanded state).

**Wiring:** expanding a card (`Z7zRtE`) reveals the editor. This task does the **Имя** (Input → `channels.update`) + **Домены** row: `PresetChips` (toggle-chips for `CHANNEL_PRESETS`; active = accent Badge style, inactive = bg-hover; toggling updates `matcher.presets`) and `DomainTags` (custom domains as removable mono chips + an input to add; updates `matcher.domains`). Persist via `channels.update` with the full updated `matcher`. Default card's domains row is read-only «Всё остальное».

- [ ] Step 1 — `PresetChips` + `DomainTags` controlled components (measure chip/tag styling from `Z7zRtE`); a small unit test for the domain-tag add/remove/dedupe logic.
- [ ] Step 2 — wire into the expanded `ChannelCard` (Имя + Домены rows) → `channels.update`.
- [ ] Step 3 — gate + visual gate vs `Z7zRtE` matcher region.
- [ ] Step 4 — commit `feat(web): channel matcher editor (presets + domains)`.

---

### Task 5: Channel editor — pool picker + policy + delete
**Files:** create `features/channels/PoolPicker.tsx`; expand `ChannelCard.tsx`; use `PolicyEditor` (Task 2).

**Wiring:** in the expanded card add **Пул** row (`PoolPicker`: grouped checkboxes over sources — a source checkbox + its expandable node list, per the Источники grouping pattern; reads `sources.list` + `nodes.list`; current pool from `channels.getPool`; persists via `channels.setPool` with `{kind:'source'|'node', ref}[]`; empty = all nodes, show the hint), the **Политика** row (`<PolicyEditor policy={ch.policy} nodeNames={…} onChange={(p) => channels.setPolicy({id, policy:p})} />`), and **Удалить** (secondary destructive → `channels.remove`, non-default only; ConfirmDialog per design-system.md).

- [ ] Step 1 — `PoolPicker` (grouped source/node checkboxes) wired to `getPool`/`setPool`; empty-pool hint.
- [ ] Step 2 — policy row via `PolicyEditor` → `setPolicy`; delete via `remove` + confirm.
- [ ] Step 3 — gate + visual gate vs `Z7zRtE` pool+policy region.
- [ ] Step 4 — commit `feat(web): channel pool picker + policy + delete`.

---

### Task 6: Create · reorder · enable/disable
**Files:** modify `RoutingScreen.tsx`, `ChannelCard.tsx`.

**Wiring:** «Новый канал» → `channels.create` (seed a sensible default policy + empty matcher/pool) → the new card opens expanded. Reorder: drag-handle on desktop (reuse the Источники reorder pattern) / ↑↓ arrows on mobile → `channels.reorder` (Default forced last server-side). Enabled Switch → `channels.update({id, enabled})`; disabled card styled per `HXRTv` (muted). All mutations invalidate `channels.list`.

- [ ] Step 1 — create flow + enabled toggle.
- [ ] Step 2 — reorder (desktop drag + mobile arrows), Default stays pinned last.
- [ ] Step 3 — gate + visual gate vs `HXRTv` (create + disabled) and the **390** mobile layout.
- [ ] Step 4 — commit `feat(web): channel create/reorder/enable`.

---

### Task 7: Deferred Phase-3a review minors (backend)
**Files:** modify `nodes/multiConfig.ts`; add a test to `channels/service.test.ts` (or `pool.test.ts`).

- [ ] Step 1 — **Collision guard:** ensure a generated collapsed-subgroup name (`<group>::<base>` / base) can never equal a proxy name (mihomo rejects proxy/group name clashes). Seed the subgroup-name allocator with the final proxy-name set (and vice-versa) so the two namespaces are jointly unique. Add a test reproducing the narrow case (a Default with a restricted pool collapsing `X` + a later channel contributing a bare proxy `X`) → assert distinct names, config loads.
- [ ] Step 2 — **`updateChannel` matcher test:** a direct test that `updateChannel(db, id, {matcher})` persists and that the regenerated config reflects the new domains/presets.
- [ ] Step 3 — gate green; commit `fix(server): guard collapsed-subgroup vs proxy name collision; test matcher update`.

---

### Task 8: Verification sweep + visual gate
**Files:** none.
- [ ] Step 1 — full gate `biome ci && typecheck && pnpm test` green.
- [ ] Step 2 — **visual gate** (design-system.md): render `/routing` at **1440×1024 dark**, screenshot, compare element-by-element to `get_screenshot P7RAD`; the **390** mobile view vs `HXRTv`; light theme vs `CUEoq`. Fix drift. `pnpm -F @submerge/web design:tokens:check` stays green.
- [ ] Step 3 — **live** (against the running instance + real mihomo): create a channel with preset `youtube` via the UI → confirm `mihomo/config.yaml` gains `DOMAIN-SUFFIX,youtube.com,ch-<id>` (+ the other youtube domains) and the `ch-<id>` group; toggle disable → its rules/group vanish; reorder → priority persists; delete → reverts.
- [ ] Step 4 — risky states: empty (only Default), disabled channel, many channels (scroll), a channel with an empty pool (routes through all nodes), long domain lists.
- [ ] Step 5 — `/code-review`; resolve findings before offering to ship.

---

## Self-Review
- **Spec coverage (design §9 + spec §3/§9):** channels list/CRUD/reorder/enable → Tasks 3,5,6; matcher presets+domains → Tasks 1,4; pool → Task 5; policy reuse → Tasks 2,5; presets backend → Task 1. Visual gate → every UI task + Task 8. Deferred 3a minors → Task 7.
- **Placeholder scan:** curated preset domain lists are concrete (Task 1); UI tasks name their frame ids + mandate the measured visual gate rather than inventing values.
- **Type/name consistency:** `resolveMatcherDomains`, `CHANNEL_PRESETS`/`PresetId`, `PolicyEditor(policy,onChange,nodeNames)`, `PresetChips`/`DomainTags`/`PoolPicker`, and the tRPC endpoints (`list/create/update/remove/reorder/getPool/setPool/setPolicy`) are used consistently across tasks. Default group name stays `AUTO`; non-default `ch-<id>` (Phase 3a).
