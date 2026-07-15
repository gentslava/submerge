# Diagnostics Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the Diagnostics route with bounded, non-destructive server checks for submerge, mihomo, happ-decoder, external IP, enabled proxy-channel exits, routed services, and current mihomo runtime configuration.

**Architecture:** New Zod contracts and isolated client methods parse every external response. One process-wide `DiagnosticsService` owns a five-minute result cache and one in-flight promise; it runs component checks first, then bounded dependent route/service/IP probes, normalizes all raw failures into safe result codes, and returns one atomic snapshot through a protected tRPC query. The web retains the previous snapshot during forced refresh and renders the approved desktop/light/mobile/state frames without additional persistence or polling.

**Tech Stack:** TypeScript 6, Zod 4, Drizzle + SQLite, undici `ProxyAgent`, tRPC v11, React 19, TanStack Query/Router, Tailwind v4, Vitest fake timers, Testing Library, Playwright, Pencil MCP, Biome.

**Source specification:** [`docs/specs/2026-07-15-diagnostics-screen-design.md`](../specs/2026-07-15-diagnostics-screen-design.md)

**Pencil references:** dark `QoRoZ`, light `h9q7E`, mobile 390 `BNOEr`, states `pi7pQ`. Connections table reference: dark `g5hb4`, light `t9XUT`.

**Commit rule:** Tasks 1–4 are vertical slices. Every slice starts with failing tests, passes `pnpm verify:static`, receives an independent incremental `/code-review`, and is committed before the next slice. Task 4 performs the final wide review and complete visual sweep before its commit.

---

## File structure

- `packages/shared/src/diagnostics.ts` — strict browser/server result and input Zod contract.
- `packages/server/src/modules/diagnostics/model.ts` — pure active-leaf resolution, safe host/attribution, counts, and verdict precedence.
- `packages/server/src/modules/diagnostics/service.ts` — checks, limits, timing, TTL cache, and in-flight deduplication.
- `packages/server/src/modules/diagnostics/router.ts` — thin protected `run` query.
- `packages/server/src/modules/diagnostics/singleton.ts` — one service instance bound to the process DB and clients.
- `packages/web/src/features/diagnostics/DiagnosticsScreen.tsx` — route query/refresh lifecycle and page composition.
- `packages/web/src/features/diagnostics/DiagnosticsSections.tsx` — presentational verdict/IP/components/routes/services/config blocks.
- `packages/web/src/features/diagnostics/view.ts` — safe formatting and client-only loading/refresh view helpers.
- `packages/web/e2e/diagnostics-layout.spec.ts` — all states, responsive geometry, interaction, and visual evidence.

Do not add a migration, Redis, cron, background worker, arbitrary URL input, or automatic repair action.

---

## Task 1: Define contracts and parse every external diagnostic boundary

**Files:**

- Create: `packages/shared/src/diagnostics.ts`
- Create: `packages/shared/src/diagnostics.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/server/src/clients/mihomo.ts`
- Modify: `packages/server/src/clients/mihomo.test.ts`
- Modify: `packages/server/src/clients/happDecoder.ts`
- Modify: `packages/server/src/clients/happDecoder.test.ts`

- [ ] **Step 1: Write failing shared-contract tests**

Define these enums and result shapes:

```ts
export const diagnosticCheckStatusSchema = z.enum(["ok", "failed", "skipped"]);
export const diagnosticStateSchema = z.enum([
  "ready",
  "partial",
  "mihomo-down",
  "no-nodes",
  "no-internet",
  "external-ip-unavailable",
]);
export const diagnosticErrorCodeSchema = z.enum([
  "timeout",
  "unreachable",
  "invalid-response",
  "http-error",
  "no-active-node",
  "no-proxy-nodes",
  "dependency-unavailable",
  "unknown",
]);

export const diagnosticsRunInput = z.object({ force: z.boolean().default(false) });
```

The exported `DiagnosticsResult` schema contains:

