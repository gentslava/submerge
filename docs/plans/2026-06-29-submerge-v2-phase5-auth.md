# Phase 5 — Auth (single-admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional single-admin password auth — **off by default** (no `ADMIN_PASSWORD` env → UI stays open). When a password is set, the server verifies it with Argon2id, issues an httpOnly session cookie backed by the SQLite `sessions` table, protects all data procedures, and the web shows a login screen + logout.

**Architecture:** `ADMIN_PASSWORD` (plaintext env, optional) is hashed once in-memory with Argon2id; `auth.login` verifies the submitted password (rate-limited), creates an opaque 256-bit session row (`sessions.id`, `expiresAt`), and sets `sid` as `HttpOnly; SameSite=Lax; Path=/` (Secure gated by env). The tRPC standalone `createContext({req,res})` reads the cookie, validates the session, and yields `{ authed, authRequired }`; a `protectedProcedure` middleware throws `UNAUTHORIZED` when `authRequired && !authed`. Web: `auth.me` gates the app — unauthed+required renders `<LoginScreen>`; a logout button clears the session.

**Tech Stack:** `@node-rs/argon2` (Argon2id), tRPC v11 middleware + standalone-adapter context (Node `req`/`res` cookies), Drizzle `sessions` table (already in schema), `node:crypto` `randomBytes`, Zod 4, React 19 + TanStack Query.

