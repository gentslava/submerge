# submerge v2 — Фаза 1: каркас монорепо + server-ядро

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять монорепо submerge v2 с работающим server-ядром: типобезопасный контракт (Zod), БД (Drizzle+SQLite WAL), tRPC-сервер с health-роутером, валидируемый конфиг — фундамент для последующих фаз.

**Architecture:** pnpm workspaces из трёх пакетов — `shared` (Zod-схемы + типы), `server` (Node 24 + tRPC + Drizzle/SQLite), `web` (заглушка, наполним в Фазе 3). server поднимает HTTP с `/trpc` и `/healthz`. На этом этапе фронта/ingest нет — только каркас и ядро.

**Tech Stack:** Node 24 LTS, TypeScript (strict), pnpm, Biome, Zod 4, tRPC v11, Drizzle ORM + better-sqlite3, Vitest. Все зависимости — latest-мажор на момент установки.

---

## Файловая структура (создаётся в Фазе 1)

```
submerge/
├─ package.json                     # workspace root: скрипты, devDeps (biome, typescript)
├─ pnpm-workspace.yaml
├─ biome.json                       # линт+формат, единый
├─ tsconfig.base.json               # strict база, наследуется пакетами
├─ packages/
│  ├─ shared/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts                # реэкспорт схем
│  │     └─ schemas.ts              # Zod: Proxy, Source, SourceKind, Settings
│  ├─ server/
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  ├─ drizzle.config.ts
│  │  ├─ vitest.config.ts
│  │  └─ src/
│  │     ├─ config/env.ts           # Zod-валидация process.env (fail-fast)
│  │     ├─ db/schema.ts            # таблицы sources, settings, sessions
│  │     ├─ db/client.ts            # подключение + PRAGMA WAL
│  │     ├─ db/migrate.ts           # применение миграций при старте
│  │     ├─ trpc/trpc.ts            # init tRPC, context, publicProcedure
│  │     ├─ trpc/router.ts          # appRouter (health) + export AppRouter
│  │     └─ index.ts                # HTTP-сервер: /trpc + /healthz
│  └─ web/
│     └─ package.json               # placeholder (Фаза 3)
```

> На время v2 текущий PoC (`combine/`, `mihomo/`, `docker-compose.yml`) остаётся в репозитории нетронутым. Новый код живёт в `packages/`. Финальный compose переключим в Фазе 6.

---

### Task 1: Каркас монорепо

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `biome.json`, `tsconfig.base.json`

- [ ] **Step 1: Создать `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Создать корневой `package.json`**

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

- [ ] **Step 3: Создать `tsconfig.base.json`**

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

- [ ] **Step 4: Создать `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": { "includes": ["packages/**/*.ts", "packages/**/*.tsx"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

- [ ] **Step 5: Установить корневые devDeps**

Run: `cd ~/Developer/submerge && pnpm install`
Expected: создан `pnpm-lock.yaml`, установлены biome+typescript последних версий.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml biome.json tsconfig.base.json pnpm-lock.yaml
git commit -m "chore: каркас монорепо submerge v2 (pnpm workspaces, biome, tsconfig)"
```

---

### Task 2: Пакет `shared` — Zod-схемы домена

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/schemas.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: Создать `packages/shared/package.json`**

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

- [ ] **Step 2: Создать `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Написать падающий тест `packages/shared/src/schemas.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { sourceKindSchema, proxySchema } from "./schemas.js";

describe("schemas", () => {
  it("принимает валидный kind", () => {
    expect(sourceKindSchema.parse("sub")).toBe("sub");
  });
  it("отклоняет неизвестный kind", () => {
    expect(() => sourceKindSchema.parse("nope")).toThrow();
  });
  it("валидирует минимальный proxy", () => {
    const p = proxySchema.parse({ name: "n1", type: "vless", server: "ex.com", port: 443, uuid: "u" });
    expect(p.name).toBe("n1");
  });
});
```

- [ ] **Step 4: Запустить тест — убедиться, что падает**

Run: `cd packages/shared && pnpm install && pnpm vitest run`
Expected: FAIL — модуль `./schemas.js` не существует.

- [ ] **Step 5: Создать `packages/shared/src/schemas.ts`**

