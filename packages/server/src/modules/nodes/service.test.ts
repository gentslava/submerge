import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChannelPolicy,
  DEFAULT_AUTO_TEST_URL,
  emptyChannelMatcher,
  type NodeView,
  type Proxy as ProxyConfig,
} from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.js";
import { channels, sources } from "../../db/schema.js";
import { setPool } from "../channels/pool.js";
import {
  createChannel,
  ensureDefaultChannel,
  readDefaultChannel,
  updateChannel,
} from "../channels/service.js";
import {
  applyConfig,
  collectProxies,
  getExcludedSet,
  listNodes,
  mergeDbInventory,
  type ProxyMeta,
  selectNode,
  setExcluded,
  testDelay,
  toNodeView,
} from "./service.js";

const px = (name: string, server: string, extra: Partial<ProxyConfig> = {}): ProxyConfig => ({
  name,
  type: "vless",
  server,
  port: 443,
  ...extra,
});

describe("mergeDbInventory", () => {
  const emptyView: NodeView = { now: null, autoNow: null, all: [] };

  it("appends a DB node missing from the live view as idle", () => {
    const out = mergeDbInventory(emptyView, [px("A", "a.com")], new Map());
    expect(out.all).toHaveLength(1);
    expect(out.all[0]).toMatchObject({ name: "A", delay: null, history: [] });
  });

  it("leaves a node already in the live view untouched (no duplicate, keeps live delay)", () => {
    const view: NodeView = {
      now: "A",
      autoNow: null,
      all: [{ name: "A", type: "vless", delay: 120, history: [120] }],
    };
    const out = mergeDbInventory(view, [px("A", "a.com")], new Map());
    expect(out.all).toHaveLength(1);
    expect(out.all[0]?.delay).toBe(120);
  });

  it("collapses same-name DB proxies into an idle group with its members", () => {
    const out = mergeDbInventory(emptyView, [px("NL", "a.com"), px("NL", "b.com")], new Map());
    expect(out.all).toHaveLength(1);
    expect(out.all[0]?.delay).toBeNull();
    expect(out.all[0]?.members?.map((m) => m.name)).toEqual(["NL", "NL"]);
  });

  it("applies transport/security meta to an appended single", () => {
    const meta = new Map<string, ProxyMeta>([["A", { network: "ws", security: "reality" }]]);
    const out = mergeDbInventory(emptyView, [px("A", "a.com")], meta);
    expect(out.all[0]).toMatchObject({ network: "ws", security: "reality" });
  });

  it("preserves now/autoNow and appends after the live nodes", () => {
    const view: NodeView = {
      now: "X",
      autoNow: "Y",
      all: [{ name: "X", type: "vless", delay: 50, history: [50] }],
    };
    const out = mergeDbInventory(view, [px("X", "x.com"), px("Z", "z.com")], new Map());
    expect(out.now).toBe("X");
    expect(out.autoNow).toBe("Y");
    expect(out.all.map((n) => n.name)).toEqual(["X", "Z"]);
  });
});

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
  it("defines the whole inventory in PROXY but races only the Default pool", async () => {
    const db = freshDb();
    const nodes = [
      { name: "A", type: "vless", server: "a.com", port: 443, uuid: "u" },
      { name: "B", type: "vless", server: "b.com", port: 443, uuid: "u" },
      { name: "C", type: "vless", server: "c.com", port: 443, uuid: "u" },
    ];
    db.insert(sources).values({ kind: "sub", value: "s", label: "s", proxies: nodes }).run();
    // Default pool = only A (a subset). B and C must stay defined + selectable.
    setPool(db, readDefaultChannel(db).id, [{ kind: "node", ref: "A" }]);
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const groups = cfg["proxy-groups"] as any[];
    const proxy = groups.find((g) => g.name === "PROXY");
    const auto = groups.find((g) => g.name === "AUTO");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["A", "B", "C"]);
    expect(proxy.proxies).toEqual(["AUTO", "A", "B", "C", "DIRECT"]);
    expect(auto.proxies).toEqual(["A"]);
  });

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

  it("skips the write+reload when the generated config is byte-identical to what's on disk", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    const fetchMock = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    // First apply writes + reloads.
    const first = await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    expect(first.applied).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nothing changed → the second apply must NOT reload (mihomo keeps its delay history).
    const second = await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    expect(second.applied).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reloads when the config actually changes between applies", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    const fetchMock = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A genuine change (new node) → different config bytes → must reload again.
    db.insert(sources)
      .values({ kind: "sub", value: "b", label: "b", proxies: [proxy("B")] })
      .run();
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reloads an unchanged config when force is set (engine reconnect recovery)", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    const fetchMock = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    // A restarted mihomo lost our config even though the DB didn't change → force reload.
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml", { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      matcher: { ...emptyChannelMatcher(), domains: ["youtube.com"] },
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
    // Only the Default catch-all remains — no non-default channel is routed
    // (the hidden speed-test rule is always first when there are nodes).
    expect(cfg.rules).toEqual(["DOMAIN,speed.cloudflare.com,PROBE", "MATCH,PROXY"]);

    updateChannel(db, ch.id, { enabled: true });
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    cfg = readGeneratedConfig(configPath);
    groupNames = cfg["proxy-groups"].map((g) => g.name);
    expect(groupNames).toContain(`ch-${ch.id}`);
    expect(cfg.rules).toContain(`DOMAIN-SUFFIX,youtube.com,ch-${ch.id}`);
    expect(cfg.rules).toContain("MATCH,AUTO");
  });

  it("filters disabled Direct before generation and keeps enabled empty Direct a no-op", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    db.insert(channels)
      .values({
        id: "direct",
        name: "Direct",
        target: "direct",
        priority: 0,
        enabled: false,
        isDefault: false,
        policy: null,
        matcher: { ...emptyChannelMatcher(), domains: ["private.example"] },
        directPresets: { privateNetworks: false, localDomains: false },
      })
      .run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );

    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    let cfg = readGeneratedConfig(configPath);
    expect(cfg.rules).toEqual(["DOMAIN,speed.cloudflare.com,PROBE", "MATCH,PROXY"]);

    db.update(channels)
      .set({ enabled: true, matcher: emptyChannelMatcher() })
      .where(eq(channels.id, "direct"))
      .run();
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    cfg = readGeneratedConfig(configPath);
    expect(cfg.rules).toEqual(["DOMAIN,speed.cloudflare.com,PROBE", "MATCH,PROXY"]);
  });

  it("expands a channel's preset ids into DOMAIN-SUFFIX rules for every preset domain", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const ch = createChannel(db, {
      name: "Media",
      policy: speedPolicy,
      matcher: { ...emptyChannelMatcher(), presets: ["youtube"] },
    });

    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    const cfg = readGeneratedConfig(configPath);
    expect(cfg.rules).toContain(`DOMAIN-SUFFIX,youtube.com,ch-${ch.id}`);
    expect(cfg.rules).toContain(`DOMAIN-SUFFIX,googlevideo.com,ch-${ch.id}`);
  });

  it("expands Direct preset matchers and targets every generated domain at DIRECT", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    db.insert(channels)
      .values({
        id: "direct",
        name: "Direct",
        target: "direct",
        priority: 0,
        enabled: true,
        isDefault: false,
        policy: null,
        matcher: { ...emptyChannelMatcher(), presets: ["youtube"] },
        directPresets: { privateNetworks: false, localDomains: false },
      })
      .run();
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );

    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");

    const cfg = readGeneratedConfig(configPath);
    expect(cfg.rules).toContain("DOMAIN-SUFFIX,youtube.com,DIRECT");
    expect(cfg.rules).toContain("DOMAIN-SUFFIX,googlevideo.com,DIRECT");
    expect(cfg.rules).not.toContain("DOMAIN-SUFFIX,youtube.com,ch-direct");
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
      {
        name: "A",
        type: "vless",
        delay: 50,
        udp: true,
        history: [50],
        historyTimestamps: ["t"],
      },
      { name: "B", type: "vless", delay: null, history: [] },
      { name: "C", type: "vless", delay: 0, history: [0], historyTimestamps: ["t"] },
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

