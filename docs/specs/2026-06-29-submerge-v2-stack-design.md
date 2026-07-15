# submerge v2 — new stack design

- **Date:** 2026-06-29
- **Status:** approved for implementation
- **Context:** rewriting the PoC (`combine` on bare Node + vanilla JS + single HTML) into a production-grade self-hosted application.

## 1. Goal and principles

Turn the working submerge PoC into a high-quality, fast, polished, and **maintainable** self-hosted application for managing VPN subscriptions, preserving the proven ingest/happ/HWID logic.

Principles:
- **No legacy at the start:** Node 24 LTS + all dependencies at their latest major versions, pinned in `pnpm-lock`.
- **Anti-overengineering:** minimal sufficient complexity for the scale of "one admin, dozens of sources, hundreds of nodes". No Postgres/GraphQL/Nx/hexagonal/DI/OTel.
- **Hard boundaries only where they pay off:** isolation of external services (mihomo, happ-decoder) with Zod-validated responses — the primary failure point.
- **End-to-end type safety** via tRPC + shared Zod schemas.

Scale: **self-hosted product**, single-admin (optional password), DB persistence, published on GitHub (everyone deploys their own instance).

## 2. Stack

**Common platform:** Node **24 LTS**, TypeScript (strict), pnpm workspaces, Biome (lint+format), Vitest + Playwright.

**server:** tRPC v11 · Drizzle ORM + SQLite (better-sqlite3, WAL) · Zod 4 · pino · session auth (@node-rs/argon2) · SSE hub for real-time.

**web:** Vite · React 19 · shadcn/ui (Radix) · Tailwind CSS v4 · TanStack Query v5 · TanStack Router v1 · react-hook-form + Zod · lucide-react · sonner · dark theme. Add a charting dependency only when a concrete visualisation needs it.

**Deploy:** Docker multi-stage (node:24-bookworm → slim, non-root), multiarch (amd64/arm64) buildx, single image `ghcr.io/gentslava/submerge`. GitHub Actions CI.

All versions are latest-major at install time; updates via pnpm, no pinning of outdated packages.

## 3. Architecture

```
┌──────────────── single Docker container: submerge ────────────────┐
│  web (React SPA, static)  ──tRPC query/mutation──┐                 │
│      ▲  tRPC subscription (SSE, real-time)        ▼                │
│      └────────────────────────────────  server (Node 24 + TS)     │
│                                          ├─ tRPC router (modules)  │
│                                          ├─ Drizzle + SQLite WAL   │
│                                          ├─ SSE hub (mihomo→fan)   │
│                                          └─ clients/ (isolated)    │
└───────────────────────────────┬──────────────────┬─────────────┘
                       HTTP ↓ Clash API       HTTP ↓ /decode
                        mihomo (Go)            happ-decoder (Python)
```

One container serves the static web SPA + `/trpc` (query/mutation + SSE subscription). mihomo and happ-decoder run alongside in `docker-compose` (unchanged). All communication with them goes exclusively through `server/clients/*` (timeouts, retries, Zod response parsing).

## 4. Monorepo structure (pnpm workspaces)

```
submerge/
├─ packages/
│  ├─ shared/    # domain Zod schemas + z.infer types — single front↔back contract
│  ├─ server/
│  │  └─ src/
│  │     ├─ db/         # drizzle schema, connection (WAL pragma), migrations/
│  │     ├─ trpc/       # init, context, procedure/middleware (auth, logging)
│  │     ├─ modules/    # sources/ nodes/ settings/ auth/ — router.ts + service.ts
│  │     ├─ clients/    # mihomo.ts, happDecoder.ts (HTTP + Zod validation)
│  │     ├─ sse/        # SSE hub: poll mihomo, fan-out
│  │     ├─ config/     # env.ts (Zod fail-fast on startup)
│  │     └─ index.ts    # HTTP server: static web + /trpc + /sse + /healthz
│  └─ web/
│     └─ src/{routes, components/ui (shadcn), features, lib (trpc/query), hooks}
├─ happ-decoder/        # as-is (Python)
├─ mihomo/              # starter config.yaml
├─ docker-compose.yml  Dockerfile  .github/workflows/ci.yml
└─ docs/specs/
```

A server module = thin `router.ts` (validation + dispatch) + `service.ts` (logic + Drizzle queries directly, no repositories). The `AppRouter` type is exported from server and imported in web as type-only.

## 5. Data model (SQLite + Drizzle)