```ts
{
  startedAt: string;
  completedAt: string;
  durationMs: number;
  state: DiagnosticState;
  summary: string;
  components: Array<{
    id: "submerge" | "mihomo" | "happ-decoder";
    status: DiagnosticCheckStatus;
    durationMs: number | null;
    version: string | null;
    detail: string;
    errorCode: DiagnosticErrorCode | null;
  }>;
  externalIp: {
    status: DiagnosticCheckStatus;
    ip: string | null;
    country: string | null;
    colo: string | null;
    durationMs: number | null;
    route: string | null;
    node: string | null;
    detail: string;
    errorCode: DiagnosticErrorCode | null;
  };
  routes: Array<{
    channelId: string;
    channelName: string;
    targetHost: string;
    node: string | null;
    status: DiagnosticCheckStatus;
    durationMs: number | null;
    detail: string;
    errorCode: DiagnosticErrorCode | null;
  }>;
  services: Array<{
    id: "google" | "youtube" | "telegram" | "cloudflare" | "chatgpt" | "steam";
    label: string;
    status: DiagnosticCheckStatus;
    durationMs: number | null;
    httpStatus: number | null;
    detail: string;
    errorCode: DiagnosticErrorCode | null;
  }>;
  config: {
    status: DiagnosticCheckStatus;
    proxyEndpoint: string;
    mode: string | null;
    dns: boolean | null;
    ipv6: boolean | null;
    tun: boolean | null;
    errorCode: DiagnosticErrorCode | null;
  };
}
```

Use actual Zod schemas rather than an unchecked TypeScript interface. Export inferred `DiagnosticCheckStatus`, `DiagnosticState`, `DiagnosticErrorCode`, `DiagnosticRouteResult`, `DiagnosticServiceResult`, and `DiagnosticsResult` types for server/browser consumers. Tests reject negative durations, malformed IP/time, unknown component/service ids, invalid statuses, and nested/raw error values. `detail` is safe display copy, not an exception string.

Run:

```bash
pnpm -F @submerge/shared test -- src/diagnostics.test.ts
```

Expected: FAIL because the diagnostics contract does not exist.

- [ ] **Step 2: Write failing mihomo boundary tests**

Add normalized client outputs:

```ts
export interface MihomoVersion { version: string }
export interface MihomoRuntimeConfig {
  mode: string | null;
  dns: boolean | null;
  ipv6: boolean | null;
  tun: boolean | null;
}
export interface ExternalIpTrace { ip: string; country: string | null; colo: string | null }
export interface ProxyHttpProbe { status: number }

export function getVersion(signal?: AbortSignal): Promise<MihomoVersion>;
export function getRuntimeConfig(signal?: AbortSignal): Promise<MihomoRuntimeConfig>;
export function getExternalIpTrace(signal?: AbortSignal): Promise<ExternalIpTrace>;
export function probeThroughProxy(url: string, signal?: AbortSignal): Promise<ProxyHttpProbe>;
```

Extend `getDelay` with an optional third argument without breaking current callers:

```ts
getDelay(name, url, { timeoutMs: 5000, expected: "200-399", signal })
```

Tests must prove:

- `/version` and `/configs` use controller auth and reject malformed JSON;
- runtime config parses mode plus nullable `dns.enable`, `ipv6`, and `tun.enable` instead of assuming generated defaults;
- delay encodes name/url/timeout/expected and composes the caller signal with the per-request timeout;
- trace/probe use `ProxyAgent(env.MIHOMO_PROXY)`, cap/close bodies, destroy the agent, and never contact the destination directly;
- Cloudflare key-value text parses only valid IP plus optional `loc`/`colo`, ignores unknown lines, rejects missing/invalid IP, and has a bounded body size;
- probe returns any HTTP status for service classification by the diagnostics service;
- abort/timeout/non-2xx controller responses reject with an error that remains server-side.

Use `AbortSignal.any([callerSignal, AbortSignal.timeout(...)])` on Node 24 where a caller signal is present.

- [ ] **Step 3: Write failing happ health tests**

Add:

```ts
export async function healthHapp(signal?: AbortSignal): Promise<{ ok: true }>;
```

It performs parsed `GET /health` with a five-second maximum, separate from the existing 70-second decode timeout. Tests cover `{ok:true}`, `{ok:false}`, malformed JSON, 500, abort, and unreachable sidecar.

