import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { appRouter } from "./router.js";
import { createCallerFactory } from "./trpc.js";

const createCaller = createCallerFactory(appRouter);
const caller = () =>
  createCaller({ authed: true, authRequired: false, req: {} as never, res: {} as never });

// The settings/sources routers use the singleton db (a real file at env.DB_PATH).
// Apply migrations so the tables exist regardless of the file's prior state
// (migrate is idempotent — a no-op if already applied).
beforeAll(() => {
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
});

afterEach(() => vi.unstubAllGlobals());

// Drop the throwaway settings key so the round-trip test stays self-contained
// and the next run genuinely exercises the write→read path against the singleton db.
afterAll(() => {
  db.delete(settings).where(eq(settings.key, "__router_test__")).run();
});

describe("appRouter", () => {
  it("health.ping returns ok", async () => {
    const res = await caller().health.ping();
    expect(res.ok).toBe(true);
    expect(typeof res.version).toBe("string");
  });

  it("nodes.list normalizes mihomo proxies", async () => {
    const fetchMock = vi.fn(
      () =>
        new Response(
          JSON.stringify({
            proxies: {
              PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A"], history: [] },
              A: { name: "A", type: "vless", history: [] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = await caller().nodes.list();
    expect(view.now).toBe("A");
    expect(view.all[0]?.name).toBe("A");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/proxies"), expect.anything());
  });

  it("settings.set then settings.get round-trips", async () => {
    await caller().settings.set({ key: "__router_test__", value: "dark" });
    const all = await caller().settings.get();
    expect(all.__router_test__).toBe("dark");
  });
});
