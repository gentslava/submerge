# AGENTS.md — submerge

Instructions for AI agents working on this project. Read by Claude Code, Cursor, Copilot, etc. Nested `AGENTS.md` files inside packages override this one for their scope.

## What this project is

**submerge** — a self-hosted web app for managing VPN subscriptions (client role). It ingests node sources (subscription URLs, single-node links, `happ://`, WireGuard/AmneziaWG configs, client deep-links), parses nodes, generates a config for the **mihomo** (Clash) engine and controls it over the REST API, shows nodes with real-time latency/traffic, keeps the best node active via channel policies (see Domain facts), and exposes a local SOCKS/HTTP proxy.

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

Dependencies use caret ranges at the latest major (e.g. `^19.2.7`), resolved exactly via `pnpm-lock.yaml`; Dependabot PRs keep them current, including majors. **No legacy at the start.**

## Structure (target, v2)

```
packages/shared/   # Zod schemas + types — the front↔back contract
packages/server/   # tRPC, Drizzle, clients/ (mihomo, happ-decoder), modules/ (sources,nodes,channels,settings), live/ (SSE hub), auth/
packages/web/      # React SPA
docs/{specs,plans,adr,architecture.md}
```

A server module = thin `router.ts` (validation + call) + `service.ts` (logic + Drizzle directly). No repositories/DI.

## Commands (v2)

```bash
pnpm install                            # install
pnpm dev:infra                          # isolated mihomo + happ-decoder sidecars
pnpm dev:server                         # host API, loopback :3000 by default
pnpm dev:web                            # Vite :5173, proxies /trpc to :3000
pnpm test                               # all tests (vitest)
pnpm typecheck                          # tsc -b (server/shared) + tsc --noEmit (web)
pnpm lint                               # biome ci .
pnpm format                             # biome format --write .
pnpm -F @submerge/server db:generate    # generate migration from schema
pnpm -F @submerge/web design:tokens      # sync index.css color tokens from pencil/web-ui.pen
```

Server runs `.ts` via `tsx` (Node 24 strip-types does not remap `.js`→`.ts` specifiers in nodenext mode). Deploy: `docker compose up -d` pulls the GHCR images (built by `.github/workflows/docker.yml` on push to master) for `submerge` + `happ-decoder`, plus `mihomo`; the UI is at `http://127.0.0.1:3000`.

## Deploy

- **Config via `.env`**: compose interpolates `ADMIN_PASSWORD`, `COOKIE_SECURE`, `MIHOMO_SECRET`, and `SUBMERGE_BIND` from a git-ignored `.env` next to `docker-compose.yml` (template: `.env.example`). Built-in defaults keep the localhost case working with no `.env`. **Internet-facing deploy = copy `.env.example` → `.env`, set a strong `ADMIN_PASSWORD` + `COOKIE_SECURE=true`, and front the loopback-bound `:3000` with a TLS reverse-proxy.**
- **`COOKIE_SECURE`**: behind TLS set `COOKIE_SECURE=true`. Do **not** leave it blank — `z.stringbool()` rejects `""` and the server won't boot. The compose default is `"false"` (plain HTTP on localhost). `ADMIN_PASSWORD` is optional (auth is off when unset — leave empty only for trusted localhost).
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
- **Match the control, don't downgrade it.** The mockup's *interaction* is spec, not just its box: segmented stays segmented (not a dropdown), a preset dropdown stays a dropdown (not a free-text input), editable stays editable (not read-only), a switch stays a switch (not an omitted row); units go in the label (`Допуск, мс`), not trailing the input. Read the control *type* from the mockup like you read a color. Silently swapping a richer control for a simpler one is a control-logic regression — the repeat failure that diverged Settings from the frame even when pixels looked close.
- **Behavior, not just looks.** Controls must work — no dead buttons or decorative tabs. If the engine genuinely can't back a control, that's a product decision: raise it, don't silently fake or drop it.
- **Honesty over fidelity.** Don't render data we don't have (fake quotas/totals) — show the real value or omit it, and say why.

## Workflow — the development flow

Every change moves through these stages. Gates marked **⛔** are mandatory and **block progression** — do not advance (or offer to) until the current gate is green. Trivial, mechanical edits (typo, one-line fix, rename) may skip to *Implement*; anything that adds or changes behavior runs the whole flow.

### Executable UI evidence

- Browser tests use populated fixtures and cover relevant empty/error/collapsed states.
- Responsive tests inspect `html`, `.app-main`, and `.responsive-page` at
  320/390/425/768/1024/1440 plus any changed container-query boundary.
- Popup tests cover both placements, hidden chrome, outside press, Escape, focus return,
  and separation between the trigger and destructive actions.
- Browser gates run with zero retries. Record the Pencil frame, viewport/theme,
  screenshot, risky states, reviewer, and resolved findings in the active plan.

**Review runs at two scales — both required, they see different things.** The *incremental* review (2c) looks **narrow and deep** at one slice while the context is fresh; the *final* review (stage 3) looks **wide** across the whole feature for integration and coherence. Trees vs. forest — neither replaces the other.