```ts
import { z } from "zod";

export const sourceKindSchema = z.enum(["sub", "vless", "happ"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

// mihomo-proxy: фиксируем только обязательное ядро, остальное — passthrough
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

- [ ] **Step 6: Создать `packages/shared/src/index.ts`**

```ts
export * from "./schemas.js";
```

- [ ] **Step 7: Запустить тест — убедиться, что проходит**

Run: `cd packages/shared && pnpm vitest run`
Expected: PASS (3 теста).

- [ ] **Step 8: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): Zod-схемы домена (Source, Proxy, SourceKind) + тесты"
```

---

### Task 3: server — валидируемый конфиг (env)

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/vitest.config.ts`, `packages/server/src/config/env.ts`
- Test: `packages/server/src/config/env.test.ts`

- [ ] **Step 1: Создать `packages/server/package.json`**

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

- [ ] **Step 2: Создать `packages/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "references": [{ "path": "../shared" }],
  "include": ["src"]
}
```

- [ ] **Step 3: Создать `packages/server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 4: Написать падающий тест `packages/server/src/config/env.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("даёт дефолты при пустом окружении", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.DB_PATH).toBe("./data/submerge.db");
    expect(env.ADMIN_PASSWORD).toBeUndefined();
  });
  it("парсит PORT из строки", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
  });
  it("падает на невалидном PORT", () => {
    expect(() => parseEnv({ PORT: "abc" })).toThrow();
  });
});
```

- [ ] **Step 5: Запустить тест — убедиться, что падает**

Run: `cd packages/server && pnpm install && pnpm vitest run`
Expected: FAIL — `./env.js` не существует.

- [ ] **Step 6: Создать `packages/server/src/config/env.ts`**

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

// единый валидированный конфиг, fail-fast при старте
export const env = parseEnv(process.env);
```

- [ ] **Step 7: Запустить тест — убедиться, что проходит**

Run: `cd packages/server && pnpm vitest run`
Expected: PASS (3 теста).

- [ ] **Step 8: Commit**

```bash
git add packages/server pnpm-lock.yaml
git commit -m "feat(server): валидируемый конфиг env (Zod, fail-fast) + тесты"
```

---

### Task 4: server — БД (Drizzle + SQLite WAL)

**Files:**
- Create: `packages/server/src/db/schema.ts`, `packages/server/src/db/client.ts`, `packages/server/src/db/migrate.ts`, `packages/server/drizzle.config.ts`
- Test: `packages/server/src/db/client.test.ts`

- [ ] **Step 1: Создать `packages/server/src/db/schema.ts`**

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

- [ ] **Step 2: Создать `packages/server/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

- [ ] **Step 3: Создать `packages/server/src/db/client.ts`**

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

- [ ] **Step 4: Создать `packages/server/src/db/migrate.ts`**

```ts
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./client.js";

export function runMigrations() {
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}

if (import.meta.url === `file://${process.argv[1]}`) runMigrations();
```

- [ ] **Step 5: Сгенерировать миграцию из схемы**

Run: `cd packages/server && pnpm db:generate`
Expected: создан каталог `packages/server/drizzle/` с SQL-миграцией (CREATE TABLE sources/settings/sessions).

- [ ] **Step 6: Написать тест `packages/server/src/db/client.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb } from "./client.js";
import { sources } from "./schema.js";

