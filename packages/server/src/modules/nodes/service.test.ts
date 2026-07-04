import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelPolicy } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { sources } from "../../db/schema.js";
import { createChannel, ensureDefaultChannel, updateChannel } from "../channels/service.js";
import { applyConfig, collectProxies, listNodes, testDelay } from "./service.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  // applyConfig (Phase 3a) now iterates listChannels(db) — seed the Default channel
  // so tests match the real app bootstrap (index.ts calls this too).
  ensureDefaultChannel(db);
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

// mihomo config.yaml shape used only by these tests — narrow enough to avoid
// `any` at each call site (the rest of the doc is untyped and not asserted on).
interface GeneratedConfig {
  "proxy-groups": { name: string }[];
  rules: string[];
}

function readGeneratedConfig(path: string): GeneratedConfig {
  return yaml.load(readFileSync(path, "utf8")) as GeneratedConfig;
}

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
    expect(res.applied).toBe(true);
    expect(reloaded).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(cfg.proxies[0].name).toBe("A");
  });

  it("writes the config atomically, leaving no temp file behind", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const dir = mkdtempSync(join(tmpdir(), "submerge-"));
    const configPath = join(dir, "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    // atomic write = temp file renamed into place; the dir holds only the final config
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  it("still writes the config and reports applied:false when the reload fails", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("engine down", { status: 503 })),
    );
    const res = await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    expect(res.applied).toBe(false);
    expect(res.nodes).toBe(1);
    // the file must be written regardless — it applies on the engine's next reload
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(cfg.proxies[0].name).toBe("A");
  });

  const speedPolicy: ChannelPolicy = {
    kind: "speed",
    testUrl: "https://example.com/generate_204",
    intervalSec: 60,
    toleranceMs: 50,
    reevaluateWhileHealthy: true,
  };

  it("drops a disabled non-default channel's group + rules from the config; re-enabling restores them", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const ch = createChannel(db, {
      name: "Media",
      policy: speedPolicy,
      matcher: { presets: [], domains: ["youtube.com"] },
    });
    updateChannel(db, ch.id, { enabled: false });

    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );

    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    let cfg = readGeneratedConfig(configPath);
    let groupNames = cfg["proxy-groups"].map((g) => g.name);
    expect(groupNames).not.toContain(`ch-${ch.id}`);
    expect(cfg.rules).not.toContain(`DOMAIN-SUFFIX,youtube.com,ch-${ch.id}`);
    // Only the Default catch-all remains — no non-default channel is routed.
    expect(cfg.rules).toEqual(["MATCH,PROXY"]);

    updateChannel(db, ch.id, { enabled: true });
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    cfg = readGeneratedConfig(configPath);
    groupNames = cfg["proxy-groups"].map((g) => g.name);
    expect(groupNames).toContain(`ch-${ch.id}`);
    expect(cfg.rules).toContain(`DOMAIN-SUFFIX,youtube.com,ch-${ch.id}`);
    expect(cfg.rules).toContain("MATCH,AUTO");
  });
});

describe("listNodes", () => {
  it("normalizes the PROXY group into a NodeView with delays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({
          proxies: {
            PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A", "B", "C"], history: [] },
            A: { name: "A", type: "vless", udp: true, history: [{ time: "t", delay: 50 }] },
            B: { name: "B", type: "vless", history: [] },
            // Last measurement was a timeout (mihomo records delay 0) — surfaced as 0
            // ("таймаут"), NOT null ("— ms"), so a dead node reads differently from an
            // unmeasured one.
            C: { name: "C", type: "vless", history: [{ time: "t", delay: 0 }] },
          },
        }),
      ),
    );
    const view = await listNodes(freshDb());
    expect(view.now).toBe("A");
    expect(view.all).toEqual([
      { name: "A", type: "vless", delay: 50, udp: true, history: [50] },
      { name: "B", type: "vless", delay: null, history: [] },
      { name: "C", type: "vless", delay: 0, history: [0] },
    ]);
  });

  it("returns an empty view when there is no PROXY group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ proxies: {} })),
    );
    const view = await listNodes(freshDb());
    expect(view).toEqual({ now: null, autoNow: null, all: [] });
  });

  it("attaches members and the active member's delay for a collapsed group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({
          proxies: {
            PROXY: { name: "PROXY", type: "Selector", now: "G", all: ["G", "S"], history: [] },
            G: { name: "G", type: "URLTest", now: "G #2", all: ["G #1", "G #2"], history: [] },
            "G #1": { name: "G #1", type: "vless", history: [{ time: "t", delay: 90 }] },
            "G #2": { name: "G #2", type: "vless", history: [{ time: "t", delay: 40 }] },
            S: { name: "S", type: "vless", history: [{ time: "t", delay: 55 }] },
          },
        }),
      ),
    );
    const view = await listNodes(freshDb());
    const g = view.all.find((n) => n.name === "G");
    expect(g?.delay).toBe(40); // active member G #2
    expect(g?.members).toEqual([
      { name: "G #1", delay: 90, history: [90], active: false },
      { name: "G #2", delay: 40, history: [40], active: true },
    ]);
    // a singleton is unchanged (no members)
    expect(view.all.find((n) => n.name === "S")?.members).toBeUndefined();
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