1. **Spec / design** — for a new feature or behavior change, agree the approach first (no code without a spec). Specs live in `docs/specs/`, phased plans in `docs/plans/`. Check current library APIs via **Context7 MCP** (Zod 4, tRPC v11, Drizzle, React 19) — versions are latest, the API may have shifted.

2. **Implement — the slice loop.** Build in small vertical slices; repeat per slice:
   - **a. TDD** — failing test first, then the minimal code to pass. Cover parsing/ingest logic with unit tests. Follow the conventions and design-system gates above (tokens-in-config, measure don't invent).
   - **b. ⛔ Self-verify** — `pnpm verify:static` plus focused browser evidence is green. The script invokes raw repository-wide Biome (the rtk hook can mask `pnpm lint`'s exit code), token drift checks, typecheck, tests, and production builds. **Green gates ≠ correct**: they don't see layout/visual/responsive/behavior — check those yourself for the slice.
   - **c. ⛔ Incremental review** — run `/code-review` on *this slice's* diff (narrow, deep; lighter effort is fine here): correctness, and does it fit the conventions + design system. Cheap and early — catches issues before they compound across later slices. An author self-read is **not** this gate — actually invoke the review.
   - **d. Commit** — atomic, conventional (`feat:`, `fix:`, `chore:`, `docs:`), body ending `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Keep slices small so each review stays narrow.

3. ⛔ **Final review** — once the feature is complete, review the **whole change as one** (wide scope): integration between slices, cross-cutting concerns, coherence, regressions one slice introduced against another, plus the full UI sweep — mockup viewport (1440×1024, dark) **and** 320/390/425/768/1024/container-boundary widths, checking internal scroll owners, horizontal overflow, and clipped/misaligned controls; for logic, the risky states (populated / empty / error / collapsed), not just the happy path. Run `/code-review` (an independent adversarial pass — actually invoke the skill, don't substitute an author read) and resolve findings **before offering to ship, before committing the finished feature, and before any push**. This is a gate you run **yourself, unprompted** — it is never something the user has to ask for ("ты ревью запускал?" means the gate was already missed). If the user ever has to ask, the process failed.

4. ⛔ **Ship** — **a push to `master` is a production deploy**: it triggers GHA (`.github/workflows/docker.yml`) → multiarch images → Dokploy pulls the fresh `:latest`. **Precondition: the stage-3 `/code-review` has run and its findings are resolved.** Pushing before review — or running only a self-review instead of the skill — is a gate violation, not a shortcut. Commit/push only when the user asks — this is a shared, deploy-triggering repo.

5. ⛔ **Verify in prod** — confirm the change is actually live and correct on the deployed instance. "Deployment queued" is not "done": load the running site and check the change.

## Do not

- Don't pin outdated versions "for compatibility" — stay on the latest major (caret ranges + Dependabot bumps; never a `"latest"` range, which lets lockfile regeneration jump majors silently).
- Don't commit secrets/runtime: `mihomo/config.yaml` (nodes), `*/sources.json`, `hwid.txt`, `.env`, `data/*.db` — all in `.gitignore`.
- Don't overengineer (see ADR-0004).

## Domain facts (don't re-discover)

- **happ://crypt5** links are decoded by the official Happ binary (Qt) in the `happ-decoder` sidecar (Xvfb + mitmproxy intercepts the decoded sub-URL). Static reverse decoders (LeeeeT) go stale due to key rotation — see ADR-0001.
- **X-Hwid** is a per-source flag (off by default): device-bound providers return a stub without it. For https subscriptions the server sends it; for happ the mitmproxy injects it. See ADR-0002.
- **Source kinds** (`sourceKindSchema`, 10): `sub` (clash-yaml / base64 / v2ray & sing-box JSON subscriptions), `happ`, single-node links `vless` / `vmess` / `trojan` / `ss` / `hysteria2` / `tuic`, and `wireguard` / `amneziawg` (`.conf` files + Amnezia `vpn://`). Client deep-links (incy/clash/sing-box/…) wrap a URL, extracted by `extractSubUrl`. Type auto-detected by `detectKind`.
- **Channel routing**: the active node is managed by a `ChannelController` (`modules/channels/`) per channel with a policy — `speed` (latency race with tolerance), `sticky` (hold node while healthy), `manual` (priority node) — and a decision log surfaced in Settings. Spec: [docs/specs/2026-07-01-channel-routing-design.md](docs/specs/2026-07-01-channel-routing-design.md).
- mihomo is the tunneling engine (Go), controlled via the Clash REST API.

## Documentation map

- `docs/specs/` — specifications (what we build); status index in its `README.md`.
- `docs/plans/` — phased implementation plans (how we build, bite-sized tasks); status index in its `README.md` — keep it updated when a plan ships.
- `docs/adr/` — accepted architecture decisions and why.
- `docs/architecture.md` — v2 architecture overview.
- `docs/design-system.md` — the Indigo Console design contract (tokens, component specs, frame map, visual gates).
