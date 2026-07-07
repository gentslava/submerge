# Routing Phase 4 — Implementation Plan (rule-providers · keyword/geo · speed test)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.
>
> **Depends on:** Phases 3a/3b (shipped). Channels CRUD/pool/policy tRPC endpoints, `buildMultiConfig`/`resolveChannelProxies`/`ControllerRegistry`, matcher presets, and the «Маршрутизация» screen are all live.

**Goal:** Deliver the three deferred Phase-4 routing features from [../specs/2026-07-07-routing-phase4-design.md](../specs/2026-07-07-routing-phase4-design.md): (4a) `DOMAIN-KEYWORD` + external `rule-providers`; (4b) geo rules (`GEOSITE`/`GEOIP`); (4c) on-demand speed test + `highest-bandwidth` sticky criterion. Each phase is an independent, shippable vertical slice.

**Architecture:** All three are properties of a **channel matcher/policy** — additive Zod fields (empty defaults, no `channels` migration), expanded into extra `rules:` + top-level `rule-providers:`/geo keys by `buildMultiConfig`. Speed test adds a hidden `PROBE` group + a `measureBandwidth` mihomo-client call + a `node_bandwidth` table. No new routing engine, no global provider registry (ADR-0004).

**Tech Stack:** Node 24, strict TS, tRPC v11, Drizzle + SQLite, Zod 4, React 19 + TanStack Router/Query + shadcn/ui + Tailwind v4. Biome. Pencil MCP for the visual gate.

## Global Constraints
- English code/comments/commits; **UI strings Russian**.
- Zod `.parse()` at every boundary; **mihomo responses parsed** in `clients/mihomo.ts` only.
- **Visual fidelity is a gate** (design-system.md): build matcher controls to the mockup, render at **1440×1024 dark** + the **390** mobile breakpoint, compare element-by-element, cross-check with `browser_evaluate`. Match control *types* (tag-inputs stay tag-inputs, selects stay selects) — no downgrades. Tokens-in-config only. **Refresh the stale `docs/design-system.md` frame map** (add Соединения/Диагностика/Трафик/Логи + re-confirm Маршрутизация id `fFpGe`) as part of the first UI task.
- Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM `.js` specifiers. Self-verify `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test` before each commit (raw biome, not the masked hook). Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Per-slice `/code-review` (incremental) + a final wide `/code-review` before offering to ship. Push only when the user asks (push to master = prod deploy) and **verify in prod** after.

---

# Phase 4a — DOMAIN-KEYWORD + rule-providers

**Ship first** — highest value, no container/geo change.

### Task 1: Matcher schema — keywords + rule-provider refs (shared)
**Files:** modify `packages/shared/src/schemas.ts`; add cases to its test.

**Produces:**
- `keywordSchema` — trimmed, 1..63 chars, no whitespace (a substring token).
- `ruleProviderRefSchema` = `{ url, behavior: "domain"|"ipcidr"|"classical", format: "yaml"|"text"|"mrs" (default "yaml"), name?: string }`, with a `.refine` rejecting `format:"mrs"` + `behavior:"classical"` and requiring `http(s)` URLs.
- `channelMatcherSchema` / `channelMatcherInputSchema` gain `keywords: []` and `ruleProviders: []` (defaulted). Update `ChannelMatcher` type.

- [ ] Step 1 — failing tests: matcher parses with new empty defaults; `mrs`+`classical` rejected; non-https url rejected; keyword with a space rejected.
- [ ] Step 2 — run → FAIL.
- [ ] Step 3 — implement the schemas additively.
- [ ] Step 4 — `pnpm -F @submerge/shared test` → PASS.
- [ ] Step 5 — commit `feat(shared): matcher keywords + rule-provider refs`.

### Task 2: Config gen — keyword rules + top-level `rule-providers:` (server)
**Files:** modify `packages/server/src/modules/nodes/multiConfig.ts`, `packages/server/src/modules/nodes/service.ts` (`applyConfig` → carry `keywords` + `ruleProviders` into `ChannelConfigInput`); extend `multiConfig.test.ts`.

**Produces:**
- `ChannelConfigInput` grows `keywords: string[]` and `ruleProviders: RuleProviderRef[]`.
- `buildRules` emits `DOMAIN-KEYWORD,<kw>,<group>` and `RULE-SET,<providerName>,<group>` per channel (in addition to existing `DOMAIN-SUFFIX`).
- New `buildRuleProviders(channels)`: dedupe refs by `(url,behavior,format)`, derive `rp-<hash8>` names, emit the `rule-providers:` map (`type:http`, `proxy:DIRECT`, `interval:86400`, `path:./providers/<name>.<ext>`, `size-limit`), and return the name map so `buildRules` can reference it.
- Provider names added to the **collision-guard reserved set** (`dedupeNames`).
- `cfg` object gains `"rule-providers"` before `proxy-groups` (only when non-empty).