**Design decisions (locked):**
- **Off by default:** `isAuthEnabled = Boolean(env.ADMIN_PASSWORD)`. When disabled, `authRequired:false` → `protectedProcedure` lets everything through and the web never shows login.
- **"Signed session id" = opaque random token.** A 256-bit `randomBytes` id is unforgeable; validation = DB existence + non-expiry. No separate HMAC (that's for *stateless* tokens; ours is stateful/DB-backed — signing would be redundant per ADR-0004 anti-overengineering). Documented as an intentional deviation from the spec's word "signed".
- **Password from env as plaintext, hashed in-memory at runtime** (not a pre-computed hash in env) so setup is just `ADMIN_PASSWORD=...`. Argon2id `verify` gives slow, constant-time comparison; combined with rate-limiting it resists brute force.
- **Secure cookie flag via `COOKIE_SECURE` env** (default `false` so dev/http works; Phase 6 compose sets `true` behind TLS).
- No external auth library; ~120 lines server.

---

## File structure

```
packages/shared/src/
  schemas.ts                 # + loginInput, sessionStatus schemas/types
  auth.test.ts               # NEW — schema parse tests

packages/server/src/
  config/env.ts              # + COOKIE_SECURE (ADMIN_PASSWORD already present)
  auth/cookies.ts            # NEW — pure cookie parse/serialize helpers
  auth/cookies.test.ts       # NEW
  auth/service.ts            # NEW — verifyPassword (argon2id), session CRUD, rate-limit
  auth/service.test.ts       # NEW
  auth/context.ts            # NEW — createContext(req,res) → { authed, authRequired, req, res }
  auth/router.ts             # NEW — auth.login / logout / me
  auth/router.test.ts        # NEW — caller with fake req/res
  trpc/trpc.ts               # + protectedProcedure (auth middleware), expand Context
  trpc/router.ts             # mount auth; (routers switch to protectedProcedure in their files)
  modules/{sources,nodes,settings}/router.ts  # publicProcedure → protectedProcedure
  live/router.ts             # publicProcedure → protectedProcedure
  index.ts                   # use auth createContext (replaces () => ({authed:true}))

packages/web/src/
  lib/trpc.ts                # (unchanged export; may add a 401 handler note)
  features/auth/LoginScreen.tsx   # NEW — password form → auth.login
  features/auth/useAuth.ts        # NEW — auth.me query + login/logout helpers
  main.tsx                   # gate: unauthed+required → LoginScreen, else app
  features/settings/SettingsScreen.tsx  # + "Сессия" card with logout (when auth enabled)
```

---

### Task 1: shared auth schemas + env flag

**Files:**
- Modify: `packages/shared/src/schemas.ts`, `packages/server/src/config/env.ts`
- Test: `packages/shared/src/auth.test.ts`

- [ ] **Step 1: failing test** `packages/shared/src/auth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loginInput, sessionStatusSchema } from "./schemas.js";

describe("auth schemas", () => {
  it("accepts a non-empty password", () => {
    expect(loginInput.parse({ password: "hunter2" })).toEqual({ password: "hunter2" });
  });
  it("rejects an empty password", () => {
    expect(() => loginInput.parse({ password: "" })).toThrow();
  });
  it("parses session status", () => {
    expect(sessionStatusSchema.parse({ authed: true, required: true })).toEqual({
      authed: true,
      required: true,
    });
  });
});
```

- [ ] **Step 2: run → FAIL** (`pnpm -F @submerge/shared test`).

- [ ] **Step 3:** append to `packages/shared/src/schemas.ts`:
```ts
// Auth (Phase 5) — single-admin optional password.
export const loginInput = z.object({ password: z.string().min(1) });
export type LoginInput = z.infer<typeof loginInput>;

export const sessionStatusSchema = z.object({ authed: z.boolean(), required: z.boolean() });
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
```

- [ ] **Step 4:** add `COOKIE_SECURE` to `packages/server/src/config/env.ts` `envSchema` (ADMIN_PASSWORD already exists as `z.string().optional()`):
```ts
COOKIE_SECURE: z.stringbool().default(false),
```
> If `z.stringbool()` isn't available in the installed Zod 4, use `z.coerce.boolean()` or `z.enum(["true","false"]).transform(v => v === "true").default("false")`. Verify against the installed Zod and pick the form that coerces the string env var `"true"/"false"` correctly.

- [ ] **Step 5: run → PASS** (`pnpm -F @submerge/shared test`, typecheck). Commit:
```bash
git add packages/shared/src/schemas.ts packages/shared/src/auth.test.ts packages/server/src/config/env.ts
git commit -m "$(printf 'feat(shared/server): auth schemas (login/sessionStatus) + COOKIE_SECURE env\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: cookie helpers (pure)

**Files:** Create `packages/server/src/auth/cookies.ts`; Test `packages/server/src/auth/cookies.test.ts`.

- [ ] **Step 1: failing test**:
```ts
import { describe, expect, it } from "vitest";
import { clearSessionCookie, parseCookies, serializeSessionCookie, SESSION_COOKIE } from "./cookies.js";

describe("cookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("sid=abc; theme=dark")).toEqual({ sid: "abc", theme: "dark" });
    expect(parseCookies(undefined)).toEqual({});
  });
  it("serializes a session cookie (httpOnly, lax, path)", () => {
    const c = serializeSessionCookie("abc", 3600, false);
    expect(c).toContain(`${SESSION_COOKIE}=abc`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=3600");
    expect(c).not.toContain("Secure");
  });
  it("adds Secure when requested", () => {
    expect(serializeSessionCookie("abc", 3600, true)).toContain("Secure");
  });
  it("clears the cookie with Max-Age=0", () => {
    expect(clearSessionCookie(false)).toContain(`${SESSION_COOKIE}=;`);
    expect(clearSessionCookie(false)).toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: run → FAIL.**

- [ ] **Step 3: implement `auth/cookies.ts`:**
```ts
export const SESSION_COOKIE = "sid";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function base(secure: boolean): string {
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function serializeSessionCookie(id: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; ${base(secure)}; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${base(secure)}; Max-Age=0`;
}
```

- [ ] **Step 4: run → PASS.** Commit:
```bash
git add packages/server/src/auth/cookies.ts packages/server/src/auth/cookies.test.ts
git commit -m "$(printf 'feat(server): pure session-cookie parse/serialize helpers (+ tests)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: auth service (Argon2id + sessions + rate-limit)

**Files:** Create `packages/server/src/auth/service.ts`; Test `packages/server/src/auth/service.test.ts`. Install `@node-rs/argon2`.

- [ ] **Step 1: install** `pnpm -F @submerge/server add @node-rs/argon2`. Confirm the export signature against the installed types: `import { hash, verify } from "@node-rs/argon2"` — `hash(password: string, opts?): Promise<string>` (default Argon2id), `verify(hashed: string, password: string, opts?): Promise<boolean>`. If the package surfaces a different entry (e.g. named differently), adapt and note it.

- [ ] **Step 2: failing test** `auth/service.test.ts` (uses an in-memory DB + sequential calls; Argon2 calls are ~50 ms — fine):
```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessions } from "../db/schema.js";
import {
  createSession,
  deleteSession,
  isRateLimited,
  recordLoginFailure,
  resetRateLimit,
  validateSession,
  verifyPassword,
} from "./service.js";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    "CREATE TABLE sessions (id text PRIMARY KEY NOT NULL, expires_at integer NOT NULL);",
  );
  return drizzle(sqlite);
}

describe("auth service", () => {
  beforeEach(() => resetRateLimit());
  afterEach(() => resetRateLimit());

  it("verifies the admin password with argon2id", async () => {
    expect(await verifyPassword("s3cret", "s3cret")).toBe(true);
    expect(await verifyPassword("s3cret", "wrong")).toBe(false);
    expect(await verifyPassword(undefined, "anything")).toBe(false); // auth disabled
  });

  it("creates, validates, and deletes a session", () => {
    const db = freshDb();
    const { id, expiresAt } = createSession(db);
    expect(id).toHaveLength(64); // 32 bytes hex
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(validateSession(db, id)).toBe(true);
    expect(validateSession(db, "nope")).toBe(false);
    deleteSession(db, id);
    expect(validateSession(db, id)).toBe(false);
  });

  it("treats an expired session as invalid", () => {
    const db = freshDb();
    db.insert(sessions).values({ id: "old", expiresAt: Date.now() - 1000 }).run();
    expect(validateSession(db, "old")).toBe(false);
  });

  it("rate-limits after too many failures", () => {
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited()).toBe(false);
      recordLoginFailure();
    }
    expect(isRateLimited()).toBe(true);
  });
});
```

- [ ] **Step 3: run → FAIL.**

- [ ] **Step 4: implement `auth/service.ts`:**
```ts
import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_TTL_SEC = SESSION_TTL_MS / 1000;

// Memoize the Argon2id hash of the configured admin password (by value) so we
// hash once, not per login. Verify is slow + constant-time by design.
const hashCache = new Map<string, Promise<string>>();
export async function verifyPassword(
  adminPassword: string | undefined,
  submitted: string,
): Promise<boolean> {
  if (!adminPassword) return false; // auth disabled → never authenticates
  let h = hashCache.get(adminPassword);
  if (!h) {
    h = hash(adminPassword);
    hashCache.set(adminPassword, h);
  }
  return verify(await h, submitted);
}

export function createSession(db: Db): { id: string; expiresAt: number } {
  const id = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.insert(sessions).values({ id, expiresAt }).run();
  return { id, expiresAt };
}

export function validateSession(db: Db, id: string | undefined): boolean {
  if (!id) return false;
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) return false;
  if (row.expiresAt <= Date.now()) {
    db.delete(sessions).where(eq(sessions.id, id)).run(); // prune expired
    return false;
  }
  return true;
}

export function deleteSession(db: Db, id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

// In-memory sliding-window rate limit (single admin; no Redis). 5 fails / 60 s.
const RL_MAX = 5;
const RL_WINDOW_MS = 60_000;
let failures: number[] = [];
export function isRateLimited(): boolean {
  const cutoff = Date.now() - RL_WINDOW_MS;
  failures = failures.filter((t) => t > cutoff);
  return failures.length >= RL_MAX;
}
export function recordLoginFailure(): void {
  failures.push(Date.now());
}
export function resetRateLimit(): void {
  failures = [];
}
```
> `Date.now()` is used at runtime (allowed in the server; the no-`Date.now` rule is only for Workflow scripts). The test inserts an expired row directly to avoid time mocking.

- [ ] **Step 5: run → PASS** (`pnpm -F @submerge/server test`). Commit:
```bash
git add packages/server/src/auth/service.ts packages/server/src/auth/service.test.ts packages/server/package.json pnpm-lock.yaml
git commit -m "$(printf 'feat(server): auth service — argon2id verify, session CRUD, rate-limit (+ tests)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: auth context + protectedProcedure middleware

**Files:** Create `packages/server/src/auth/context.ts`; Modify `packages/server/src/trpc/trpc.ts`. Test `packages/server/src/auth/context.test.ts`.

- [ ] **Step 1: expand the Context + add `protectedProcedure`** in `trpc/trpc.ts`:
```ts
import { initTRPC, TRPCError } from "@trpc/server";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Context {
  authed: boolean;
  authRequired: boolean;
  req: IncomingMessage;
  res: ServerResponse;
}

const t = initTRPC.context<Context>().create({
  sse: { ping: { enabled: true, intervalMs: 2000 }, client: { reconnectAfterInactivityMs: 5000 } },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

// Reject when auth is enabled and the request is not authenticated.
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.authRequired && !ctx.authed) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next();
});
```
> The existing SSE config must be preserved. `req`/`res` in the context are the Node objects from the standalone adapter (Task 5 wires them). Tests that build a caller will pass minimal `req`/`res` stubs.

- [ ] **Step 2: `auth/context.ts`** — builds the context from `{req,res}`:
```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import type { Context } from "../trpc/trpc.js";
import { parseCookies, SESSION_COOKIE } from "./cookies.js";
import { validateSession } from "./service.js";

export function createAppContext(opts: {
  req: IncomingMessage;
  res: ServerResponse;
}): Context {
  const authRequired = Boolean(env.ADMIN_PASSWORD);
  const sid = parseCookies(opts.req.headers.cookie)[SESSION_COOKIE];
  const authed = !authRequired || validateSession(db, sid);
  return { authed, authRequired, req: opts.req, res: opts.res };
}
```
(When auth is disabled, `authed` is `true` so everything is open.)

- [ ] **Step 3: failing test** `auth/context.test.ts` — `protectedProcedure` rejects unauthed when required, passes otherwise:
```ts
import { describe, expect, it } from "vitest";
import { createCallerFactory, protectedProcedure, router } from "../trpc/trpc.js";

const appRouter = router({ ping: protectedProcedure.query(() => "ok") });
const caller = createCallerFactory(appRouter);
const fakeReqRes = { req: {} as never, res: {} as never };

describe("protectedProcedure", () => {
  it("allows when auth not required", async () => {
    const c = caller({ authed: false, authRequired: false, ...fakeReqRes });
    expect(await c.ping()).toBe("ok");
  });
  it("allows when authed", async () => {
    const c = caller({ authed: true, authRequired: true, ...fakeReqRes });
    expect(await c.ping()).toBe("ok");
  });
  it("rejects when required and not authed", async () => {
    const c = caller({ authed: false, authRequired: true, ...fakeReqRes });
    await expect(c.ping()).rejects.toThrow(/Authentication required/);
  });
});
```

- [ ] **Step 4: run → FAIL then implement → PASS.** (The middleware is in Step 1; this test drives it.)

- [ ] **Step 5: commit:**
```bash
git add packages/server/src/trpc/trpc.ts packages/server/src/auth/context.ts packages/server/src/auth/context.test.ts
git commit -m "$(printf 'feat(server): auth context (cookie→session) + protectedProcedure middleware\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: auth router + protect data procedures + wire context

**Files:** Create `packages/server/src/auth/router.ts`; Modify `trpc/router.ts`, `modules/{sources,nodes,settings}/router.ts`, `live/router.ts`, `index.ts`. Test `auth/router.test.ts`.

- [ ] **Step 1: `auth/router.ts`** (login/logout/me; sets cookies via `ctx.res`):
```ts
import { loginInput, sessionStatusSchema } from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { publicProcedure, router } from "../trpc/trpc.js";
import { clearSessionCookie, parseCookies, SESSION_COOKIE, serializeSessionCookie } from "./cookies.js";
import {
  createSession,
  deleteSession,
  isRateLimited,
  recordLoginFailure,
  resetRateLimit,
  SESSION_TTL_SEC,
  verifyPassword,
} from "./service.js";

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) =>
    sessionStatusSchema.parse({ authed: ctx.authed, required: ctx.authRequired }),
  ),

  login: publicProcedure.input(loginInput).mutation(async ({ ctx, input }) => {
    if (!env.ADMIN_PASSWORD) return { ok: true as const }; // auth disabled → no-op success
    if (isRateLimited()) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Слишком много попыток" });
    }
    const ok = await verifyPassword(env.ADMIN_PASSWORD, input.password);
    if (!ok) {
      recordLoginFailure();
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Неверный пароль" });
    }
    resetRateLimit();
    const { id } = createSession(db);
    ctx.res.setHeader("Set-Cookie", serializeSessionCookie(id, SESSION_TTL_SEC, env.COOKIE_SECURE));
    return { ok: true as const };
  }),

  logout: publicProcedure.mutation(({ ctx }) => {
    const sid = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
    if (sid) deleteSession(db, sid);
    ctx.res.setHeader("Set-Cookie", clearSessionCookie(env.COOKIE_SECURE));
    return { ok: true as const };
  }),
});
```

- [ ] **Step 2: protect data procedures.** In `modules/sources/router.ts`, `modules/nodes/router.ts`, `modules/settings/router.ts`, and `live/router.ts`, change the imported `publicProcedure` to `protectedProcedure` (and update the import). Example (`nodes/router.ts`): `import { protectedProcedure, router } from "../../trpc/trpc.js";` then use `protectedProcedure` for `list/delay/select`. For `live/router.ts` the `stream` subscription uses `protectedProcedure.subscription(...)`. Leave `health.ping` and the whole `auth` router on `publicProcedure`.

- [ ] **Step 3: mount auth** in `trpc/router.ts`:
```ts
import { authRouter } from "../auth/router.js";
// …
export const appRouter = router({
  health: router({ ping: publicProcedure.query(() => ({ ok: true, version: "0.2.0" })) }),
  auth: authRouter,
  sources: sourcesRouter,
  nodes: nodesRouter,
  settings: settingsRouter,
  live: makeLiveRouter(liveHub),
});
```

- [ ] **Step 4: wire the real context** in `index.ts` — replace `createContext: () => ({ authed: true })`:
```ts
import { createAppContext } from "./auth/context.js";
// …
const trpcHandler = createHTTPHandler({
  router: appRouter,
  createContext: ({ req, res }) => createAppContext({ req, res }),
});
```

- [ ] **Step 5: test** `auth/router.test.ts` — login flow with fake req/res capturing Set-Cookie (set `ADMIN_PASSWORD` for the test via `vi.stubEnv` BEFORE importing, or test `verifyPassword` path through a caller with a stubbed env). Minimum viable deterministic test:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";

describe("auth router", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("me reports disabled auth when no ADMIN_PASSWORD", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "");
    const { authRouter } = await import("./router.js");
    const { createCallerFactory } = await import("../trpc/trpc.js");
    const caller = createCallerFactory(authRouter)({
      authed: true, authRequired: false, req: {} as never, res: {} as never,
    });
    expect(await caller.me()).toEqual({ authed: true, required: false });
  });
});
```
> `env` is parsed at import time from `process.env`, so `vi.stubEnv` must run before the dynamic `import()` and the `env` module must read `process.env` lazily OR the test imports after stubbing. If `env` is a frozen snapshot, this test may need to assert via the context value instead (pass `authRequired` directly). Keep the test deterministic; if env injection is awkward, cover `me`/`login` decision logic by calling the caller with explicit context flags and rely on Task 3's service tests for the argon2/session/rate-limit coverage. Do NOT add a flaky env-dependent test.

- [ ] **Step 6: gates** — `pnpm -F @submerge/server test` green; `pnpm typecheck` clean; **manual boot check both modes:**
  - `pnpm -F @submerge/server dev` (no ADMIN_PASSWORD) → `curl /trpc/auth.me` shows `{authed:true,required:false}`; `curl /trpc/nodes.list` works (open).
  - `ADMIN_PASSWORD=test pnpm -F @submerge/server dev` → `auth.me` shows `{authed:false,required:true}`; `nodes.list` returns UNAUTHORIZED; `auth.login {password:"test"}` returns a `Set-Cookie: sid=...`; re-requesting `nodes.list` with that cookie works.
- [ ] **Step 7: commit:**
```bash
git add packages/server/src
git commit -m "$(printf 'feat(server): auth router (login/logout/me) + protect data procedures + wire context\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: web — login screen + app gate + logout

