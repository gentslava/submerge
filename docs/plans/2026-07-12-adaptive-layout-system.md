# Adaptive Layout System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every web screen respond to its available content width rather than only the browser viewport, with browser-level regression coverage.

**Architecture:** A named `app-page` container is supplied by each screen root. Shared semantic CSS hooks define compact, inline, data, and detail modes at 42rem, 48rem, and 60rem. Application chrome keeps viewport queries; page-content components do not. Browser tests assert geometry and interaction at phone, desktop, and narrow-pane sizes.

**Tech Stack:** React 19, TypeScript, Tailwind v4, CSS container queries, Vitest, Playwright.

---

### Task 1: Establish the shared responsive contract

**Files:**
- Create: `packages/web/src/styles/responsive.css`
- Modify: `packages/web/src/index.css`
- Modify: page roots in `features/nodes/NodesScreen.tsx`, `features/connections/ConnectionsScreen.tsx`, `features/channels/RoutingScreen.tsx`, `features/sources/SourcesScreen.tsx`, `features/settings/SettingsScreen.tsx`, and `routes/more.tsx`
- Test: `packages/web/e2e/layout-contract.spec.ts`

- [ ] **Step 1: Write a browser test that records the page container’s inline width and asserts the compact/data marker changes only at 42rem/48rem.**

```ts
await expect(page.locator(".responsive-page")).toHaveCSS("container-type", "inline-size");
await expect(page.locator("html")).toHaveJSProperty("scrollWidth", await page.locator("html").evaluate((node) => node.clientWidth));
```

- [ ] **Step 2: Run the test before implementation.**

Run: `pnpm -F @submerge/web exec playwright test e2e/layout-contract.spec.ts`

Expected: FAIL because roots do not expose the shared container contract.

- [ ] **Step 3: Add the reusable CSS contract.**

```css
.responsive-page {
  container: app-page / inline-size;
  min-inline-size: 0;
}

@container app-page (min-width: 42rem) { /* cq-inline selectors */ }
@container app-page (min-width: 48rem) { /* cq-data selectors */ }
```

Move existing Nodes and Connections container rules from `index.css` into this file
and apply `responsive-page` to every route root. Preserve `@media` only for sidebar,
bottom navigation, and phone-specific touch hierarchy.

- [ ] **Step 4: Re-run the focused browser test and `pnpm -F @submerge/web build`.**

Expected: PASS and build exits 0.

### Task 2: Convert Nodes to the page-width contract

**Files:**
- Modify: `packages/web/src/features/nodes/NodesHeader.tsx`
- Modify: `packages/web/src/features/nodes/AutoStrategyCard.tsx`
- Modify: `packages/web/src/features/nodes/ActiveNodeCard.tsx`
- Modify: `packages/web/src/features/nodes/LatencyChart.tsx`
- Modify: `packages/web/src/styles/responsive.css`
- Test: `packages/web/e2e/nodes-layout.spec.ts`

- [ ] **Step 1: Write failing narrow-pane tests.**

```ts
await page.setViewportSize({ width: 1024, height: 844 });
await expect(page.getByRole("button", { name: "Дополнительные действия" })).toBeVisible();
await expect(page.getByRole("button", { name: "Пинг всех" })).toBeHidden();
await expect(page.getByText("ПРОВЕРОЧНЫЙ URL")).toBeVisible();
await expect(page.locator("[data-testid='latency-chart']")).toHaveCSS("height", "54px");
```

Run: `pnpm -F @submerge/web exec playwright test e2e/nodes-layout.spec.ts`

Expected: FAIL because current `md:` selects the wide header and overflowing
auto-strategy row in a narrow pane.

- [ ] **Step 2: Replace Nodes content-mode `md`/`lg` classes with semantic hooks.**

Use the compact header and existing action menu below `cq-inline`; show the labelled
header at `cq-inline`. Use one-column compact parameter rows and show the divider
strip at `cq-detail` (60rem), while status may appear at `cq-inline`. Change chart measurement to a
compact 54px and inline 92px mode. Move the active-card/chart horizontal layout to
the container contract.

- [ ] **Step 3: Verify focused test at 320, 390, 767px pane, 768px pane, and 1440.**

Expected: no clipped labels; actions reachable; dense node list starts only at data.

### Task 3: Finish Connections toolbar and table mode

**Files:**
- Modify: `packages/web/src/features/connections/ConnectionsScreen.tsx`
- Modify: `packages/web/src/styles/responsive.css`
- Test: `packages/web/e2e/connections-layout.spec.ts`

- [ ] **Step 1: Write failing width assertions.**

```ts
await expect(search).toHaveCSS("width", /240px/);
await expect(closeAll).toBeRightOf(search);
await expect(documentOverflow(page)).resolves.toBe(false);
```

At 390px, assert search and close action are separate full-width 40px rows. At a
900px viewport with sidebar, assert the compact preferred desktop search does not
consume the whole header and the row wraps naturally only when it no longer fits.

- [ ] **Step 2: Run the test before the change.**

Expected: FAIL because `flex-1` stretches search across wide desktop space.

- [ ] **Step 3: Set a compact search basis without fixed header breakpoints.**

Remove generic `flex-1` from the toolbar/search, use `flex: 0 1 15rem` for the
search, and retain `flex-wrap`. The phone media query overrides it with `width:100%`
and `flex:none`. Keep table/card selection at `cq-data`.

- [ ] **Step 4: Run focused tests and inspect 390/1440 screenshots.**

Expected: search is compact on desktop, full-width only on phones, and no page
overflow occurs.

### Task 4: Convert Routing and shared editor controls