describe("db", () => {
  it("создаёт и читает source в in-memory БД", () => {
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

- [ ] **Step 7: Запустить тест — убедиться, что проходит**

Run: `cd packages/server && pnpm vitest run src/db/client.test.ts`
Expected: PASS — запись создаётся, дефолты (enabled=true, hwid=false, proxies=[]) применяются.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/db packages/server/drizzle.config.ts packages/server/drizzle
git commit -m "feat(server): Drizzle-схема (sources/settings/sessions) + SQLite WAL + миграции"
```

---

### Task 5: server — tRPC init и health-роутер

**Files:**
- Create: `packages/server/src/trpc/trpc.ts`, `packages/server/src/trpc/router.ts`
- Test: `packages/server/src/trpc/router.test.ts`

- [ ] **Step 1: Создать `packages/server/src/trpc/trpc.ts`**

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

- [ ] **Step 2: Написать падающий тест `packages/server/src/trpc/router.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { createCallerFactory } from "./trpc.js";

const createCaller = createCallerFactory(appRouter);

describe("appRouter", () => {
  it("health.ping возвращает ok", async () => {
    const caller = createCaller({ authed: true });
    const res = await caller.health.ping();
    expect(res.ok).toBe(true);
    expect(typeof res.version).toBe("string");
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `cd packages/server && pnpm vitest run src/trpc/router.test.ts`
Expected: FAIL — `./router.js` не существует.

- [ ] **Step 4: Создать `packages/server/src/trpc/router.ts`**

```ts
import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  health: router({
    ping: publicProcedure.query(() => ({ ok: true, version: "0.2.0" })),
  }),
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: Запустить тест — убедиться, что проходит**

Run: `cd packages/server && pnpm vitest run src/trpc/router.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/trpc
git commit -m "feat(server): tRPC init + health.ping роутер + тест"
```

---

### Task 6: server — HTTP-сервер (/trpc + /healthz)

**Files:**
- Create: `packages/server/src/index.ts`
- Modify: `packages/server/package.json` (зависимость `@trpc/server` уже есть; адаптер из неё)

- [ ] **Step 1: Создать `packages/server/src/index.ts`**

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
  createContext: () => ({ authed: true }), // auth добавим в Фазе 5
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

- [ ] **Step 2: Запустить сервер**

Run: `cd packages/server && node --experimental-strip-types src/index.ts`
Expected: лог `submerge server on :3000`, создаётся `./data/submerge.db`.

- [ ] **Step 3: Проверить /healthz (в другом терминале)**

Run: `curl -s http://127.0.0.1:3000/healthz`
Expected: `{"ok":true}`

- [ ] **Step 4: Проверить tRPC health.ping**

Run: `curl -s 'http://127.0.0.1:3000/trpc/health.ping'`
Expected: JSON с `result.data` содержащим `{"ok":true,"version":"0.2.0"}`. Остановить сервер (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): HTTP-сервер /trpc + /healthz + миграции при старте + graceful shutdown"
```

---

### Task 7: web — placeholder-пакет (наполнение в Фазе 3)

**Files:**
- Create: `packages/web/package.json`

- [ ] **Step 1: Создать `packages/web/package.json`**

```json
{
  "name": "@submerge/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "echo \"web: наполняется в Фазе 3\"" }
}
```

- [ ] **Step 2: Проверить целостность монорепо**

Run: `cd ~/Developer/submerge && pnpm install && pnpm typecheck`
Expected: `pnpm install` без ошибок; `tsc -b` собирает shared+server без ошибок типов.

- [ ] **Step 3: Прогнать весь линт и тесты**

Run: `pnpm lint && pnpm test`
Expected: biome — без ошибок; все Vitest-тесты (shared + server) проходят.

- [ ] **Step 4: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "chore(web): placeholder-пакет; завершён каркас Фазы 1"
```

---

## Self-Review (выполнено при написании)

- **Покрытие спеки (Фаза 1):** монорепо ✓ (Task 1), shared/Zod ✓ (Task 2), env-конфиг ✓ (Task 3), Drizzle+SQLite WAL+миграции ✓ (Task 4), tRPC ✓ (Task 5,6), health ✓ (Task 6). БД-таблицы соответствуют разделу 5 спеки. Ingest/web/real-time/auth/деплой — отдельные фазы (2–6), вне Фазы 1 намеренно.
- **Плейсхолдеры:** код приведён полностью в каждом шаге; «наполним в Фазе 3» относится к web-пакету, который намеренно пуст.
- **Консистентность типов:** `AppRouter` экспортируется (Task 5) для web-клиента (Фаза 3); `Context.authed` (Task 5) используется в `createContext` (Task 6); имена таблиц/полей `schema.ts` совпадают в тестах и client.
- **Версии:** все зависимости ставятся как `latest`; пиннинг — через `pnpm-lock.yaml`.

## Замечания для исполнителя

- Перед написанием кода свериться с актуальным API через Context7 MCP для: Zod 4 (`z.enum`, `.loose()`, `z.coerce`), tRPC v11 (`initTRPC`, `createHTTPHandler`), Drizzle (`sqliteTable`, `better-sqlite3` адаптер, миграции). API мог измениться к latest.
- Node 24 умеет исполнять TS напрямую (`--experimental-strip-types`); если флаг не нужен в текущей версии — убрать. Для прод-сборки в Фазе 6 добавим компиляцию (tsc/tsup).
- Не трогать существующий PoC (`combine/`, `mihomo/`, `happ-decoder/`, корневой `docker-compose.yml`) — он остаётся рабочим до Фазы 6.
