import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { applyConfig, collectProxies, listNodes, testDelay } from "./service.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}
const proxy = (name: string) => ({ name, type: "vless", server: "ex.com", port: 443, uuid: "u" });
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

afterEach(() => vi.unstubAllGlobals());

describe("collectProxies", () => {
  it("gathers enabled sources by sortOrder and skips disabled ones", () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "b", label: "b", sortOrder: 1, proxies: [proxy("B")] })
      .run();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", sortOrder: 0, proxies: [proxy("A")] })
      .run();
    db.insert(sources)
      .values({
        kind: "sub",
        value: "d",
        label: "d",
        sortOrder: 2,
        enabled: false,
        proxies: [proxy("D")],
      })
      .run();
    expect(collectProxies(db).map((p) => p.name)).toEqual(["A", "B"]);
  });
});

describe("applyConfig", () => {
  it("writes the generated config and reloads mihomo", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    let reloaded = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/configs")) reloaded = true;
        return new Response(null, { status: 204 });
      }),
    );
    const res = await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    expect(res.nodes).toBe(1);
    expect(reloaded).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(cfg.proxies[0].name).toBe("A");
  });
});

describe("listNodes", () => {
  it("normalizes the PROXY group into a NodeView with delays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({
          proxies: {
            PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A", "B"], history: [] },
            A: { name: "A", type: "vless", udp: true, history: [{ time: "t", delay: 50 }] },
            B: { name: "B", type: "vless", history: [] },
          },
        }),
      ),
    );
    const view = await listNodes();
    expect(view.now).toBe("A");
    expect(view.all).toEqual([
      { name: "A", type: "vless", delay: 50, udp: true, history: [50] },
      { name: "B", type: "vless", delay: null, history: [] },
    ]);
  });

  it("returns an empty view when there is no PROXY group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ proxies: {} })),
    );
    const view = await listNodes();
    expect(view).toEqual({ now: null, autoNow: null, all: [] });
  });
});

describe("testDelay", () => {
  it("returns the delay when positive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ delay: 50 })),
    );
    expect(await testDelay("A")).toBe(50);
  });
  it("returns null when delay is zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ delay: 0 })),
    );
    expect(await testDelay("A")).toBeNull();
  });
  it("returns null when the delay request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("err", { status: 503 })),
    );
    expect(await testDelay("A")).toBeNull();
  });
});
