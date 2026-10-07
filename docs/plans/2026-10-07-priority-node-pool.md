# Priority node selection follows the channel pool

Status: Complete and verified; `codex/priority-node-pool` is the feature branch for
a PR to `master`. Publication requested; production deployment remains separate.

Spec: [Channel routing](../specs/2026-07-01-channel-routing-design.md), sections 4–5.
The reported behavior confirms the intended contract: manual policy candidates
must come from the channel's resolved pool, including source-level membership.
An empty pool retains its existing all-nodes meaning.

## Slice

- [x] Red regression tests for node/source membership, empty/stale pools, excluded
  nodes, generated groups, and a saved pin removed from the pool.
- [x] Share canonical server policy candidates across Routing and Default Settings.
  Refresh candidates after pool writes; never silently replace a saved pin.
- [x] `pnpm verify:static` and focused zero-retry browser evidence.
- [x] Independent incremental `/code-review`, findings resolved.
- [x] Independent final `/code-review`, findings resolved.

## UI evidence

- References: current Routing dark `lYrng` -> expanded editor `bC9cw` / `X7Rrc`
  (`Z7zRtE` and `P7RAD`/`fSRZN` in older component comments), light `CUEoq`,
  mobile/states `HXRTv`; native select and segmented controls stay unchanged.
- Pencil MCP could not connect to the desktop app (three retries, transport
  disconnected). The user-provided project instructions explicitly permit the
  tracked plain JSON mockup as a fallback; use its current values.
- Browser plugin not available; use repository Playwright and populated tRPC
  fixtures on an isolated Vite server.
- Flow: `/routing` -> expand channel -> select manual policy -> only pool nodes
  -> change pool -> candidates refresh -> choose eligible node -> persisted pin.
- States: source membership, individual nodes, unrestricted empty pool, stale
  refs/pin, unavailable inventory/pool, collapsed, manual policy switch, Settings.
- Widths: 320/390/425/768/1024/1440 and existing 983/984 container boundary;
  dark mockup viewport 1440 x 1024 plus mobile light. Inspect `html`, `.app-main`,
  `.responsive-page`, select containment, console, keyboard and screenshot.
- Red baseline: six new failures confirmed (four missing pool resolver cases,
  retained out-of-pool option, enabled stale-only select). The eligible active-exit
  seed regression also covers the shared existing seed behavior.
- Static gate: Node 24.21.0, `pnpm verify:static`: Biome, token sync, typecheck,
  140 shared + 1270 server + 294 web tests, production builds. Existing two skipped
  server tests, pnpm-store symlink and bundle-size warnings remain.
- Browser gate: isolated `http://127.0.0.1:5179`, installed headless Chromium via
  `/tmp/submerge-playwright.config.mjs`, final `priority-node-pool.spec.ts`: 22 passed
  (27.8s); existing `routing-layout.spec.ts`: 20 passed in the preceding combined
  run (39 passed, 39.4s). All runs use zero retries.
  First new-test run exposed incorrect batched POST expectations, a mistyped
  checkbox locator and a baseline native-select font expectation; all corrected
  against measured DOM evidence. No app regression was concealed by retries.
- Screenshots inspected: `/tmp/submerge-priority-pool-1440-dark.png`,
  `/tmp/submerge-priority-pool-390-dark.png`,
  `/tmp/submerge-priority-pool-390-light.png`. Measured select height 36px, radius
  8px, current rendered font 16px. The pre-existing Select font differs from the
  13px mockup; this behavior fix adds no CSS or token changes. All three scroll
  owners and control bounds fit at all eight widths; keyboard focus/Tab works.
- Persistence evidence: browser asserts `channels.setPolicy` sends the eligible
  pin and channel id; the actual engine/deployed instance remains untested.
- Incremental reviewer `/root/incremental_code_review` found two P2 issues:
  old unrestricted candidates remained selectable during a pool refetch, and
  source names could differ from engine-generated names (e.g. AUTO -> AUTO-2).
  Replaced client resolution with a read-only `channels.policyNodes` projection
  using `collectActiveRoutingInputs` and `buildMultiConfigDocument`; it returns
  only canonical pool names, with no YAML/credentials returned, external requests,
  writes or config apply. Disabled
  channel preview changes no stored enabled flag. Pool and Routing mutations
  reset this query so a changed eligibility set is blocked while pending, with
  normal panel polling keeping subscription-derived membership current.
