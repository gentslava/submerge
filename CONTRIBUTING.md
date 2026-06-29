# Contributing

Guide for developers and AI agents. Detailed agent rules: [AGENTS.md](AGENTS.md).

## Requirements

- Node **24 LTS**, pnpm, Docker (for happ-decoder/mihomo and builds).

## Getting started (v2)

```bash
pnpm install
pnpm -F @submerge/server db:generate   # generate migrations from schema (when db/schema.ts changes)
pnpm -F @submerge/server dev           # dev server
pnpm test                              # run tests
```

## Workflow

1. Pick a task from the plan (`docs/plans/`) — implementation proceeds in phases.
2. **TDD**: failing test → minimal implementation → green test.
3. Before committing — gates: `pnpm lint && pnpm typecheck && pnpm test`.
4. Atomic commits, conventional commits (`feat:`/`fix:`/`docs:`/`chore:`).
5. Significant architectural decision → ADR in `docs/adr/`.

## Boundaries

- External services (mihomo, happ-decoder) — only via `packages/server/src/clients/*`.
- Validate external service responses with Zod.
- Do not touch the PoC (`combine/`, `happ-decoder/`, `mihomo/`, root `docker-compose.yml`) until Phase 6.

## Documentation

- `docs/specs/` — what we build · `docs/plans/` — how · `docs/adr/` — why · `docs/architecture.md` — overview.