- [ ] Step 1 — failing tests: a channel with `keywords:["porn"]` → `DOMAIN-KEYWORD,porn,ch-<id>`; a channel with one provider ref → one `rule-providers` entry + one `RULE-SET` line; the same URL on two channels → **one** provider def, **two** `RULE-SET` lines; empty refs → no `rule-providers` key; provider name never collides with a proxy/group name.
- [ ] Step 2 — run → FAIL.
- [ ] Step 3 — implement `buildRuleProviders` + `buildRules`/`applyConfig`/`cfg` wiring.
- [ ] Step 4 — `pnpm -F @submerge/server test` → PASS.
- [ ] Step 5 — incremental `/code-review` on the diff; then commit `feat(routing): DOMAIN-KEYWORD + external rule-providers in config gen`.

### Task 3: Matcher editor UI — keywords + rule-providers (web)
**Files:** modify `packages/web/src/features/channels/ChannelCard.tsx`; add `KeywordTags.tsx` (reuse `DomainTags` pattern) + `RuleProviderRows.tsx`; wire via existing `channels.update`. Refresh `docs/design-system.md` frame map.

- [ ] Step 1 — Pencil MCP: read the matcher-editor frame (`fFpGe` + expanded child), `resolveVariables:true`; note exact tokens for the new rows. Refresh the frame map table.
- [ ] Step 2 — «Ключевые слова» tag-input (validates via `keywordSchema`) below domain tags; commits to `matcher.keywords` via `channels.update`.
- [ ] Step 3 — «Списки правил» repeatable rows (URL input + behavior select + format select; add/remove); commits to `matcher.ruleProviders`.
- [ ] Step 4 — ⛔ visual gate: render 1440×1024 dark + 390; compare to frame; `browser_evaluate` cross-check. No dead controls.
- [ ] Step 5 — incremental `/code-review`; commit `feat(web): channel matcher keyword + rule-provider editors`.

---

# Phase 4b — geo rules (GEOSITE / GEOIP)

### Task 4: Geo matcher fields (shared)
**Files:** modify `packages/shared/src/schemas.ts` + test.
- `geoCategorySchema` = `^[a-z0-9-]+$`; `geoCountrySchema` = `^[A-Z]{2}$` plus `private`/`LAN`. `channelMatcherSchema` gains `geosite: []`, `geoip: []`.
- [ ] TDD: valid `youtube`/`category-ads-all`; `RU` ok, `ru`/`RUS` rejected. Implement. `pnpm -F @submerge/shared test`. Commit `feat(shared): geosite/geoip matcher fields`.

### Task 5: Geo rule emission + conditional geodata (server)
**Files:** modify `multiConfig.ts` (+`applyConfig`, +test).
- `buildRules` emits `GEOSITE,<cat>,<group>` and `GEOIP,<code>,<group>,no-resolve` per channel.
- New `geoTopLevel(channels)`: when any enabled channel uses geo, add `geodata-mode:true`, `geo-auto-update:true`, `geo-update-interval:168`, `geox-url:{geoip,geosite,mmdb}` (MetaCubeX release URLs). Emit **only** when a geo rule exists.
- [ ] TDD: channel with `geosite:["youtube"]` → `GEOSITE,youtube,ch-<id>` + geo top-level block present; a geo-free config has **no** geodata keys; `geoip:["RU"]` → `GEOIP,RU,...,no-resolve`. Implement. `pnpm -F @submerge/server test`. Incremental `/code-review`. Commit `feat(routing): geosite/geoip rules + conditional geodata`.

### Task 6: Geo matcher UI + deploy note (web + docs)
**Files:** `ChannelCard.tsx` (+ a `GeoTags.tsx`); `docs/architecture.md` or deploy notes.
- [ ] Step 1 — Pencil: geo rows tokens from the frame.
- [ ] Step 2 — «Категории (GEOSITE)» + «Страны (GEOIP)» tag-inputs, validated; commit to matcher via `channels.update`.
- [ ] Step 3 — ⛔ visual gate (1440×1024 dark + 390).
- [ ] Step 4 — document: mihomo container downloads `geoip.dat`/`geosite.dat` (~MBs) on first geo use → needs egress + writable Home Dir (already true for `providers/`); on a locked-down host this can fail — surface, don't fake.
- [ ] Step 5 — incremental `/code-review`; commit `feat(web): geosite/geoip matcher editor + deploy note`.

---

# Phase 4c — on-demand speed test + highest-bandwidth

Largest surface. Passive-bandwidth display (Task 7) is nearly free and may ship alongside 4a/4b.

