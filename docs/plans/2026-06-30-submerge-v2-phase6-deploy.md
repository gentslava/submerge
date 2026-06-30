# Phase 6 — Deploy (serve web from server + Docker + compose switch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v2 as a single self-hosted container — the server serves the built React SPA + `/trpc` (queries/mutations + SSE) + `/healthz` from one process. A multi-stage Dockerfile builds web+server (native modules included); `docker-compose` switches from the PoC `combine` to the new `submerge` service alongside the unchanged `mihomo` + `happ-decoder`; the old `combine/` is removed after the stack smoke-tests green.

**Architecture:** The server's `createServer` handler already routes `/healthz` and `/trpc`; add a static branch that serves the web `dist` (assets by content-type, SPA fallback to `index.html` for client routes). The web's tRPC client already uses the relative `/trpc` URL, so same-origin serving needs no web change (the Vite dev proxy was dev-only). Dockerfile: `node:24-bookworm` builder (pnpm install with native compile for `better-sqlite3`, `pnpm -r build`, `pnpm --filter @submerge/server deploy --prod`) → `node:24-bookworm-slim` runtime (pruned server + web dist, non-root, `node dist/index.js`). Compose: `submerge` builds from the repo-root Dockerfile, mounts `./mihomo` + a DB volume, env-wires mihomo/happ-decoder + `COOKIE_SECURE=true`.

**Tech Stack:** Node 24, Docker multi-stage, pnpm `deploy --prod`, `node:http` static serving, existing `tsc -b`→`dist` emit (`server/dist/index.js`).

**Scope notes / decisions (locked):**
- **The "don't touch PoC" rule lifts here** (Phase 6). We edit the root `docker-compose.yml` and remove `combine/`. `happ-decoder/` and `mihomo/` are KEPT (reused as-is).
- `tsc -b` emits runnable JS (`outDir: dist`, `composite`) — prod runs `node dist/index.js`, NOT tsx. Verified: `server/dist/index.js` + `shared/dist/*.js` exist.
- `@node-rs/argon2` ships prebuilt binaries (no compile); `better-sqlite3` compiles from source (builder needs `python3 make g++`). `pnpm-workspace.yaml` already allows the `better-sqlite3` build.
- **Per Phase-5 security audit:** the compose MUST set `COOKIE_SECURE=true` behind TLS and MUST NOT introduce permissive CORS. `ADMIN_PASSWORD` stays optional (auth off by default).
- CI (GitHub Actions: biome→tsc→vitest) is a small bonus in the gate task. Multiarch buildx/GHCR push is left as a documented follow-up (the Dockerfile is arch-agnostic; the user wires registry push in their deploy/Dokploy).

---

## File structure

```
packages/server/src/
  config/env.ts            # + WEB_DIST (path to the built SPA; default for dev)
  static.ts                # NEW — pure helpers: contentTypeFor, safeResolve (no traversal)
  static.test.ts           # NEW
  index.ts                 # + static SPA branch (GET non-/trpc non-/healthz → file | index.html)

Dockerfile                 # NEW (repo root) — multi-stage builder→runtime
.dockerignore              # NEW
docker-compose.yml         # replace `combine` service with `submerge`
.github/workflows/ci.yml   # NEW (bonus) — biome ci + tsc + vitest

combine/                   # REMOVED (Task 4)
AGENTS.md, docs/           # updated: combine → submerge (Task 4)
```

---

### Task 1: Server serves the SPA (static files + SPA fallback)

**Files:**
- Modify: `packages/server/src/config/env.ts`, `packages/server/src/index.ts`
- Create: `packages/server/src/static.ts`, `packages/server/src/static.test.ts`

- [ ] **Step 1: `env.ts`** — add `WEB_DIST` (where the built SPA lives). Default to the monorepo dev path so `pnpm dev` can serve it too if built:
```ts
WEB_DIST: z.string().default("../web/dist"),
```

- [ ] **Step 2: failing test** `packages/server/src/static.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { contentTypeFor, safeResolve } from "./static.js";

describe("static helpers", () => {
  it("maps extensions to content types", () => {
    expect(contentTypeFor("/assets/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/assets/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/x.unknown")).toBe("application/octet-stream");
  });

  it("resolves a url path under the dist dir", () => {
    expect(safeResolve("/dist", "/assets/app.js")).toBe("/dist/assets/app.js");
    expect(safeResolve("/dist", "/")).toBe("/dist/index.html"); // root → index
  });

  it("blocks path traversal", () => {
    expect(safeResolve("/dist", "/../etc/passwd")).toBeNull();
    expect(safeResolve("/dist", "/..%2f..%2fetc/passwd")).toBeNull();
    expect(safeResolve("/dist", "/assets/../../secret")).toBeNull();
  });
});
```