- Replacement red baseline: five server failures for the missing projection;
  server tests now cover SQLite source/node union, stale/disabled refs, exclusions,
  disabled editing and collapsed groups. Browser regressions exercise AUTO-2 and
  a deliberately delayed refresh after restricting an empty pool. Page identity,
  runtime/console, selection persistence and keyboard checks passed; fixture SSE
  subscriptions intentionally abort and their resource-abort messages are ignored.
- Incremental follow-up found a third P2: polling must preserve native-select
  options while unchanged data refreshes. A failing delayed-poll browser test
  reproduced the disruption. Fixed by retaining cached canonical candidates for
  routine refetches, while explicit writes reset the cache before fetching.
  Final incremental re-review: **No findings**; all three P2 findings resolved.
- Final reviewer `/root/final_code_review` found one P2: the server persists the
  pool before awaiting engine apply, leaving old priority candidates selectable
  while the mutation response is delayed; a post-persistence error also skipped
  the refresh. Two failing browser regressions confirmed both response paths.
  `ChannelPolicyEditor` now observes this channel's pending pool mutation;
  `PoolPicker.onSettled` awaits pool/channel refetch and canonical cache reset on
  both success and error. Selection stays blocked until persisted eligibility
  is current. The delayed-projection copy is now "Сохранение пула узлов…" because
  settlement remains part of the write lifecycle.
- Final independent follow-up: **No findings**. Reviewer confirmed the affected
  channel stays blocked through mutation and settlement on both response paths,
  while routine polling preserves options. All review findings are resolved.
- No production deployment or verification is claimed.

## Publication recheck

- Feature branch starts at fresh `origin/master` `497dc2d5`, after the prior import
  feature and dependency updates merged. No manifest or lockfile changes are
  included in this fix.
- Frozen-lockfile installation on Node 24.21.0 / pnpm 11.10.0; full static gate
  passed again with React 19.3, TanStack Query 5.104.1, tRPC 11.19, jsdom 30.1.1,
  Vite 8.3.2 and Playwright 1.63.0. Test counts remain 140 / 1270 / 294.
- Combined priority-node and routing browser gate: **42 passed**, zero retries
  (46.4s), at the same eight widths and themes. Refreshed screenshots were inspected.
- Independent final reviewer `/root/final_code_review` rechecked all 18 paths
  against the new base and installed query/tRPC behavior: **No findings**.

## CI database isolation follow-up

- PR #46 failed with `SQLITE_BUSY` during the `db/client` singleton import in
  `nodes/service.test.ts`. Concurrent test workers used the same default runtime
  database file even when their test fixtures later called `createDb(":memory:")`.
- Keep production database behavior unchanged. Set `DB_PATH=:memory:` in the
  server Vitest environment before module imports, covering all server suites.
- [x] Red singleton-isolation regression using an explicit external file path.
- [x] Config fix, full static gate and parallel server-suite verification.
- [x] Independent incremental and final `/code-review`, findings resolved.
- Publication target: existing PR #46 on `codex/priority-node-pool`. Remote head
  and CI results are verified separately from the local validation below.
- The regression failed against an external `DB_PATH` before the configuration
  change and passed afterward together with the production environment-default
  tests (10 tests). An exclusive SQLite lock was held on the external file for
  the entire server suite with eight workers: **1271 passed**, two existing skips.
- Full `pnpm verify:static` passed: 140 shared / 1271 server / 294 web tests,
  repository lint, token drift, typecheck and production builds. This follow-up
  changes only test configuration and its regression; the existing 42 passing
  browser scenarios remain the UI evidence for the feature.
- Incremental reviewer `/root/incremental_code_review` and whole-change final
  reviewer `/root/final_code_review`: **No findings**. Both checked pre-import
  environment overrides, explicit file fixtures and production defaults.
