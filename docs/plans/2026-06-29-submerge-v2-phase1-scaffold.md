# submerge v2 — Phase 1: monorepo scaffold + server core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the submerge v2 monorepo with a working server core: type-safe contract (Zod), database (Drizzle+SQLite WAL), tRPC server with a health router, validated config — the foundation for subsequent phases.

**Architecture:** pnpm workspaces with three packages — `shared` (Zod schemas + types), `server` (Node 24 + tRPC + Drizzle/SQLite), `web` (placeholder, to be filled in Phase 3). The server exposes HTTP with `/trpc` and `/healthz`. No frontend or ingest at this stage — only the scaffold and core.

**Tech Stack:** Node 24 LTS, TypeScript (strict), pnpm, Biome, Zod 4, tRPC v11, Drizzle ORM + better-sqlite3, Vitest. All dependencies are latest-major at install time.

---

## File structure (created in Phase 1)

```
submerge/
├─ package.json                     # workspace root: scripts, devDeps (biome, typescript)
├─ pnpm-workspace.yaml
├─ biome.json                       # lint+format, unified
├─ tsconfig.base.json               # strict base, inherited by packages
├─ packages/
│  ├─ shared/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts                # schema re-exports
│  │     └─ schemas.ts              # Zod: Proxy, Source, SourceKind, Settings
│  ├─ server/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ drizzle.config.ts
│  │  ├─ vitest.config.ts
│  │  └─ src/
│  │     ├─ config/env.ts           # Zod-validated process.env (fail-fast)
│  │     ├─ db/schema.ts            # tables: sources, settings, sessions
│  │     ├─ db/client.ts            # connection + PRAGMA WAL
│  │     ├─ db/migrate.ts           # run migrations on startup
│  │     ├─ trpc/trpc.ts            # init tRPC, context, publicProcedure
│  │     ├─ trpc/router.ts          # appRouter (health) + export AppRouter
│  │     └─ index.ts                # HTTP server: /trpc + /healthz
│  └─ web/
│     └─ package.json               # placeholder (Phase 3)
```

> During v2 development the current PoC (`combine/`, `mihomo/`, `docker-compose.yml`) stays in the repository untouched. New code lives in `packages/`. The final compose switch happens in Phase 6.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `biome.json`, `tsconfig.base.json`

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "submerge",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "pnpm -r run build",
    "typecheck": "tsc -b --noEmit",
    "lint": "biome ci .",
    "format": "biome format --write .",
    "test": "pnpm -r run test"
  },
  "devDependencies": {
    "@biomejs/biome": "latest",
    "typescript": "latest"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true
  }
}
```

- [ ] **Step 4: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": { "includes": ["packages/**/*.ts", "packages/**/*.tsx"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

- [ ] **Step 5: Install root devDeps**

Run: `cd ~/Developer/submerge && pnpm install`
Expected: `pnpm-lock.yaml` created, biome+typescript installed at latest versions.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml biome.json tsconfig.base.json pnpm-lock.yaml
git commit -m "chore: monorepo scaffold for submerge v2 (pnpm workspaces, biome, tsconfig)"
```

---

### Task 2: `shared` package — domain Zod schemas

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/schemas.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@submerge/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": { "zod": "latest" },
  "devDependencies": { "vitest": "latest" }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write failing test `packages/shared/src/schemas.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { sourceKindSchema, proxySchema } from "./schemas.js";

describe("schemas", () => {
  it("accepts a valid kind", () => {
    expect(sourceKindSchema.parse("sub")).toBe("sub");
  });
  it("rejects an unknown kind", () => {
    expect(() => sourceKindSchema.parse("nope")).toThrow();
  });
  it("validates a minimal proxy", () => {
    const p = proxySchema.parse({ name: "n1", type: "vless", server: "ex.com", port: 443, uuid: "u" });
    expect(p.name).toBe("n1");
  });
});
```

- [ ] **Step 4: Run the test — confirm it fails**

Run: `cd packages/shared && pnpm install && pnpm vitest run`
Expected: FAIL — module `./schemas.js` does not exist.

- [ ] **Step 5: Create `packages/shared/src/schemas.ts`**

```ts
import { z } from "zod";

export const sourceKindSchema = z.enum(["sub", "vless", "happ"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

// mihomo proxy: pin only the required core fields, everything else passes through
export const proxySchema = z
  .object({
    name: z.string(),
    type: z.string(),
    server: z.string(),
    port: z.number(),
    uuid: z.string().optional(),
  })
  .loose();
export type Proxy = z.infer<typeof proxySchema>;

export const sourceSchema = z.object({
  id: z.number().int(),
  kind: sourceKindSchema,
  value: z.string(),
  label: z.string(),
  hwid: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  proxies: z.array(proxySchema),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

export const addSourceInput = z.object({
  value: z.string().min(1),
  hwid: z.boolean().default(false),
});
export type AddSourceInput = z.infer<typeof addSourceInput>;
```