### Task 7: Passive bandwidth display (web, low-risk)
**Files:** `packages/web/src/features/nodes/*` (active-node card); reuse the existing `/traffic` SSE (`streamTraffic`).
- [ ] Show the active node's live up/down Mbps (honest real-usage number). No new backend. Visual gate. Commit `feat(web): passive active-node bandwidth display`.

### Task 8: `node_bandwidth` table + measureBandwidth client (server)
**Files:** `packages/server/src/db/schema.ts` (+ `db:generate` migration); `packages/server/src/clients/mihomo.ts`.
- `node_bandwidth (node_name text PK, mbps real, tested_at integer)`.
- `measureBandwidth(node, {url, timeoutMs, maxBytes})` in the mihomo client: `PUT /proxies/PROBE {name:node}` → timed, byte-capped, timeout-bounded GET of a fixed payload through the local mixed-port → bytes/sec → restore PROBE. Parse/guard all responses.
- [ ] Step 1 — failing test (mocked fetch/mihomo): computes Mbps from bytes/elapsed; honours `maxBytes`/timeout; always restores PROBE (even on error).
- [ ] Step 2 → FAIL. Step 3 — implement + `db:generate`. Step 4 — `pnpm -F @submerge/server test` PASS. Step 5 — commit `feat(server): node bandwidth table + measureBandwidth probe`.

### Task 9: PROBE group + reserved-host rule (server config gen)
**Files:** `multiConfig.ts` (+test).
- Hidden `PROBE` `select` (members = full inventory, **not** in top-level `PROXY`); a `DOMAIN,<probe-host>,PROBE` rule placed **above** all channel rules.
- [ ] TDD: config contains the `PROBE` group + reserved-host rule; `PROBE` absent from `PROXY.proxies`. Implement. Incremental `/code-review`. Commit `feat(routing): hidden PROBE group for speed tests`.

### Task 10: Speed-test endpoint + highest-bandwidth scoring (server)
**Files:** `packages/server/src/modules/nodes/` (new `speedtest` service + tRPC `nodes.speedTest` / `channels.speedTestPool`); `packages/server/src/modules/channels/controller.ts` (`pickBest` reads cached bandwidth for `highest-bandwidth`).
- Serialize probes (one at a time); persist to `node_bandwidth`; return value + `tested_at`.
- `pickBest` with `initialCriterion:"highest-bandwidth"` ranks by cached `mbps`; nodes without a cached value fall back to `fastest` ordering (documented).
- [ ] TDD: endpoint measures+caches; concurrent calls serialize; `highest-bandwidth` picks the highest cached node and falls back for uncached. Implement. `pnpm -F @submerge/server test`. Incremental `/code-review`. Commit `feat(routing): on-demand speed test endpoint + highest-bandwidth criterion`.

### Task 11: Speed-test UI + criterion knob (web)
**Files:** `packages/web/src/features/nodes/*` + `PolicyEditor.tsx` (add `highest-bandwidth` to sticky segmented).
- [ ] Step 1 — Pencil: read any speed-test / node-detail frame tokens.
- [ ] Step 2 — per-node / per-pool «Тест скорости» action behind a **confirm dialog** stating the traffic cost; show cached Mbps + relative age; spinner during measurement.
- [ ] Step 3 — `PolicyEditor` sticky adds the `highest-bandwidth` option (backs the real criterion).
- [ ] Step 4 — ⛔ visual gate (1440×1024 dark + 390).
- [ ] Step 5 — incremental `/code-review`; commit `feat(web): speed-test action + highest-bandwidth policy option`.

---

## Final review & ship (per phase)
- [ ] ⛔ Wide `/code-review` across the finished phase (integration, empty/error/collapsed states, full UI sweep at 1440×1024 dark + breakpoints).
- [ ] Update `docs/specs/README.md` + `docs/plans/README.md` status; flip the spec `Status` line.
- [ ] Ship only when the user asks (push = prod deploy) → verify the feature live on the deployed instance.

## Spec coverage
- §3 matcher/policy schema → Tasks 1, 4, (8 policy). §4a keyword+rule-providers → Tasks 2, 3. §4b geo → Tasks 5, 6. §5 speed-test mechanism → Tasks 8, 9, 10. §5 passive bandwidth → Task 7. §6 UI → Tasks 3, 6, 11. §7 phasing → the 4a/4b/4c split. §8 risks (provider trust, geo egress, speed-test cost, honesty) → Tasks 2/5/10 guards + Task 6 deploy note.

## Out of scope (per §9)
Global rule-provider registry/screen; `sub-rule`/`SCRIPT`/hand-authored IP/port rules; converting presets to mrs/geosite; UI knobs for geo/provider update intervals.