**Files:** Create `packages/web/src/features/auth/{LoginScreen.tsx,useAuth.ts}`; Modify `packages/web/src/main.tsx`, `packages/web/src/features/settings/SettingsScreen.tsx`.

- [ ] **Step 1: `features/auth/useAuth.ts`** — the `auth.me` query + helpers:
```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";

export function useAuthStatus() {
  const trpc = useTRPC();
  return useQuery(trpc.auth.me.queryOptions());
}

export function useLogout() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return useMutation(
    trpc.auth.logout.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries(); // drop all cached data; auth.me will flip to unauthed
        toast.success("Вы вышли");
      },
    }),
  );
}
```

- [ ] **Step 2: `features/auth/LoginScreen.tsx`** — centered password form (Indigo Console tokens, reuse `Card`/`Input`/`Button`):
```tsx
import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";

export function LoginScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const login = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries(); // re-fetch auth.me (now authed) + data
        toast.success("Добро пожаловать");
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-lg font-semibold text-text-primary">submerge</h1>
        <p className="mb-4 text-sm text-text-secondary">Введите пароль администратора</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password) login.mutate({ password });
          }}
          className="flex flex-col gap-3"
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Пароль"
            autoFocus
          />
          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? "Вход…" : "Войти"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: gate the app** in `main.tsx` — render `LoginScreen` when `required && !authed`. Add an `<AuthGate>` between `LiveProvider` and `RouterProvider` (so the live subscription only runs once authed — move `LiveProvider` INSIDE the gate, or keep it outside but accept a brief unauthorized SSE attempt; prefer gating before `LiveProvider`). Recommended structure:
```tsx
function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStatus();
  if (status.isLoading) return null; // brief; could be a spinner
  if (status.data && status.data.required && !status.data.authed) return <LoginScreen />;
  return <>{children}</>;
}
// in App: QueryClientProvider > TRPCProvider > ThemeProvider > AuthGate > LiveProvider > RouterProvider + ThemedToaster
```
Put `AuthGate` OUTSIDE `LiveProvider` so the SSE subscription starts only after auth passes. `ThemedToaster` stays mounted (toasts on the login screen). `auth.me` is a `publicProcedure`, so it resolves even when unauthed.

- [ ] **Step 4: logout in Settings** — in `SettingsScreen.tsx`, when `useAuthStatus().data?.required`, add a "Сессия" `Card` with a destructive "Выйти" `Button` calling `useLogout().mutate()`. (Hidden when auth is disabled.)

- [ ] **Step 5: gates** — `pnpm -F @submerge/web typecheck` + `build` clean; `pnpm -r test` green. Raw biome `EXIT=0`. Commit:
```bash
git add packages/web/src
git commit -m "$(printf 'feat(web): login screen + auth gate + logout (single-admin)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 7: Phase gate — build, typecheck, lint, tests, auth browser smoke