- [ ] **Step 6: Create `packages/shared/src/index.ts`**

```ts
export * from "./schemas.js";
```

- [ ] **Step 7: Run the test — confirm it passes**

Run: `cd packages/shared && pnpm vitest run`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): domain Zod schemas (Source, Proxy, SourceKind) + tests"
```

---

### Task 3: server — validated config (env)

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/vitest.config.ts`, `packages/server/src/config/env.ts`
- Test: `packages/server/src/config/env.test.ts`

- [ ] **Step 1: Create `packages/server/package.json`**

```json
{
  "name": "@submerge/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "build": "tsc -b",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "node --experimental-strip-types src/db/migrate.ts"
  },
  "dependencies": {
    "@submerge/shared": "workspace:*",
    "@trpc/server": "latest",
    "better-sqlite3": "latest",
    "drizzle-orm": "latest",
    "pino": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/better-sqlite3": "latest",
    "@types/node": "latest",
    "drizzle-kit": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Create `packages/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "references": [{ "path": "../shared" }],
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 4: Write failing test `packages/server/src/config/env.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("returns defaults for an empty environment", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.DB_PATH).toBe("./data/submerge.db");
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });
  it("parses PORT from a string", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });
  it("throws on an invalid PORT", () => {
    expect(() => parseEnv({ PORT: "abc" })).toThrow();
  });
});
```

- [ ] **Step 5: Run the test — confirm it fails**

Run: `cd packages/server && pnpm install && pnpm vitest run`
Expected: FAIL — `./env.js` does not exist.

- [ ] **Step 6: Create `packages/server/src/config/env.ts`**

```ts
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().default("./data/submerge.db"),
  MIHOMO_API: z.string().default("http://mihomo:9090"),
  MIHOMO_SECRET: z.string().default(""),
  HAPP_DECODER_URL: z.string().default("http://happ-decoder:8080"),
  ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return envSchema.parse(source);
}

// single validated config, fail-fast on startup
export const env = parseEnv(process.env);
```

- [ ] **Step 7: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): validated env config (Zod, fail-fast) + tests"
```

---

### Task 4: server — database (Drizzle + SQLite WAL)

**Files:**
- Create: `packages/server/src/db/schema.ts`, `packages/server/src/db/client.ts`, `packages/server/src/db/migrate.ts`, `packages/server/drizzle.config.ts`
- Test: `packages/server/src/db/client.test.ts`

- [ ] **Step 1: Create `packages/server/src/db/schema.ts`**

```ts
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  label: text("label").notNull(),
  hwid: integer("hwid", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  proxies: text("proxies", { mode: "json" }).notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`(current_timestamp)`),
  createdAt: text("created_at").notNull().default(sql`(current_timestamp)`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});
```

- [ ] **Step 2: Create `packages/server/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

- [ ] **Step 3: Create `packages/server/src/db/client.ts`**

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export function createDb(path: string = env.DB_PATH) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
export const db = createDb();
```

- [ ] **Step 4: Create `packages/server/src/db/migrate.ts`**

```ts
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./client.js";

export function runMigrations() {
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}

if (import.meta.url === `file://${process.argv[1]}`) runMigrations();
```

- [ ] **Step 5: Generate migration from schema**

Run: `cd packages/server && pnpm db:generate`
Expected: `packages/server/drizzle/` directory created with a SQL migration (CREATE TABLE sources/settings/sessions).

- [ ] **Step 6: Write test `packages/server/src/db/client.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb } from "./client.js";
import { sources } from "./schema.js";

