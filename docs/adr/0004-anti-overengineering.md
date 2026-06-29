# 0004 — Minimal sufficient complexity

**Status:** accepted (2026-06-29)

## Context

The application's scale is small and fixed: **one admin, dozens of sources, hundreds of nodes**, single instance. The temptation to lay in a "scalable enterprise architecture" would make maintenance harder, not easier — directly against the project's goal.

## Decision

We deliberately choose simple options and say "no" to the unnecessary:
- **DB:** SQLite (WAL) + Drizzle. **Not** Postgres/libsql/Turso (no multi-tenancy/replicas).
- **API:** tRPC. **Not** GraphQL (one client, one schema).
- **Monorepo:** pnpm workspaces (3 packages). **Not** Nx/Turborepo (their cache/graph don't pay off at 3 packages).
- **Server structure:** feature modules (`router.ts`+`service.ts`), direct Drizzle queries. **Not** hexagonal/CQRS/event-sourcing/DI container/repositories.
- **Observability:** pino + health checks. **Not** OpenTelemetry/Prometheus at the start.
- **Auth:** hand-rolled session (argon2) for a single admin. **Not** heavy auth frameworks; do not use Lucia (maintenance mode).

The one deliberate "hardening": **strict isolation and Zod-validated responses for external services** (mihomo, happ-decoder) — the real failure point.

## Consequences

- (+) Minimal moving parts, easy to hold in your head and maintain (including for AI agents).
- (+) Backup = copy the SQLite file; deploy = single image.
- (−) If the project ever grows into multi-tenancy, a revision will be needed — but that will be a new spec, not anticipated complexity now.