- **`sources`**: `id, kind('sub'|'vless'|'happ'), value, label, hwid(bool, default false), enabled(bool, default true), sort_order, proxies(json snapshot), updated_at, created_at`
- **`settings`**: key-value (theme, mihomo secret, poll intervals, RU-direct routing on/off)
- **`sessions`**: `id, expires_at` (for optional auth)

Nodes are not stored separately: live status comes from mihomo; `sources.proxies` holds a snapshot for config generation without re-fetching (+ manual "refresh"). Driver on startup: `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000`. Backup — `VACUUM INTO` on schedule into a volume.

## 6. API contract (tRPC)

Routers:
- **`sources`**: `list`, `add(value, hwid?)`, `remove(id)`, `refresh(id)`, `toggle(id)`, `reorder(ids)`
- **`nodes`**: `list` (PROXY group from mihomo), `delay(name)`, `select(group, name)`
- **`settings`**: `get`, `set`
- **`auth`**: `login(password)`, `logout`, `me`
- **`live`** (subscription, tRPC over SSE): stream of `nodeUpdate / traffic / delay`

Inputs/outputs are Zod schemas from `shared`; the frontend gets types via tRPC inference (no codegen). External HTTP responses (mihomo/happ) must be `Zod.parse()`d.

## 7. Real-time data flow

The server holds a single **SSE hub**: it periodically polls mihomo (`/proxies`, `/connections`), normalizes the data, and fans out to tRPC `live` subscribers. Web: subscription → `queryClient.setQueryData` with a targeted patch per node name (no full table re-render). High-frequency traffic/ping metrics are throttled before rendering, bypassing the Query cache; add a charting dependency only when a concrete chart requires one. State is in-process memory (single admin; no Redis needed). Metrics window is bounded (windowing) to prevent memory leaks on long uptimes.

## 8. Migrating PoC logic (nothing is lost)

The following moves from the current `combine` into `server` with test coverage:
- `modules/sources`: `detectKind`, `parseVless`, `parseProxiesFromText` (clash-yaml / v2ray-vnext / sing-box / base64), `extractSubUrl` (client deep-links: incy/clash/sing-box/happ-add/…), `fetchSubscription(url, useHwid)` (per-source `X-Hwid` + `X-Device-Os`).
- `modules/nodes`: `config.yaml` generation (mixed-port, PROXY select + AUTO url-test, rules) + mihomo reload.
- `clients/happDecoder`: `ingestHapp(link, hwid)` → POST `/decode {link, hwid}` (decoder injects X-Hwid via mitmproxy itself).
- `clients/mihomo`: reload / proxies / select / delay.
- `shared`: Zod schemas for proxy/source/settings.

HWID: stable, shared (like the PoC `hwid.txt` or a settings string in the DB), per-source flag, off by default. happ-decoder and mihomo are unchanged.

## 9. Auth

Single-admin: password from env (Argon2id hash), on login sets an httpOnly+Secure+SameSite=Lax cookie with a signed session ID, sessions stored in SQLite (logout/revoke, survive restarts). Rate-limit on login (in-memory). **Off by default** (if no password set in env — UI is open; if set — login required). ~100 lines, no external auth library.

## 10. Deployment and tests

- **Dockerfile**: builder `node:24-bookworm` (pnpm install, compile better-sqlite3, build web+server) → runtime `node:24-bookworm-slim` (prod deps + dist + static, non-root). pnpm `deploy --filter`. Not distroless (native module).
- **Multiarch**: buildx amd64+arm64, native arm64 runners in CI, smoke test on each arch.
- **CI** (GitHub Actions): `biome ci` → `tsc --noEmit` → `vitest run` → (Playwright on main) → buildx push to GHCR.
- **Tests**: Vitest — unit tests for parsers/ingest (porting PoC checks to test cases) + integration with SQLite `:memory:`; Playwright — critical paths (login, add source, select node). Strict TS (`noUncheckedIndexedAccess` etc.).
- **Observability**: pino (request-id, separate log for outbound calls to mihomo/happ with latency), `/healthz` + `/readyz`, graceful shutdown (SIGTERM → close server + db).

## 11. Phasing

The PoC in `~/Developer/submerge` stays operational. v2 is built in the same repo (monorepo structure), happ-decoder is reused as-is. We switch `docker-compose` to the new `submerge` service once v2 passes the smoke test. The old `combine` is removed after the switch.

## 12. Out of scope (YAGNI)

Multi-tenancy/roles, OAuth/2FA, Postgres, GraphQL, Nx/Turborepo, hexagonal/CQRS, OpenTelemetry/Prometheus, mobile app. May return later as separate specs: incy-specific formats (if needed), RU-direct/tun-mode routing for prod, metrics.