- [ ] **Step 3: run → FAIL.**

- [ ] **Step 4: implement `static.ts`:**
```ts
import { resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

// Resolve a request path to an absolute file under distDir, or null if it would
// escape distDir (path traversal). "/" maps to index.html.
export function safeResolve(distDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  if (decoded === "/" || decoded === "") decoded = "/index.html";
  const base = resolve(distDir);
  // Prefix with "." so the path is relative; resolve() then climbs above base
  // for any ".." segment, which the startsWith guard below rejects.
  const target = resolve(base, `.${decoded}`);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}
```

- [ ] **Step 5: run → PASS.**

- [ ] **Step 6: wire `index.ts`** — after the `/healthz` and `/trpc` branches, before the 404, add a static branch (only for GET/HEAD). Read the file from `WEB_DIST`; on miss, fall back to `index.html` (SPA client routing). Use `node:fs`:
```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contentTypeFor, safeResolve } from "./static.js";

const WEB_DIST = resolve(env.WEB_DIST);
const INDEX_HTML = resolve(WEB_DIST, "index.html");

// … inside the request handler, after the /trpc branch:
if (req.method === "GET" || req.method === "HEAD") {
  void serveStatic(url, res);
  return;
}
res.writeHead(404);
res.end("not found");

// helper (module scope):
async function serveStatic(url: string, res: ServerResponse): Promise<void> {
  const file = safeResolve(WEB_DIST, url);
  try {
    if (file) {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": contentTypeFor(file) });
      res.end(body);
      return;
    }
  } catch {
    /* fall through to index.html (SPA route) */
  }
  try {
    const html = await readFile(INDEX_HTML);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}
```
Import `ServerResponse` type from `node:http`. Keep the `/healthz` + `/trpc` branches exactly as they are (static must NOT shadow them). Note: assets fall through to `index.html` only when the file is missing — a real missing asset returns the SPA HTML (acceptable; the SPA shows a 404 route or the asset 404s in practice rarely matters).

- [ ] **Step 7: gates + manual check** — `pnpm -F @submerge/server test` green (+3 static); `pnpm typecheck` clean; biome `EXIT=0`. Build the web (`pnpm -F @submerge/web build`) then run `WEB_DIST=packages/web/dist pnpm -F @submerge/server dev` and `curl localhost:3000/` → returns the SPA `index.html`; `curl localhost:3000/sources` → also index.html (SPA fallback); `curl localhost:3000/healthz` → `{"ok":true}`; `curl localhost:3000/trpc/auth.me` → JSON (not HTML). Stop it.