- [ ] **Step 4: Implement clients and verify the boundary slice**

Run:

```bash
pnpm -F @submerge/shared test -- src/diagnostics.test.ts
pnpm -F @submerge/server test -- src/clients/mihomo.test.ts src/clients/happDecoder.test.ts
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 1 with external parsing, abort cleanup, body caps, and secret-boundary focus; resolve findings and rerun.

Commit:

```bash
git add packages/shared/src/diagnostics.ts packages/shared/src/diagnostics.test.ts packages/shared/src/index.ts packages/server/src/clients/mihomo.ts packages/server/src/clients/mihomo.test.ts packages/server/src/clients/happDecoder.ts packages/server/src/clients/happDecoder.test.ts
git commit -m "feat(diagnostics): add parsed probe clients" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Implement route semantics, bounded orchestration, and cache

**Files:**

- Create: `packages/server/src/modules/diagnostics/model.ts`
- Create: `packages/server/src/modules/diagnostics/model.test.ts`
- Create: `packages/server/src/modules/diagnostics/service.ts`
- Create: `packages/server/src/modules/diagnostics/service.test.ts`
- Create: `packages/server/src/modules/diagnostics/router.ts`
- Create: `packages/server/src/modules/diagnostics/router.test.ts`
- Create: `packages/server/src/modules/diagnostics/singleton.ts`
- Create: `packages/server/src/version.ts`
- Modify: `packages/server/src/trpc/router.ts`
- Modify: `packages/server/src/trpc/router.test.ts`

- [ ] **Step 1: Write failing pure-model tests**

Export and test:

```ts
export function resolveActiveLeaf(
  proxies: ProxiesResponse["proxies"],
  groupName: string,
): string | null;

export function safeTargetHost(rawUrl: string): string;
export interface DiagnosticStateInput {
  mihomoStatus: DiagnosticCheckStatus;
  realNodeCount: number;
  externalIpStatus: DiagnosticCheckStatus;
  routes: readonly DiagnosticRouteResult[];
  services: readonly DiagnosticServiceResult[];
  remainingRequiredStatuses: readonly DiagnosticCheckStatus[];
}

export function deriveDiagnosticState(input: DiagnosticStateInput): DiagnosticState;
```

`resolveActiveLeaf` follows `now` through nested groups to a non-group proxy, returns `DIRECT` as a valid leaf, and returns null for missing members, absent `now`, or cycles.

`safeTargetHost` returns only a URL hostname; credentials, path, query, and hash never appear. Invalid configured strings return «контрольный URL».

State tests enforce this exact precedence:

1. failed mihomo component → `mihomo-down`;
2. zero real nodes → `no-nodes`;
3. nodes exist and every attempted external-IP/route/service outbound check failed → `no-internet`;
4. all other required checks pass except external IP → `external-ip-unavailable`;
5. any other required failed/skipped check → `partial`;
6. otherwise → `ready`.

Slow successful durations remain `ok`. Skipped entries never count as pass.

- [ ] **Step 2: Write failing TTL/deduplication tests**

`DiagnosticsService` exposes:

```ts
export class DiagnosticsService {
  run(input?: { force?: boolean }): Promise<DiagnosticsResult>;
}
```

Construct it with a small explicit dependency object (same pattern as `LiveHub`) containing the process DB, client methods, clock, and service registry; do not introduce a project-wide DI container.

With fake time and deferred promises, prove:

- first call executes once;
- a non-forced call before five minutes returns the exact cached result;
- at five minutes it executes again;
- `force: true` bypasses a completed cache;
- any call, including forced, joins an existing in-flight promise;
- failed/partial results use the same TTL;
- rejection from the internal runner is normalized to a complete safe result and does not leave `inFlight` stuck;
- after completion, only result/completedAt remain; no per-run history is retained.

- [ ] **Step 3: Write failing orchestration tests with mocked clients**

Use an in-memory `createDb(":memory:")` with migrated/seeded channels and deterministic client stubs. Cover:

- submerge SQLite readiness/version, mihomo version, and happ health start concurrently;
- mihomo failure skips proxy-dependent config/IP/routes/services but retains submerge/happ results;
- Default plus enabled proxy channels become rows in match order; disabled proxy and Direct do not;
- `policyProbe` supplies each control URL and manual uses its existing default;
- each route tests the resolved current leaf, never the policy group itself, so diagnostics cannot clear a fixed selection or choose a node;
- no real nodes skips IP and non-DIRECT proxy routes while service checks may exercise the all-DIRECT configuration;
- the six fixed service definitions map status 200–499 according to their configured expected range and classify timeout/DNS/TLS/5xx safely;
- external IP uses current rules and labels a concrete route/node only when ordered local matcher data proves it; an earlier rule-provider/GEOSITE/GEOIP/CIDR uncertainty falls back to «через mihomo · текущие правила»;
- maximum six operations run concurrently;
- per-operation timeout is five seconds and the overall 15-second deadline normalizes unfinished work as `timeout`;
- result duration/timestamps/count summary are deterministic;
- config reports `getSetting(db, "proxyEndpoint") || env.PROXY_ENDPOINT` without calling `getSettingsView`, so Diagnostics cannot create an unrelated HWID as a read side effect;
- raw exceptions, headers, secret, URL credentials/query, and trace body never occur in serialized output.

The fixed server-owned registry is exact and no browser-supplied URL reaches `probeThroughProxy`:

| id | URL | Accepted status |
|---|---|---|
| `google` | `https://www.google.com/generate_204` | `204` |
| `youtube` | `https://www.youtube.com/generate_204` | `204` |
| `telegram` | `https://telegram.org/favicon.ico` | `200–399` |
| `cloudflare` | `https://www.cloudflare.com/cdn-cgi/trace` | `200` |
| `chatgpt` | `https://chatgpt.com/favicon.ico` | `200–499` (a 401/403 still proves the routed network path) |
| `steam` | `https://store.steampowered.com/favicon.ico` | `200–399` |

Follow at most three redirects inside the same bounded probe and report the final status. A 5xx, DNS/TLS error, or timeout fails the service check.

- [ ] **Step 4: Implement the service in two phases**

Execution order:

```ts
const [submerge, mihomo, happ] = await Promise.all([
  checkSubmerge(),
  checkMihomoVersion(),
  checkHapp(),
]);

if (mihomo.status === "ok") {
  // Load channels + /proxies + /configs, derive real nodes, then run bounded
  // IP, route, and service work under the shared overall AbortSignal.
}
```

Use a local `mapLimit(items, 6, worker)` helper and `performance.now()` for durations. Convert errors to the stable error-code/copy table in one function; never return `error.message`.

Read the configured proxy address directly with `getSetting(db, "proxyEndpoint") || env.PROXY_ENDPOINT`; do not call `getSettingsView`, whose HWID initialization is unrelated to a diagnostic run.

Create `packages/server/src/version.ts` exporting `SUBMERGE_VERSION = "0.2.0"`. Replace the existing `health.ping` literal and use the same constant in Diagnostics so the two surfaces cannot drift.

- [ ] **Step 5: Add the protected query and singleton**

The router is thin:

```ts
export const diagnosticsRouter = router({
  run: protectedProcedure
    .input(diagnosticsRunInput)
    .query(({ input }) => diagnosticsService.run(input)),
});
```

Register it under `diagnostics` in `appRouter`. Router tests mock the singleton, verify default `force:false`, forced forwarding, auth protection through the normal middleware, and parsed result shape.

- [ ] **Step 6: Verify, review, and commit the server slice**

Run:

```bash
pnpm -F @submerge/server test -- src/modules/diagnostics/model.test.ts src/modules/diagnostics/service.test.ts src/modules/diagnostics/router.test.ts src/trpc/router.test.ts
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 2 with concurrency, cancellation, cache, routing non-mutation, result precedence, and redaction focus; resolve findings and rerun.

Commit:

```bash
git add packages/server/src/modules/diagnostics/model.ts packages/server/src/modules/diagnostics/model.test.ts packages/server/src/modules/diagnostics/service.ts packages/server/src/modules/diagnostics/service.test.ts packages/server/src/modules/diagnostics/router.ts packages/server/src/modules/diagnostics/router.test.ts packages/server/src/modules/diagnostics/singleton.ts packages/server/src/version.ts packages/server/src/trpc/router.ts packages/server/src/trpc/router.test.ts
git commit -m "feat(diagnostics): orchestrate bounded health checks" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Build the complete screen and retain results during refresh