describe("toNodeView per-URL latency (extra)", () => {
  // mihomo keeps one shared `history` (last probe by ANY test URL) plus a per-URL
  // `extra` map. The panel must report the delay AUTO actually decides on — the
  // active policy's test URL — not whatever probe last landed in the shared list.
  const resp = {
    proxies: {
      PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A", "B"], history: [] },
      A: {
        name: "A",
        type: "vless",
        history: [{ time: "t", delay: 999 }], // shared: a stale probe on another URL
        extra: {
          "https://policy.example": { alive: true, history: [{ time: "t", delay: 50 }] },
        },
      },
      // No extra for B → must fall back to the shared history.
      B: { name: "B", type: "vless", history: [{ time: "t", delay: 111 }] },
    },
  };

  it("uses the policy URL's history for delay/history when extra has it", () => {
    const view = toNodeView(resp, undefined, "https://policy.example");
    expect(view.all.find((n) => n.name === "A")).toMatchObject({
      delay: 50,
      history: [50],
      historyTimestamps: ["t"],
    });
  });

  it("falls back to the shared history when extra lacks the policy URL", () => {
    const view = toNodeView(resp, undefined, "https://policy.example");
    expect(view.all.find((n) => n.name === "B")).toMatchObject({ delay: 111, history: [111] });
  });

  it("falls back to the shared history when the policy URL's history is present but empty", () => {
    const r = {
      proxies: {
        PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A"], history: [] },
        A: {
          name: "A",
          type: "vless",
          history: [{ time: "t", delay: 111 }],
          // present-but-empty per-URL block must NOT read as "— ms"
          extra: { "https://policy.example": { alive: true, history: [] } },
        },
      },
    };
    const view = toNodeView(r, undefined, "https://policy.example");
    expect(view.all.find((n) => n.name === "A")).toMatchObject({ delay: 111, history: [111] });
  });

  it("keeps the shared history when no test URL is given (unchanged behavior)", () => {
    const view = toNodeView(resp, undefined, undefined);
    expect(view.all.find((n) => n.name === "A")).toMatchObject({ delay: 999, history: [999] });
  });

  it("reads per-URL delays for a collapsed group's members and its active node", () => {
    const collapsed = {
      proxies: {
        PROXY: { name: "PROXY", type: "Selector", now: "G", all: ["G"], history: [] },
        G: { name: "G", type: "URLTest", now: "G #2", all: ["G #1", "G #2"], history: [] },
        "G #1": {
          name: "G #1",
          type: "vless",
          history: [{ time: "t", delay: 900 }],
          extra: { "https://policy.example": { alive: true, history: [{ time: "t", delay: 70 }] } },
        },
        "G #2": {
          name: "G #2",
          type: "vless",
          history: [{ time: "t", delay: 800 }],
          extra: { "https://policy.example": { alive: true, history: [{ time: "t", delay: 30 }] } },
        },
      },
    };
    const g = toNodeView(collapsed, undefined, "https://policy.example").all.find(
      (n) => n.name === "G",
    );
    expect(g?.delay).toBe(30); // active member G #2, per-URL
    expect(g?.members).toEqual([
      { name: "G #1", delay: 70, history: [70], active: false },
      { name: "G #2", delay: 30, history: [30], active: true },
    ]);
  });

  it("threads the default policy's test URL through listNodes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        json({
          proxies: {
            PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A"], history: [] },
            A: {
              name: "A",
              type: "vless",
              history: [{ time: "t", delay: 999 }],
              extra: {
                [DEFAULT_AUTO_TEST_URL]: { alive: true, history: [{ time: "t", delay: 42 }] },
              },
            },
          },
        }),
      ),
    );
    const view = await listNodes(freshDb());
    expect(view.all.find((n) => n.name === "A")).toMatchObject({ delay: 42, history: [42] });
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
  it("returns zero when mihomo reports a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ delay: 0 })),
    );
    expect(await testDelay("A")).toBe(0);
  });
  it("returns zero when the delay request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("err", { status: 503 })),
    );
    expect(await testDelay("A")).toBe(0);
  });
});