**Files:**
- Modify: `packages/web/src/features/channels/RoutingScreen.tsx`
- Modify: `packages/web/src/features/channels/ChannelCard.tsx`
- Modify: `packages/web/src/features/channels/PolicyEditor.tsx`
- Modify: `packages/web/src/components/ui/segmented.tsx`
- Modify: `packages/web/src/styles/responsive.css`
- Test: `packages/web/e2e/routing-layout.spec.ts`

- [ ] **Step 1: Write failing tests for a 390px route and 456px content pane.**

Assert the mobile add button is a labelled icon-only control, a collapsed card keeps
title/switch/chevron unobscured, long domain chips collapse to `+N`, and expanded
policy fields stack rather than clip.

- [ ] **Step 2: Run the tests before implementation.**

Expected: FAIL because `md` forces non-wrapping segmented/editor rows in the narrow
sidebar pane and mobile uses a full-width add button.

- [ ] **Step 3: Apply `cq-inline` hooks to editor rows, `Segmented`, and card headers.**

Do not give generic `Segmented` its own viewport rule. Its host marks whether it may
be inline. Retain the contextual overflow action model and preserve all editor
semantics.

- [ ] **Step 4: Re-run tests at 390, 768, 1024 with sidebar, and 1440.**

Expected: no control overlap or body overflow; all editor controls remain operable.

### Task 5: Convert Sources, Settings, and More

**Files:**
- Modify: `packages/web/src/features/sources/SourcesScreen.tsx`
- Modify: `packages/web/src/features/sources/SourceForm.tsx`
- Modify: `packages/web/src/features/sources/SourceRow.tsx`
- Modify: `packages/web/src/features/settings/SettingsScreen.tsx`
- Modify: `packages/web/src/features/more/MoreScreen.tsx` only if a root hook is absent
- Modify: `packages/web/src/styles/responsive.css`
- Test: `packages/web/e2e/forms-layout.spec.ts`

- [ ] **Step 1: Write failing test cases with long source names, quota values, and policy labels.**

Assert 456px panes retain source title and action access, fields become a single
column below `cq-inline`, and dense source rows activate only at `cq-data`.

- [ ] **Step 2: Run the focused test before implementation.**

Expected: FAIL because current `md` switches source rows and settings rows too early.

- [ ] **Step 3: Replace content-mode `md` classes with page container hooks.**

Keep phone full-width submit actions, use inline controls only after `cq-inline`, and
move source desktop-row framing to `cq-data`. Do not add unsupported LAN or
TUN/TPROXY controls.

- [ ] **Step 4: Re-run focused test matrix.**

Expected: cards/forms stay readable at compact width and preserve the desktop frame
at 1440.

### Task 6: Add durable browser layout coverage and design reconciliation

**Files:**
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/web/playwright.config.ts`
- Create: `packages/web/e2e/fixtures.ts`
- Create: `packages/web/e2e/layout-contract.spec.ts`
- Create: `packages/web/e2e/nodes-layout.spec.ts`
- Create: `packages/web/e2e/connections-layout.spec.ts`
- Create: `packages/web/e2e/routing-layout.spec.ts`
- Create: `packages/web/e2e/forms-layout.spec.ts`
- Modify: `pencil/web-ui.pen` through Pencil MCP
- Modify: `docs/design-system.md`

- [ ] **Step 1: Add `@playwright/test` as a web development dependency and a `test:e2e` script.**

Run: `pnpm --filter @submerge/web add -D @playwright/test`

Expected: package manifest and lockfile contain only the requested dependency.

- [ ] **Step 2: Create deterministic layout fixtures and a Chromium configuration.**

Fixtures provide long names, multiple chips, node groups, source quotas, and
connection rows without relying on production data. Tests use screenshots only for
390, 768, and 1440; all other widths use bounding-box and overflow assertions.

- [ ] **Step 3: Implement common geometry helpers.**

```ts
export async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}
```

Also assert controls do not overlap and that bottom-nav clearance reaches the last
interactive item.

- [ ] **Step 4: Reconcile Pencil only through Pencil MCP.**

Add a Connections 390 frame; correct stale More/Settings controls to supported
product behaviour; record the approved 48px tab item measurement and Nodes 54px
chart measurement in `docs/design-system.md`. Do not hand-edit `web-ui.pen` JSON.

- [ ] **Step 5: Run all browser layout tests.**

Run: `pnpm -F @submerge/web test:e2e`

Expected: PASS at all specified viewports and synthetic pane widths.

### Task 7: Final verification and review

**Files:** review all changed files; no planned production changes.

- [ ] **Step 1: Run the required static gates.**

Run: `./node_modules/.bin/biome ci packages/ && pnpm typecheck && pnpm test && pnpm -F @submerge/web build`

Expected: all commands exit 0.

- [ ] **Step 2: Run the complete browser matrix and inspect 390/768/1440 screenshots against Pencil.**

Run: `pnpm -F @submerge/web test:e2e`

Expected: no screenshot or geometry regression.

- [ ] **Step 3: Run independent spec-compliance and code-quality reviews, resolve every required finding, and repeat the relevant checks.**

- [ ] **Step 4: Update `docs/plans/README.md` status only after all gates are green. Commit only on explicit user request.**

## Corrective verification — 2026-07-13

- `pnpm verify:static`: Biome, token drift, strict TypeScript, 538 Vitest tests, and
  production builds passed.
- Playwright: 33/33 passed without retries across 320–1440px, populated/error states,
  container boundaries, internal overflow, and popup collision/focus behavior.
- Pencil frames `I4hmn` and `jwsEZ` were compared with captures in
  `/private/tmp/submerge-visual-evidence/` at 1440×1024 dark and 390px mobile.
- Independent server/shared, UI, and infrastructure reviews were resolved before commit.