- [ ] **Step 8: commit:**
```bash
git add packages/server/src/static.ts packages/server/src/static.test.ts packages/server/src/index.ts packages/server/src/config/env.ts
git commit -m "$(printf 'feat(server): serve the web SPA (static + index.html fallback) from the server\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Dockerfile (multi-stage) + .dockerignore

**Files:** Create `Dockerfile`, `.dockerignore` (repo root). Requires Docker.

- [ ] **Step 1: `.dockerignore`:**
```
**/node_modules
**/dist
.git
.github
combine
happ-decoder
mihomo
data
docs
pencil
*.md
**/*.test.ts
.playwright-mcp
```

- [ ] **Step 2: `Dockerfile`:**
```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-bookworm AS builder
WORKDIR /app
RUN corepack enable
# native build deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json biome.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# prune to a self-contained server (bundles @submerge/shared + prod node_modules)
RUN pnpm --filter @submerge/server deploy --prod /app/deploy

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app app
COPY --from=builder /app/deploy ./
COPY --from=builder /app/packages/web/dist ./web
RUN mkdir -p /app/data && chown -R app:app /app/data
ENV NODE_ENV=production
ENV PORT=3000
ENV WEB_DIST=/app/web
ENV DB_PATH=/app/data/submerge.db
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
```
> Verify during build: (a) `pnpm --filter @submerge/server deploy --prod /app/deploy` produces `/app/deploy/dist/index.js` + a `node_modules` containing the compiled `better-sqlite3`, `@node-rs/argon2`, and the bundled `@submerge/shared` runtime JS (shared's `package.json` must expose its `dist`/`exports` for runtime — confirm `node dist/index.js` resolves `@submerge/shared`). If `deploy` doesn't lay it out as `/app/deploy/dist/index.js`, adjust the `CMD`/paths to the actual layout. (b) The runtime base `bookworm-slim` matches the builder `bookworm` glibc so the compiled `better-sqlite3` binary loads. If `deploy --prod` strips `dist` (it shouldn't — `dist` is shipped via the package `files`/default), ensure the server `package.json` includes `dist` so deploy copies it.

- [ ] **Step 3: build the image** — `docker build -t submerge:dev .` → succeeds (report build time; the better-sqlite3 compile is the slow step).

- [ ] **Step 4: run the container standalone** (no mihomo → it'll log health:false, that's fine) and smoke the served app:
```bash
docker run --rm -d --name submerge-smoke -p 3001:3000 submerge:dev
sleep 3
curl -s localhost:3001/healthz                 # {"ok":true}
curl -s localhost:3001/ | grep -o '<title>[^<]*'   # SPA HTML served
curl -s localhost:3001/trpc/auth.me            # {"authed":true,"required":false} (auth off)
docker logs submerge-smoke | tail -5            # "submerge server on :3000", no crash
docker rm -f submerge-smoke
```
Confirm: HTTP server up, SPA HTML at `/`, tRPC at `/trpc`, no native-module load error in logs. If the container exits/crashes (e.g. better-sqlite3 ABI mismatch, missing dist, or DB path not writable), STOP and report the log.

- [ ] **Step 5: commit:**
```bash
git add Dockerfile .dockerignore
git commit -m "$(printf 'feat(deploy): multi-stage Dockerfile (build web+server, slim non-root runtime)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: docker-compose — switch `combine` → `submerge`

**Files:** Modify `docker-compose.yml`.

- [ ] **Step 1: replace the `combine` service** with `submerge` (keep `mihomo` + `happ-decoder` unchanged):
```yaml
  submerge:
    build:
      context: .
      dockerfile: Dockerfile
    image: ghcr.io/gentslava/submerge:latest
    container_name: submerge
    restart: unless-stopped
    environment:
      MIHOMO_API: "http://mihomo:9090"
      MIHOMO_SECRET: "poc"
      HAPP_DECODER_URL: "http://happ-decoder:8080"
      # Auth is off unless ADMIN_PASSWORD is set. Behind TLS, set COOKIE_SECURE=true.
      # ADMIN_PASSWORD: "change-me"
      COOKIE_SECURE: "false"
    volumes:
      - ./mihomo:/mihomo            # shared config + hwid.txt (server writes config.yaml)
      - submerge-data:/app/data     # persistent SQLite DB
    ports:
      - "127.0.0.1:3000:3000"       # v2 web UI + /trpc
    depends_on:
      - mihomo
      - happ-decoder

volumes:
  submerge-data:
```
> `MIHOMO_CONFIG_PATH`/`HWID_FILE` default to `/mihomo/*` — the `./mihomo` mount makes config generation + HWID mirror work exactly like `combine` did. The `app` user must be able to WRITE `/mihomo` (host dir perms) and `/app/data` (chowned in the Dockerfile). If the server can't write `/mihomo/config.yaml` (EACCES from the non-root user vs host ownership), note it and either run the container user mapped appropriately or document the required host perms — do NOT silently fall back. `COOKIE_SECURE: "false"` here because the compose publishes plain HTTP on localhost; a TLS deployment (Dokploy/Traefik) must override it to `"true"`.

- [ ] **Step 2: bring up the full stack + smoke through the container:**
```bash
docker compose up -d --build mihomo happ-decoder submerge
sleep 5
curl -s localhost:3000/healthz                  # {"ok":true}
curl -s localhost:3000/ | grep -o '<title>[^<]*' # SPA served
curl -s localhost:3000/trpc/nodes.list | head -c 120  # real nodes (mihomo up) or graceful error
docker compose logs submerge | tail -8           # booted, hub polling, no crash
```
Optionally open `http://localhost:3000` in a browser (Узлы renders with live data from the real mihomo). Then verify the server WROTE `mihomo/config.yaml` if a source is added (or just confirm no EACCES in logs). Report the observed results.

- [ ] **Step 3: tear down** (`docker compose down`) once verified. Do NOT commit any generated `mihomo/config.yaml` (gitignored).

- [ ] **Step 4: commit:**
```bash
git add docker-compose.yml
git commit -m "$(printf 'feat(deploy): switch compose from combine to the v2 submerge service\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Remove the PoC `combine/` + update docs

**Files:** Delete `combine/`; modify `AGENTS.md`, `docs/architecture.md` (+ any `combine` references).

- [ ] **Step 1: confirm nothing else references combine** — `grep -rn "combine" docker-compose.yml AGENTS.md docs/ README.md 2>/dev/null`. The compose no longer has the service (Task 3). 

- [ ] **Step 2: remove the PoC app** — `git rm -r combine/`. (`happ-decoder/` and `mihomo/` STAY.)

- [ ] **Step 3: update `AGENTS.md`** — the "Repository status" section: mark v2 as the shipped app and `combine/` as removed; drop the "Do not touch the PoC … until Phase 6" clause (Phase 6 is done) — keep `happ-decoder/` + `mihomo/` noted as reused sidecars. Update the "Commands" section if it references combine. Update `docs/architecture.md` similarly (combine → submerge container).

- [ ] **Step 4: gates** — `pnpm typecheck` + `pnpm -r test` + biome still green (removing `combine/`, a non-workspace plain-JS dir, doesn't affect them — confirm). 

- [ ] **Step 5: commit:**
```bash
git add -A
git commit -m "$(printf 'chore(deploy): remove the PoC combine app; docs point to the v2 submerge container\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Phase gate + CI + final review

**Files:** Create `.github/workflows/ci.yml`.

- [ ] **Step 1: deterministic gates** — `pnpm typecheck` clean; `pnpm -r test` green (shared/server/web); `pnpm -F @submerge/web build` clean; `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` → 0.
- [ ] **Step 2: CI workflow** (bonus) `.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push: { branches: [master] }
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome ci .
      - run: pnpm typecheck
      - run: pnpm -r test
```
(Verify the action versions are current; this runs the same gates CI-side. Multiarch Docker buildx + GHCR push is a documented follow-up, not built here.)
- [ ] **Step 3: full-stack docker smoke (final)** — `docker compose up -d --build` (mihomo + happ-decoder + submerge); confirm the served UI works end-to-end (Узлы live, optionally set `ADMIN_PASSWORD` to confirm the login gate in the container too); `docker compose down`. Clean any generated artifacts.
- [ ] **Step 4: commit CI:**
```bash
git add .github/workflows/ci.yml
git commit -m "$(printf 'ci: biome + typecheck + vitest on push/PR\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```
- [ ] **Step 5: final phase code-review (opus)** over `git diff master..feat/v2-phase6`, then merge `--no-ff` to master.

---

## Self-review (plan vs. spec §10)

- **One container serves SPA + /trpc + SSE + /healthz:** Task 1 (static serving) + the existing tRPC/SSE/healthz handler. ✓
- **Dockerfile builder (bookworm, native compile, build web+server) → slim non-root runtime, pnpm deploy:** Task 2. ✓
- **Switch compose to the new service, mihomo + happ-decoder unchanged, old combine removed after smoke:** Tasks 3 + 4. ✓
- **CI (biome → tsc → vitest):** Task 5. Multiarch buildx/GHCR push = documented follow-up (not blocking a working self-hosted deploy). 
- **Phase-5 hardening honored:** compose sets `COOKIE_SECURE` explicitly (false for the localhost-HTTP compose; TLS deploy overrides to true), no permissive CORS added.

**Type/contract consistency:** the web already calls the relative `/trpc` (no change for same-origin prod). `WEB_DIST`/`DB_PATH` are env-driven with dev defaults + container overrides. `tsc -b` dist JS is the runtime entry (`node dist/index.js`).

**Risks / verify-during-impl:**
1. `pnpm --filter @submerge/server deploy --prod` layout — confirm it yields `/app/deploy/dist/index.js` + a node_modules with compiled `better-sqlite3` + `@node-rs/argon2` + runnable `@submerge/shared`; adjust paths if not. The server `package.json` must ship `dist` (and `@submerge/shared` must expose its `dist` via exports/main) for runtime resolution. (Task 2 — verify by actually running the container.)
2. Native module ABI: build + run both on `bookworm`/`bookworm-slim` (same glibc) so `better-sqlite3` loads. `@node-rs/argon2` is prebuilt.
3. Non-root write perms: the `app` user must write `/app/data` (chowned) and `/mihomo` (host-dir ownership). If `/mihomo` is root-owned on the host, the server's config write 500s — surface it, don't hide it.
4. `COOKIE_SECURE` must be `"true"` (not blank) in any TLS deployment — blank crashes boot (Phase-5 audit note); the compose sets an explicit value.
5. Docker availability for the smoke (confirmed present in earlier phases).