**Files:**

- Create: `packages/web/src/features/diagnostics/view.ts`
- Create: `packages/web/src/features/diagnostics/view.test.ts`
- Create: `packages/web/src/features/diagnostics/DiagnosticsSections.tsx`
- Create: `packages/web/src/features/diagnostics/DiagnosticsSections.test.tsx`
- Create: `packages/web/src/features/diagnostics/DiagnosticsScreen.tsx`
- Create: `packages/web/src/routes/diagnostics.tsx`
- Modify: `packages/web/src/routes/tree.ts`
- Modify: `packages/web/src/components/nav.ts`

- [ ] **Step 1: Write failing view-format tests**

Add pure helpers for:

- `formatDiagnosticDuration(null) → "—"`, sub-millisecond → `"<1 мс"`, otherwise rounded `"84 мс"`;
- route/service pass counts excluding skipped;
- complete safe tooltip values;
- colour class mapping `ok/failed/skipped` and slow-success visual class without changing status;
- Russian state title/detail/badge copy for every server state plus client-only `running`.

Run:

```bash
pnpm -F @submerge/web test -- src/features/diagnostics/view.test.ts
```

Expected: FAIL because the helpers do not exist.

- [ ] **Step 2: Activate navigation and route**

Extend `NavLink.to` with `"/diagnostics"`, convert Diagnostics to a real `secondary: true` link so desktop shows it directly and mobile «Ещё» links to it, then register `/diagnostics` in the route tree.

- [ ] **Step 3: Implement query and forced-refresh behavior**

The initial query always calls the server cache boundary on mount:

```ts
const query = useQuery(
  trpc.diagnostics.run.queryOptions(
    { force: false },
    { staleTime: 0, refetchOnMount: "always", retry: false },
  ),
);
```

Create a `useMutation` whose `mutationFn` calls the raw tRPC client query with `{force:true}`. On success, write the result into the `{force:false}` query key. While pending, render `query.data` plus the running indicator; on first load with no data, render the checking skeleton/state. Disable «Проверить снова» while the deduplicated request is pending.

There is no interval/refetch timer. Server TTL remains authoritative.

- [ ] **Step 4: Build all approved sections**

`DiagnosticsSections.tsx` exports presentational blocks for:

- verdict header with text state, summary, completion time, and badge;
- External IP with IP/country/colo, route attribution, duration, safe failure/skipped copy;
- Components with exactly submerge/mihomo/happ-decoder rows and dividers;
- Routes with title/count inside the same bordered card, desktop Connections-style column header/rows, and compact mobile rows;
- Services as a dense list without per-row nested cards;
- Runtime config as a dense list without per-row nested cards.

Unknown runtime values show `—`. Long host/channel/node values use `min-w-0`, truncation, and full safe `title`. Status is conveyed by adjacent text in addition to colour. The route table uses `bg-surface` for the card and `bg-elevated` only for the desktop column header.

Add component tests for ready, running-with-previous-result, partial, mihomo-down/skipped dependents, no-nodes, no-internet, external-IP-only failure, unknown config, long values, and pass-count semantics.

- [ ] **Step 5: Verify, review, and commit the web behavior slice**

Run:

```bash
pnpm -F @submerge/web test -- src/features/diagnostics
pnpm verify:static
```

Expected: PASS. Invoke `/code-review` on Task 3 with result-retention, accessible status, table hierarchy, and design-system surface focus; resolve findings and rerun.

Commit:

