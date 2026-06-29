# Architecture Decision Records

Short records of accepted architectural decisions and their rationale. Format: Context → Decision → Consequences. Goal: prevent agents and developers from re-discovering what has already been decided.

When a new significant decision is made, add a file `NNNN-short-name.md` with the next number and a line in the index below.

## Index

- [0001](0001-happ-via-official-binary.md) — Decoding happ:// via the official Happ binary, not a static reverse decoder
- [0002](0002-hwid-per-source.md) — X-Hwid as a per-source option (off by default)
- [0003](0003-v2-stack.md) — v2 stack: React + tRPC + Drizzle/SQLite, SPA without SSR
- [0004](0004-anti-overengineering.md) — Minimal sufficient complexity (SQLite, pnpm monorepo, no Postgres/Nx/hexagonal)
