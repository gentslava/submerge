# Connections screen — design

- **Date:** 2026-07-06
- **Status:** In progress · **Scope:** `packages/server` connections module + `packages/web` Соединения screen
- **Related:** [design-system.md](../design-system.md) frame `g5hb4` «Соединения — Indigo Console`; `docs/plans/README.md`

## Problem

The «Соединения» nav entry is an inert `СКОРО` placeholder. mihomo exposes live
connections at `/connections` (the same endpoint we already poll for cumulative
`getTotals`). Ship the screen from the approved mockup: a live table of active
connections with per-connection speed, the routing node, duration, and kill
actions.

## Data mapping — mihomo `/connections` → view

`GET /connections` returns `{ downloadTotal, uploadTotal, connections: [...] }`.
Each connection carries `id`, `metadata` (`network`, `host`, `destinationIP`,
`destinationPort`, `sourceIP`, `process`/`processPath`), cumulative `upload`/
`download` byte counters, `start` (ISO), and `chains` (proxy chain, `chains[0]`
is the actual outbound node).

| Column (mockup) | Source | Notes |
|---|---|---|
| **ИСТОЧНИК** | `metadata.process` → fallback `metadata.sourceIP` | mockup labelled it «ПРИЛОЖЕНИЕ»; renamed. In our server topology mihomo can't resolve the process of LAN devices proxied over SOCKS, so `process` is usually empty — fall back to the client's source IP. Honest: never a fake app name. |
| **НАЗНАЧЕНИЕ** | `metadata.host` \|\| `destinationIP`, + `:port` | 2-line cell (host on top, `ip:port` below). |
| **ТИП** | `metadata.network` | `tcp` / `udp`. Drives the Все/TCP/UDP filter. |
| **УЗЕЛ** | `chains[0]` | The proxy node the connection egresses through. Empty chain → `—`. |
| **СКОРОСТЬ** | Δ(`upload`+`download`) between polls | Per-connection speed. Computed **client-side** from consecutive snapshots keyed by `id` (server stays stateless). |
| **ВРЕМЯ** | `now − start` | Formatted duration (`3с`/`4м`/`1ч`). |
| **✕ / Разорвать все** | `DELETE /connections/:id` · `DELETE /connections` | Per-row and header kill. |
| Summary ↓/↑ МБ/с | existing live `traffic`/`totals` (`useLive`) | Reuse — no new plumbing. |
| Summary «N соединений» | `connections.length` | |
| Поиск | client-side filter | Over source + destination. |

The subtitle stays honest: «N активных» — drop the mockup's «весь трафик идёт
через X» (untrue under multi-channel routing; the УЗЕЛ column already shows the
per-connection node).

## Architecture

- **Server** — `clients/mihomo.ts`: `getConnections()` (Zod-parse the response,
  map to `ConnectionItem[]`), `closeConnection(id)`, `closeAllConnections()`.
  A thin `modules/connections/` = `service.ts` (map raw → view) + `router.ts`
  (`list` query, `close`/`closeAll` mutations, all `protectedProcedure`).
- **Web** — the screen owns a `connections.list` query with `refetchInterval`
  ~1.5 s (fetches only while the route is mounted — no bloat on the always-on
  SSE). Per-connection speed is derived on the client by diffing the previous
  snapshot's cumulative bytes (keyed by `id`) over the elapsed time. Kill actions
  invalidate the query.

Rationale: the connections list is view-only telemetry needed only when the
screen is open; a mounted-scope polled query isolates that cost, and client-side
speed deltas keep the server stateless (mirrors how the traffic chart already
derives rates from cumulative samples).

## Shared contract

`connectionItemSchema`: `{ id, source, dest, host, destIp, port, network:
"tcp"|"udp", node, up, down, start }` where `up`/`down` are **cumulative** bytes
(client derives speed). `connectionsViewSchema`: `{ connections:
ConnectionItem[] }`. Kill input: `{ id: string }`.

## Testing

- `getConnections` maps a real `/connections` fixture (process-empty case →
  source fallback; chains[0] node; tcp/udp).
- `closeConnection`/`closeAllConnections` hit the right method+path.
- Web: speed derivation (Δbytes/Δt keyed by id; a new/absent id → 0), duration
  formatter, TCP/UDP filter + search predicate.
- Visual gate: render at 1440×1024 dark, compare to `g5hb4`; check the 390 and
  md breakpoints for horizontal overflow (wide table → scroll container).

## Resolved decisions

1. **ИСТОЧНИК column** — `process` when present, else `sourceIP`; renamed from
   «ПРИЛОЖЕНИЕ». No faked app names.
2. **Polled query, not SSE** — mounted-scope `connections.list` + client speed
   deltas; server stateless.
3. **Summary speed reuses `useLive`** — no second traffic source.
