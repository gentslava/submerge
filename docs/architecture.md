# submerge v2 architecture

Overview for agents and developers. Full design: [docs/specs/2026-06-29-submerge-v2-stack-design.md](specs/2026-06-29-submerge-v2-stack-design.md).

```
┌──────────────── single Docker container: submerge ────────────────┐
│  web (React SPA)  ──tRPC query/mutation───┐                       │
│      ▲  tRPC subscription (SSE)           ▼                       │
│      └──────────────────────  server (Node 24 + TS)               │
│                               ├─ tRPC router (modules)            │
│                               ├─ Drizzle + SQLite (WAL)           │
│                               ├─ SSE hub (poll mihomo → fan-out)  │
│                               └─ clients/ (isolated, Zod)         │
└───────────────────────────────┬──────────────────┬────────────────┘
                           HTTP ↓ Clash API   HTTP ↓ /decode
                            mihomo (Go)        happ-decoder (Python)
```

## Layers and boundaries

- **shared** — the single contract: domain Zod schemas (Source, Proxy, Settings, Channel/ChannelPolicy, NodeView, LiveEvent, auth) and inferred types. Imported by both server and web.
- **server** — control plane. Feature modules (`sources`, `nodes`, `channels`, `settings`): `router.ts` (validation + dispatch) + `service.ts` (logic + Drizzle). `live/` holds the SSE hub, `auth/` the session auth (top-level, not a module). External services go through `clients/` only (mihomo, happ-decoder) with timeouts and Zod-validated responses. tRPC exports types to web without codegen.
- **web** — React SPA. tRPC client + TanStack Query (server state), dependency-free live metrics, shadcn/ui.
- **happ-decoder** (Python) and **mihomo** (Go) — external processes, reused from PoC unchanged.

## Data flows

- **Management** (add source, select node): web → tRPC mutation → server module → (parse / fetchSubscription / ingestHapp) → generate config.yaml → reload mihomo.
- **Node selection** (channel routing): a `ChannelController` per channel applies its policy — `speed` (latency race with switch tolerance), `sticky` (hold the node while healthy), `manual` (priority node) — on each probe tick, switches the mihomo selector when the policy says so, and records a decision log shown in Settings. Spec: [specs/2026-07-01-channel-routing-design.md](specs/2026-07-01-channel-routing-design.md).
- **Real-time** (nodes/pings/traffic): server SSE hub polls mihomo → fan-out via tRPC subscription (SSE) → web patches TanStack Query cache with targeted node updates.
- **Persistence**: sources/settings/channels/HWID/sessions — in SQLite (Drizzle). Nodes are not stored (live status from mihomo); per-source node snapshot in `sources.proxies`.

## Key decisions

See [docs/adr/](adr/): happ via official binary, X-Hwid per-source, stack choice, anti-overengineering.