**Files:** none (verification).

- [ ] **Step 1–4:** `pnpm typecheck` clean; `pnpm -F @submerge/web build` clean; `pnpm -r test` all green; `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` → 0.
- [ ] **Step 5: browser smoke (both modes).**
  - **Auth OFF** (`pnpm -F @submerge/server dev` with no `ADMIN_PASSWORD`): web loads straight to Узлы, no login screen, Settings has no "Сессия" card. (Regression check: Phase 4 live still works — can reuse `docker compose up -d mihomo` for live data, then tear down.)
  - **Auth ON** (`ADMIN_PASSWORD=test pnpm -F @submerge/server dev`): web shows `LoginScreen`; a wrong password → error toast (and after 5 tries → rate-limit toast); correct `test` → cookie set, app renders, data loads; reload stays logged in (cookie persists); Settings "Выйти" → back to login. Confirm the `sid` cookie is `HttpOnly` (DevTools → Application → Cookies). No crash.
  - Capture a screenshot of the login screen (dark) and the authed Узлы.
- [ ] **Step 6:** clean smoke artifacts (gitignored). No commit unless gate fixes were needed.

---

## Self-review (plan vs. spec §9)

- **Password from env, Argon2id:** Task 3 (`verifyPassword` hashes `ADMIN_PASSWORD` in-memory, `verify`s submissions). ✓
- **httpOnly+SameSite=Lax(+Secure) cookie, signed session id:** Task 2 (cookie) + Task 3 (opaque 256-bit random id) + Task 5 (set on login). "Signed" → opaque random DB-backed token (documented deviation). ✓
- **Sessions in SQLite, survive restarts, logout/revoke:** `sessions` table (already in schema) + create/validate/delete (Task 3), logout deletes the row (Task 5). ✓
- **Rate-limit on login (in-memory):** Task 3 (`isRateLimited`/`recordLoginFailure`), enforced in `auth.login` (Task 5). ✓
- **Off by default:** `authRequired = Boolean(env.ADMIN_PASSWORD)`; disabled → open UI + open procedures (Task 4 context, Task 6 gate). ✓
- **~100 lines, no external auth lib:** only `@node-rs/argon2` (a hashing primitive, per the stack), no auth framework. ✓
- **login/logout/me router:** Task 5. Data procedures protected via `protectedProcedure`; `health`/`auth` public. ✓

