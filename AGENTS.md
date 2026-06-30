# AGENTS.md — submerge

Instructions for AI agents working on this project. Read by Claude Code, Cursor, Copilot, etc. Nested `AGENTS.md` files inside packages override this one for their scope.

## What this project is

**submerge** — a self-hosted web app for managing VPN subscriptions (client role). It ingests node sources (subscription URLs, `vless://`, `happ://`, client deep-links), parses nodes, generates a config for the **mihomo** (Clash) engine and controls it over the REST API, shows nodes with real-time latency/traffic, lets you pick the active node, and exposes a local SOCKS/HTTP proxy.

Audience: **self-hosted product**, single-admin (optional password), deployed via docker compose.

## Repository status (important)

- **v2 (shipped):** `packages/` — the application, served from the `submerge` Docker container (React SPA + tRPC/SSE + `/healthz` from one process). Spec: [docs/specs/2026-06-29-submerge-v2-stack-design.md](docs/specs/2026-06-29-submerge-v2-stack-design.md). Plans: `docs/plans/`.
- **PoC (removed):** the old `combine/` (Node + vanilla JS) has been removed; its behavior is fully ported into `packages/server` modules. `happ-decoder/` (Python) and `mihomo/` (Go) remain as reused sidecars.

## Language

- **Documentation, code comments, and commit messages — English.**
- UI-facing strings are currently Russian; i18n is out of scope for now (don't mass-translate the UI).

## Stack (v2)

Node **24 LTS**, strict TypeScript, pnpm workspaces, Biome, Vitest/Playwright.
- **server**: tRPC v11 · Drizzle ORM + SQLite (better-sqlite3, WAL) · Zod 4 · pino · session auth (@node-rs/argon2) · SSE hub.
- **web**: Vite · React 19 · shadcn/ui · Tailwind v4 · TanStack Query/Router · uPlot · lucide-react · sonner.
- **shared**: domain Zod schemas + inferred types (single contract).

All dependencies are latest major at install time, pinned via `pnpm-lock.yaml`. **No legacy at the start.**

## Structure (target, v2)

```
packages/shared/   # Zod schemas + types — the front↔back contract
packages/server/   # tRPC, Drizzle, SSE, clients/ (mihomo, happ-decoder), modules/ (sources,nodes,settings,auth)
packages/web/      # React SPA
docs/{specs,plans,adr,architecture.md}
```

A server module = thin `router.ts` (validation + call) + `service.ts` (logic + Drizzle directly). No repositories/DI.

## Commands (v2)

```bash
pnpm install                            # install
pnpm -F @submerge/server dev            # dev server
pnpm test                               # all tests (vitest)
pnpm typecheck                          # tsc -b --noEmit
pnpm lint                               # biome ci .
pnpm format                             # biome format --write .
pnpm -F @submerge/server db:generate    # generate migration from schema
pnpm -F @submerge/web design:tokens      # sync index.css color tokens from pencil/web-ui.pen
```

Server runs `.ts` via `tsx` (Node 24 strip-types does not remap `.js`→`.ts` specifiers in nodenext mode). Deploy: `docker compose up -d --build` brings up `mihomo` + `submerge` + `happ-decoder`; the UI is at `http://127.0.0.1:3000`.

## Deploy

- **`COOKIE_SECURE`**: behind TLS set `COOKIE_SECURE=true` on the `submerge` service. Do **not** leave it blank — `z.stringbool()` rejects `""` and the server won't boot. The compose default is `"false"` (plain HTTP on localhost). `ADMIN_PASSWORD` is optional (auth is off when unset).
- **mihomo config write (uid 999)**: the `submerge` container runs as a non-root user (uid 999) and writes the shared mihomo config to the bind-mounted `./mihomo`. On **Linux hosts** the bind mount keeps host ownership, so `./mihomo` must be writable by uid 999 — e.g. `chown -R 999:999 mihomo` (or add a matching `user:` override to the service). On Docker Desktop (Mac/Windows) this is automatic.

## Conventions

- **Strict TS** (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). ESM, `verbatimModuleSyntax`.
- **Formatting/linting — Biome** (not ESLint/Prettier). Run before committing.
- **Validation:** Zod at boundaries. **Responses from external services (mihomo, happ-decoder) MUST be `.parse()`d** — that's the main failure point.
- **Boundaries:** all interaction with mihomo/happ-decoder goes only through `packages/server/src/clients/*` (timeouts, retries, Zod). Don't call them over HTTP directly from modules.
- **Naming:** camelCase (TS), kebab-case (files), snake_case for DB tables/columns (mapped in schema.ts).
- **Anti-overengineering:** for the scale "one admin, dozens of sources, hundreds of nodes" do NOT introduce Postgres, GraphQL, Nx/Turborepo, hexagonal/CQRS/DI, OpenTelemetry. See ADRs.

## Design system & visual fidelity (web)

The approved UI is the **Indigo Console** design in [`pencil/web-ui.pen`](pencil/web-ui.pen) — a plain JSON mockup, **tracked in git**, that is the **visual source of truth**. Full contract (token table, component specs, frame map): [docs/design-system.md](docs/design-system.md).

- **Tokens first, in config.** Colors/radii/fonts/type-scale live in `packages/web/src/index.css` `@theme`, mirrored from the mockup's `variables`. Never hand-pick a hex/px — use a token.
- **Measure, don't invent.** Read exact values from the mockup (Pencil MCP `batch_get … resolveVariables:true`, or the JSON directly). Don't fill visual gaps with generic defaults (gradients, `rounded-2xl`, oversized padding) — that "AI look" is the failure mode that produced the first, rejected UI.
- **Visual fidelity is a gate.** Before a UI task is done: render at the mockup viewport (**1440×1024, dark**), screenshot, and compare element-by-element to the frame; cross-check exact values with `browser_evaluate`. Verifying at the wrong viewport gives false conclusions.
- **Behavior, not just looks.** Controls must work — no dead buttons or decorative tabs. If the engine can't back a control, don't draw it.
- **Honesty over fidelity.** Don't render data we don't have (fake quotas/totals) — show the real value or omit it, and say why.

## Workflow

- **TDD**: failing test first, then minimal implementation. Cover parsing/ingest logic with unit tests.
- **Frequent atomic commits**, conventional commits (`feat:`, `fix:`, `chore:`, `docs:`). End the body with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Pre-commit gates:** `pnpm lint && pnpm typecheck && pnpm test` — green.
- Before using libraries, check the current API via **Context7 MCP** (Zod 4, tRPC v11, Drizzle, React 19) — versions are latest, the API may have changed.

## Do not

- Don't pin outdated versions "for compatibility" — use latest.
- Don't commit secrets/runtime: `mihomo/config.yaml` (nodes), `*/sources.json`, `hwid.txt`, `.env`, `data/*.db` — all in `.gitignore`.
- Don't overengineer (see ADR-0004).

## Domain facts (don't re-discover)

- **happ://crypt** is decoded by the official Happ binary (Qt) in the `happ-decoder` sidecar (Xvfb + mitmproxy intercepts the decoded sub-URL). Static reverse decoders (LeeeeT) go stale due to key rotation — see ADR-0001.
- **X-Hwid** is a per-source flag (off by default): device-bound providers return a stub without it. For https subscriptions the server sends it; for happ the mitmproxy injects it. See ADR-0002.
- Subscription formats: clash-yaml, base64-vless, v2ray/sing-box JSON. Client deep-links (incy/clash/sing-box/…) wrap a URL, extracted by `extractSubUrl`.
- mihomo is the tunneling engine (Go), controlled via the Clash REST API.

## Documentation map

- `docs/specs/` — specifications (what we build).
- `docs/plans/` — phased implementation plans (how we build, bite-sized tasks).
- `docs/adr/` — accepted architecture decisions and why.
- `docs/architecture.md` — v2 architecture overview.
- `docs/design-system.md` — the Indigo Console design contract (tokens, component specs, frame map, visual gates).