```bash
git add packages/web/src/features/diagnostics/view.ts packages/web/src/features/diagnostics/view.test.ts packages/web/src/features/diagnostics/DiagnosticsSections.tsx packages/web/src/features/diagnostics/DiagnosticsSections.test.tsx packages/web/src/features/diagnostics/DiagnosticsScreen.tsx packages/web/src/routes/diagnostics.tsx packages/web/src/routes/tree.ts packages/web/src/components/nav.ts
git commit -m "feat(diagnostics): add self-check screen" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Match responsive Pencil states and run the final gate

**Files:**

- Modify: `packages/web/src/styles/responsive.css`
- Modify: `packages/web/e2e/fixtures.ts`
- Create: `packages/web/e2e/diagnostics-layout.spec.ts`
- Modify: `packages/web/e2e/layout-contract.spec.ts`
- Modify if review finds a defect: `packages/web/src/features/diagnostics/DiagnosticsScreen.tsx`
- Modify if review finds a defect: `packages/web/src/features/diagnostics/DiagnosticsSections.tsx`
- Modify if review finds a defect: `packages/server/src/modules/diagnostics/service.ts`

- [ ] **Step 1: Add sequential query fixtures for refresh**

Extend fixture overrides with an explicit sequence wrapper:

```ts
export function trpcFixtureSequence(...values: unknown[]) {
  return { fixtureSequence: values } as const;
}
```

`responseFor` consumes one value per call and retains the final value for later calls. Use it for `diagnostics.run` to prove initial snapshot → force refresh → replacement without a production test hook.

- [ ] **Step 2: Implement semantic container-query layouts**

Add `.responsive-page--diagnostics` rules:

- compact `<42rem`: one column, full-width refresh button, compact route rows, services/config dense lists, and «Ещё» active in bottom navigation;
- inline `≥42rem`: title/action share a row and paired cards use two columns only when values remain readable;
- data `≥48rem`: full desktop composition and Connections-style route columns;
- desktop column header is hidden below data while compact rows are hidden at/above data;
- page is the only vertical scroll owner; no route-table horizontal scroller below data.

- [ ] **Step 3: Add browser behavior/state tests**

`diagnostics-layout.spec.ts` covers:

- populated dark and light desktop at 1440×1024;
- populated mobile at 390;
- first-load running, refresh with old result retained, partial, mihomo down, no nodes, external IP unavailable, and no internet;
- dynamic route/service counts and skipped rows;
- force refresh changes completion/result only after response completes and disables duplicate clicks;
- full safe values on title/focus where text truncates;
- status text independent of colour;
- no overflow at 320/390/425/768/1024/1440 and changed app-page boundaries;
- bottom navigation does not cover the final config row.

Add `/diagnostics` to `layout-contract.spec.ts`.

Run with zero retries:

```bash
pnpm -F @submerge/web test:e2e -- diagnostics-layout.spec.ts layout-contract.spec.ts
pnpm verify:static
```

Expected: PASS.

- [ ] **Step 4: Capture visual evidence and run the final review**

Compare dark 1440×1024 to `QoRoZ`, light to `h9q7E`, mobile 390 to `BNOEr`, and all exceptional states to `pi7pQ`. Cross-check the route-table hierarchy against Connections `g5hb4`/`t9XUT`. Inspect internal scroll owners, long values, bottom-nav clearance, button focus, and every colour/status pairing. Record the evidence and resolved findings in the active plan.

Invoke `/code-review` on the entire Diagnostics feature across shared/server/web. Require explicit review of Zod boundaries, proxy-agent cleanup, no-node/Direct semantics, route non-mutation, concurrency/deadlines, cache/force races, redaction, state precedence, and visual fidelity. Resolve every finding and rerun Step 3.

- [ ] **Step 5: Commit the final Diagnostics slice**

```bash
git add packages/web/src/styles/responsive.css packages/web/e2e/fixtures.ts packages/web/e2e/diagnostics-layout.spec.ts packages/web/e2e/layout-contract.spec.ts packages/web/src/features/diagnostics/DiagnosticsScreen.tsx packages/web/src/features/diagnostics/DiagnosticsSections.tsx packages/server/src/modules/diagnostics/service.ts
git commit -m "test(diagnostics): verify responsive check states" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Do not push. Update spec/plan statuses only after the full feature is green and the user explicitly asks to ship.
