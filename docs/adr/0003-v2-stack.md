# 0003 — v2 stack: React + tRPC + Drizzle/SQLite, SPA without SSR

**Status:** accepted (2026-06-29)

## Context

The PoC is written in bare Node + vanilla JS + single HTML — not maintainable at scale. We need a modern Node/TS stack: fast, polished UI, high quality, maintainable. The application is an interactive admin panel behind a password (no SEO, no anonymous first-paint), with real-time updates (nodes/pings/traffic).

## Decision

- **No SSR.** Panel behind a password → SSR/RSC solves non-existent problems and gets in the way of long-lived real-time connections. So not Next.js/Nuxt. Frontend — **SPA** (Vite + React 19).
- **tRPC v11** — end-to-end type safety without codegen (single repo, we own both ends).
- **Real-time** — SSE (tRPC subscription), not WebSocket (simpler and more reliable for a unidirectional stream behind a reverse proxy).
- **UI** — shadcn/ui + Tailwind v4 + TanStack Query/Router; charting stays dependency-free until a real data visualisation requires a dedicated library.
- **Monorepo** pnpm workspaces: `shared` / `server` / `web`.

React chosen over Svelte: for a self-hosted dashboard the Svelte runtime advantage is imperceptible, while ecosystem maturity, ready-made components, and AI code generation quality tip the scales.

## Consequences

- (+) Front↔back type safety, mature ecosystem, fast and polished UI.
- (+) One container serves static files + tRPC + SSE.
- (−) Split server/web requires shared types — solved by the `shared` package (Zod) + `AppRouter` export.