describe("db", () => {
  it("creates and reads a source in an in-memory database", () => {
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    db.insert(sources).values({ kind: "sub", value: "https://x", label: "X" }).run();
    const rows = db.select().from(sources).where(eq(sources.kind, "sub")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
    expect(rows[0]?.hwid).toBe(false);
    expect(rows[0]?.proxies).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/db/client.test.ts`
Expected: PASS — record created, defaults (enabled=true, hwid=false, proxies=[]) applied.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/db packages/server/drizzle.config.ts packages/server/drizzle
git commit -m "feat(server): Drizzle schema (sources/settings/sessions) + SQLite WAL + migrations"
```

---

### Task 5: server — tRPC init and health router

**Files:**
- Create: `packages/server/src/trpc/trpc.ts`, `packages/server/src/trpc/router.ts`
- Test: `packages/server/src/trpc/router.test.ts`

- [ ] **Step 1: Create `packages/server/src/trpc/trpc.ts`**

```ts
import { initTRPC } from "@trpc/server";

export interface Context {
  authed: boolean;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
```

- [ ] **Step 2: Write failing test `packages/server/src/trpc/router.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { createCallerFactory } from "./trpc.js";

const createCaller = createCallerFactory(appRouter);

describe("appRouter", () => {
  it("health.ping returns ok", async () => {
    const caller = createCaller({ authed: true });
    const res = await caller.health.ping();
    expect(res.ok).toBe(true);
    expect(typeof res.version).toBe("string");
  });
});
```

- [ ] **Step 3: Run the test — confirm it fails**

Run: `cd packages/server && pnpm vitest run src/trpc/router.test.ts`
Expected: FAIL — `./router.js` does not exist.

- [ ] **Step 4: Create `packages/server/src/trpc/router.ts`**

```ts
import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  health: router({
    ping: publicProcedure.query(() => ({ ok: true, version: "0.2.0" })),
  }),
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: Run the test — confirm it passes**

Run: `cd packages/server && pnpm vitest run src/trpc/router.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/trpc
git commit -m "feat(server): tRPC init + health.ping router + test"
```

---

### Task 6: server — HTTP server (/trpc + /healthz)

**Files:**
- Create: `packages/server/src/index.ts`
- Modify: `packages/server/package.json` (`@trpc/server` dependency already present; adapter comes from it)

- [ ] **Step 1: Create `packages/server/src/index.ts`**

```ts
import { createServer } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import pino from "pino";
import { env } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { appRouter } from "./trpc/router.js";

const log = pino({ name: "submerge" });

runMigrations();

const trpcHandler = createHTTPHandler({
  router: appRouter,
  createContext: () => ({ authed: true }), // auth added in Phase 5
});

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.startsWith("/trpc")) {
    req.url = url.slice("/trpc".length) || "/";
    trpcHandler(req, res);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(env.PORT, () => log.info(`submerge server on :${env.PORT}`));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 2: Start the server**

Run: `cd packages/server && node --experimental-strip-types src/index.ts`
Expected: log `submerge server on :3000`, `./data/submerge.db` created.

- [ ] **Step 3: Check /healthz (in another terminal)**

Run: `curl -s http://127.0.0.1:3000/healthz`
Expected: `{"ok":true}`

- [ ] **Step 4: Check tRPC health.ping**

Run: `curl -s 'http://127.0.0.1:3000/trpc/health.ping'`
Expected: JSON with `result.data` containing `{"ok":true,"version":"0.2.0"}`. Stop the server (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): HTTP server /trpc + /healthz + migrations on startup + graceful shutdown"
```

---

### Task 7: web — placeholder package (to be filled in Phase 3)

**Files:**
- Create: `packages/web/package.json`

- [ ] **Step 1: Create `packages/web/package.json`**

```json
{
  "name": "@submerge/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "echo \"web: to be filled in Phase 3\"" }
}
```

- [ ] **Step 2: Verify monorepo integrity**

Run: `cd ~/Developer/submerge && pnpm install && pnpm typecheck`
Expected: `pnpm install` without errors; `tsc -b` builds shared+server without type errors.

- [ ] **Step 3: Run all lint and tests**

Run: `pnpm lint && pnpm test`
Expected: biome — no errors; all Vitest tests (shared + server) pass.

- [ ] **Step 4: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "chore(web): placeholder package; Phase 1 scaffold complete"
```

---

## Self-Review (performed while writing)

- **Spec coverage (Phase 1):** monorepo ✓ (Task 1), shared/Zod ✓ (Task 2), env config ✓ (Task 3), Drizzle+SQLite WAL+migrations ✓ (Task 4), tRPC ✓ (Tasks 5,6), health ✓ (Task 6). DB tables match spec section 5. Ingest/web/real-time/auth/deploy are separate phases (2–6), intentionally out of scope for Phase 1.
- **Placeholders:** code is given in full in every step; "to be filled in Phase 3" refers to the web package, which is intentionally empty.
- **Type consistency:** `AppRouter` exported (Task 5) for the web client (Phase 3); `Context.authed` (Task 5) used in `createContext` (Task 6); table/column names in `schema.ts` match tests and client.
- **Versions:** all dependencies installed as `latest`; pinning via `pnpm-lock.yaml`.

## Notes for implementers

- Before writing code, check the current API via Context7 MCP for: Zod 4 (`z.enum`, `.loose()`, `z.coerce`), tRPC v11 (`initTRPC`, `createHTTPHandler`), Drizzle (`sqliteTable`, `better-sqlite3` adapter, migrations). The API may have changed at latest.
- Node 24 can execute TS directly (`--experimental-strip-types`); if the flag is not needed in the current version — remove it. Production build (tsc/tsup) will be added in Phase 6.
- Do not touch the existing PoC (`combine/`, `mihomo/`, `happ-decoder/`, root `docker-compose.yml`) — it stays operational until Phase 6.