describe("selectNode", () => {
  it("rejects a stale node owned only by a disabled source before calling mihomo", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({
        kind: "sub",
        value: "disabled",
        label: "disabled",
        enabled: false,
        proxies: [proxy("Stale")],
      })
      .run();
    const fetch = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(selectNode(db, "PROXY", "Stale")).rejects.toThrow("Узел недоступен");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an excluded enabled node before calling mihomo", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({ kind: "sub", value: "enabled", label: "enabled", proxies: [proxy("Blocked")] })
      .run();
    setExcluded(db, "Blocked", true);
    const fetch = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(selectNode(db, "PROXY", "Blocked")).rejects.toThrow("Узел недоступен");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows enabled collapsed names and the supported virtual choices", async () => {
    const db = freshDb();
    db.insert(sources)
      .values({
        kind: "sub",
        value: "enabled",
        label: "enabled",
        proxies: [px("Shared", "a.com"), px("Shared", "b.com")],
      })
      .run();
    const fetch = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await selectNode(db, "PROXY", "Shared");
    await selectNode(db, "PROXY", "AUTO");
    await selectNode(db, "PROXY", "DIRECT");

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects unknown nodes and internal groups", async () => {
    const db = freshDb();
    const fetch = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(selectNode(db, "PROXY", "Unknown")).rejects.toThrow("Узел недоступен");
    await expect(selectNode(db, "AUTO", "Unknown")).rejects.toThrow("Группа недоступна");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("node exclusion", () => {
  it("setExcluded round-trips through getExcludedSet (idempotent add/remove)", () => {
    const db = freshDb();
    setExcluded(db, "Bad", true);
    setExcluded(db, "Bad", true); // idempotent (onConflictDoNothing)
    expect([...getExcludedSet(db)]).toEqual(["Bad"]);
    setExcluded(db, "Bad", false);
    expect(getExcludedSet(db).size).toBe(0);
  });

  it("applyConfig drops an excluded node from proxies:, PROXY, and the race", async () => {
    const db = freshDb();
    const nodes = [
      { name: "A", type: "vless", server: "a.com", port: 443, uuid: "u" },
      { name: "B", type: "vless", server: "b.com", port: 443, uuid: "u" },
    ];
    db.insert(sources).values({ kind: "sub", value: "s", label: "s", proxies: nodes }).run();
    setExcluded(db, "B", true);
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const groups = cfg["proxy-groups"] as any[];
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["A"]);
    expect(groups.find((g) => g.name === "PROXY").proxies).toEqual(["AUTO", "A", "DIRECT"]);
    expect(groups.find((g) => g.name === "AUTO").proxies).toEqual(["A"]);
  });

  it("mergeDbInventory marks an excluded DB node", () => {
    const emptyView: NodeView = { now: null, autoNow: null, all: [] };
    const out = mergeDbInventory(emptyView, [px("A", "a.com")], new Map(), new Set(["A"]));
    expect(out.all[0]?.excluded).toBe(true);
  });
});