**Type consistency:** `Context` gains `{authRequired, req, res}` across `trpc.ts` + `auth/context.ts` + callers. `loginInput`/`sessionStatusSchema` (shared) used by router + web. `Db` type from `db/client.ts` in the service.

**Risks / verify-during-impl:**
1. `env` is a parsed snapshot from `process.env` at import — the Task 5 `vi.stubEnv` test must import after stubbing, or fall back to context-flag-driven tests (service tests carry the argon2/session/rate-limit coverage). Don't ship a flaky env test.
2. The standalone adapter's `createContext` receives `{ req, res, info }` — confirm `res.setHeader("Set-Cookie", …)` reaches the client through the `/trpc` prefix-strip in `index.ts` (it sets the header on the same `res` the handler writes — fine). For batched requests, a `Set-Cookie` on a login mutation still applies to the response.
3. Dev cookie over http: `COOKIE_SECURE=false` (default) so the `sid` cookie is stored/sent on `http://localhost`. Vite proxy forwards cookies same-origin.
4. `protectedProcedure` on the `live.stream` subscription: an unauthed SSE attempt must be rejected cleanly (the web `AuthGate` prevents mounting `LiveProvider` until authed, so this is belt-and-suspenders).
5. `@node-rs/argon2` is a native module — confirm it installs/builds on this platform (Node 24). If it fails to load, STOP and report (Phase 6 Docker already plans for native modules).
