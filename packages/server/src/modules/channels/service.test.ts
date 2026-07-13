import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTO_TEST_URL, DEFAULT_SPEED_POLICY, emptyChannelMatcher } from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { channels, sources } from "../../db/schema.js";
import { applyConfig } from "../nodes/service.js";
import { setSetting } from "../settings/service.js";
import { getPool, setPool } from "./pool.js";
import {
  createChannel,
  deleteChannel,
  ensureDefaultChannel,
  ensureDirectChannel,
  listChannels,
  policyProbe,
  readChannel,
  readDefaultChannel,
  readDefaultPolicy,
  reorderChannels,
  setChannelLastReason,
  setChannelPolicy,
  updateChannel,
  updateDirect,
} from "./service.js";

function freshDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
  return db;
}

describe("ensureDefaultChannel", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it("seeds a default speed channel when none exists", () => {
    ensureDefaultChannel(db);
    expect(readDefaultPolicy(db)).toEqual(DEFAULT_SPEED_POLICY);
  });

  it("is idempotent", () => {
    ensureDefaultChannel(db);
    setChannelPolicy(db, "default", { ...DEFAULT_SPEED_POLICY, intervalSec: 42 });
    ensureDefaultChannel(db); // must NOT overwrite an existing row
    expect(readDefaultPolicy(db).intervalSec).toBe(42);
  });

  it("migrates legacy auto* settings into the default speed policy", () => {
    setSetting(db, "autoTestUrl", "https://legacy/probe");
    setSetting(db, "autoTestInterval", "77");
    setSetting(db, "autoTestTolerance", "10");
    setSetting(db, "autoSwitchOnTimeout", "false");
    ensureDefaultChannel(db);
    expect(readDefaultPolicy(db)).toEqual({
      kind: "speed",
      testUrl: "https://legacy/probe",
      intervalSec: 77,
      toleranceMs: 10,
      reevaluateWhileHealthy: false,
    });
  });
});

describe("policyProbe", () => {
  it("returns a sticky policy's own url + interval", () => {
    expect(
      policyProbe({
        kind: "sticky",
        testUrl: "https://s/probe",
        intervalSec: 30,
        failureThreshold: 3,
        maxHoldHours: null,
        initialCriterion: "fastest",
      }),
    ).toEqual({ url: "https://s/probe", intervalSec: 30 });
  });
  it("falls back to defaults for a manual policy", () => {
    expect(policyProbe({ kind: "manual", pinnedNode: "X", onFailure: "hold" })).toEqual({
      url: DEFAULT_AUTO_TEST_URL,
      intervalSec: expect.any(Number),
    });
  });
});

const manualPolicy = { kind: "manual", pinnedNode: "X", onFailure: "hold" } as const;

function insertDirect(db: Db, overrides: Partial<typeof channels.$inferInsert> = {}): void {
  db.insert(channels)
    .values({
      id: "direct",
      name: "Direct",
      target: "direct",
      priority: 0,
      enabled: true,
      isDefault: false,
      policy: null,
      matcher: emptyChannelMatcher(),
      directPresets: { privateNetworks: true, localDomains: true },
      ...overrides,
    })
    .run();
}

function expectBadRequest(run: () => unknown, message: string): void {
  try {
    run();
    throw new Error("expected BAD_REQUEST");
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: "BAD_REQUEST", message });
  }
}

describe("ensureDirectChannel", () => {
  it("creates the enabled system Direct channel at priority zero with both presets", () => {
    const db = freshDb();
    ensureDefaultChannel(db);

    ensureDirectChannel(db);

    expect(listChannels(db)).toEqual([
      {
        id: "direct",
        name: "Direct",
        target: "direct",
        priority: 0,
        enabled: true,
        isDefault: false,
        matcher: emptyChannelMatcher(),
        directPresets: { privateNetworks: true, localDomains: true },
      },
      expect.objectContaining({ id: "default", target: "proxy", priority: 1 }),
    ]);
  });

  it("is idempotent and preserves all persisted Direct settings and priority", () => {
    const db = freshDb();
    ensureDefaultChannel(db);
    insertDirect(db, {
      priority: 7,
      enabled: false,
      matcher: { ...emptyChannelMatcher(), domains: ["example.com"] },
      directPresets: { privateNetworks: false, localDomains: true },
    });

    ensureDirectChannel(db);

    expect(readChannel(db, "direct")).toEqual({
      id: "direct",
      name: "Direct",
      target: "direct",
      priority: 7,
      enabled: false,
      isDefault: false,
      matcher: { ...emptyChannelMatcher(), domains: ["example.com"] },
      directPresets: { privateNetworks: false, localDomains: true },
    });
  });

  it("captures tied legacy order by priority/id and repacks it after Direct", () => {
    const db = freshDb();
    ensureDefaultChannel(db);
    const b = createChannel(db, { name: "B", policy: manualPolicy });
    const a = createChannel(db, { name: "A", policy: manualPolicy });
    db.update(channels).set({ priority: -4 }).where(eq(channels.id, a.id)).run();
    db.update(channels).set({ priority: -4 }).where(eq(channels.id, b.id)).run();
    db.update(channels).set({ priority: -9 }).where(eq(channels.id, "default")).run();

    ensureDirectChannel(db);

    expect(listChannels(db).map(({ id, priority }) => [id, priority])).toEqual([
      ["direct", 0],
      [b.id, 1],
      [a.id, 2],
      ["default", 3],
    ]);
  });

  it("renames normalized legacy Direct conflicts without colliding with existing suffixes", () => {
    const db = freshDb();
    ensureDefaultChannel(db);
    for (const [index, name] of [" Direct ", "Direct (custom)", "direct"].entries()) {
      db.insert(channels)
        .values({
          id: `legacy-${index}`,
          name,
          target: "proxy",
          priority: -1,
          enabled: true,
          isDefault: false,
          policy: manualPolicy,
          matcher: emptyChannelMatcher(),
        })
        .run();
    }

    ensureDirectChannel(db);

    expect(listChannels(db).map((channel) => channel.name)).toEqual([
      "Direct",
      "Direct (custom 2)",
      "Direct (custom)",
      "Direct (custom 3)",
      "Default",
    ]);
  });

  it("fails explicitly on a malformed persisted Direct identity before mutating rows", () => {
    const wrongTargetId = freshDb();
    ensureDefaultChannel(wrongTargetId);
    insertDirect(wrongTargetId, { id: "wrong", name: "Wrong" });
    expect(() => ensureDirectChannel(wrongTargetId)).toThrow(
      "Direct channel storage is corrupt: target must use id/name direct/Direct",
    );
    expect(wrongTargetId.select().from(channels).all()).toHaveLength(2);

    const proxyDirectId = freshDb();
    ensureDefaultChannel(proxyDirectId);
    dbInsertProxyWithId(proxyDirectId, "direct");
    expect(() => ensureDirectChannel(proxyDirectId)).toThrow(
      'Direct channel storage is corrupt: id "direct" must target direct',
    );
    expect(proxyDirectId.select().from(channels).all()).toHaveLength(2);
  });

  it("falls back corrupt matcher and presets independently", () => {
    const badMatcher = freshDb();
    ensureDefaultChannel(badMatcher);
    insertDirect(badMatcher, {
      matcher: "broken" as never,
      directPresets: { privateNetworks: false, localDomains: true },
    });
    ensureDirectChannel(badMatcher);
    expect(readChannel(badMatcher, "direct")).toMatchObject({
      matcher: emptyChannelMatcher(),
      directPresets: { privateNetworks: false, localDomains: true },
    });

    const badPresets = freshDb();
    ensureDefaultChannel(badPresets);
    insertDirect(badPresets, {
      matcher: { ...emptyChannelMatcher(), domains: ["example.com"] },
      directPresets: { invalid: true } as never,
    });
    ensureDirectChannel(badPresets);
    expect(readChannel(badPresets, "direct")).toMatchObject({
      matcher: { domains: ["example.com"] },
      directPresets: { privateNetworks: true, localDomains: true },
    });
  });
});

function dbInsertProxyWithId(db: Db, id: string): void {
  db.insert(channels)
    .values({
      id,
      name: "Legacy",
      target: "proxy",
      priority: -1,
      enabled: true,
      isDefault: false,
      policy: manualPolicy,
      matcher: emptyChannelMatcher(),
    })
    .run();
}

describe("channel CRUD", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
    ensureDefaultChannel(db);
  });

  it("createChannel assigns a deterministic id and a priority before Default", () => {
    const a = createChannel(db, { name: "Streaming", policy: manualPolicy });
    const b = createChannel(db, { name: "Gaming", policy: manualPolicy });
    expect(a.id).toBe("ch1");
    expect(b.id).toBe("ch2");
    expect(a.target).toBe("proxy");
    expect(a.isDefault).toBe(false);
    expect(a.matcher).toEqual({
      presets: [],
      domains: [],
      keywords: [],
      ruleProviders: [],
      geosite: [],
      geoip: [],
      cidrs: [],
    });
    const defaultPriority = readDefaultChannel(db).priority;
    expect(a.priority).toBeLessThan(defaultPriority);
    expect(b.priority).toBeLessThan(defaultPriority);
  });

  it("appends new proxy channels without tying Direct or Default priorities", () => {
    ensureDirectChannel(db);

    const first = createChannel(db, { name: "Streaming", policy: manualPolicy });
    const second = createChannel(db, { name: "Gaming", policy: manualPolicy });

    expect(listChannels(db).map(({ id, priority }) => [id, priority])).toEqual([
      ["direct", 0],
      [first.id, 1],
      [second.id, 2],
      ["default", 3],
    ]);
  });

  it("trims proxy names and rejects the reserved Direct name on create and rename", () => {
    const created = createChannel(db, { name: "  Streaming  ", policy: manualPolicy });
    expect(created.name).toBe("Streaming");
    expectBadRequest(
      () => createChannel(db, { name: " direct ", policy: manualPolicy }),
      "Direct is a reserved channel name",
    );
    expectBadRequest(
      () => updateChannel(db, created.id, { name: " DIRECT " }),
      "Direct is a reserved channel name",
    );
    expect(readChannel(db, created.id)?.name).toBe("Streaming");
  });

  it("listChannels orders by priority asc, id asc, with Default last", () => {
    createChannel(db, { name: "Streaming", policy: manualPolicy });
    createChannel(db, { name: "Gaming", policy: manualPolicy });
    const list = listChannels(db);
    expect(list.map((c) => c.id)).toEqual(["ch1", "ch2", "default"]);
  });

  it("readChannel returns undefined for a missing id", () => {
    expect(readChannel(db, "nope")).toBeUndefined();
  });

  it("keeps the rest of a legacy matcher when a stored provider URL has no host", () => {
    const matcher = {
      presets: ["youtube"],
      domains: ["example.com"],
      keywords: [],
      ruleProviders: [{ url: "http://", behavior: "domain" as const }],
      geosite: [],
      geoip: [],
      cidrs: ["not-a-cidr"],
    };
    db.insert(channels)
      .values({
        id: "legacy",
        name: "Legacy",
        target: "proxy",
        priority: 1,
        enabled: true,
        isDefault: false,
        policy: manualPolicy,
        matcher,
      })
      .run();

    expect(readChannel(db, "legacy")?.matcher).toEqual(matcher);
  });

  it("falls back corrupt policy and matcher fields independently", () => {
    db.insert(channels)
      .values({
        id: "bad-policy",
        name: "Bad policy",
        target: "proxy",
        priority: 1,
        enabled: true,
        isDefault: false,
        policy: { invalid: true } as never,
        matcher: { ...emptyChannelMatcher(), domains: ["example.com"] },
      })
      .run();
    db.insert(channels)
      .values({
        id: "bad-matcher",
        name: "Bad matcher",
        target: "proxy",
        priority: 2,
        enabled: true,
        isDefault: false,
        policy: manualPolicy,
        matcher: "not a matcher" as never,
      })
      .run();

    expect(readChannel(db, "bad-policy")).toMatchObject({
      policy: DEFAULT_SPEED_POLICY,
      matcher: { domains: ["example.com"] },
    });
    expect(readChannel(db, "bad-matcher")).toMatchObject({
      policy: manualPolicy,
      matcher: emptyChannelMatcher(),
    });
  });

  it("updateChannel patches name/enabled/matcher without touching other fields", () => {
    const created = createChannel(db, { name: "Streaming", policy: manualPolicy });
    updateChannel(db, created.id, { name: "Streaming EU", enabled: false });
    const updated = readChannel(db, created.id);
    expect(updated?.name).toBe("Streaming EU");
    expect(updated?.enabled).toBe(false);
    expect(updated?.policy).toEqual(manualPolicy); // untouched
  });

  it("deleteChannel refuses to delete the Default channel", () => {
    expect(() => deleteChannel(db, "default")).toThrow();
  });

  it("rejects every proxy-only Direct mutation with a typed BAD_REQUEST", () => {
    insertDirect(db);
    expectBadRequest(
      () => updateChannel(db, "direct", { enabled: false }),
      "Direct channel cannot use proxy update",
    );
    expectBadRequest(
      () => setChannelPolicy(db, "direct", manualPolicy),
      "Direct channel cannot use policy",
    );
    expectBadRequest(
      () => setChannelLastReason(db, "direct", "reason", 1),
      "Direct channel cannot use controller state",
    );
    expectBadRequest(() => deleteChannel(db, "direct"), "Direct channel cannot be deleted");
    expect(readChannel(db, "direct")).toMatchObject({ enabled: true, target: "direct" });
  });

  it("updates enabled, matcher, and presets atomically and returns Direct", () => {
    insertDirect(db);
    const updated = updateDirect(db, {
      enabled: false,
      matcher: { ...emptyChannelMatcher(), cidrs: ["10.0.0.0/8"] },
      directPresets: { privateNetworks: false, localDomains: true },
    });

    expect(updated).toEqual({
      id: "direct",
      name: "Direct",
      target: "direct",
      priority: 0,
      enabled: false,
      isDefault: false,
      matcher: { ...emptyChannelMatcher(), cidrs: ["10.0.0.0/8"] },
      directPresets: { privateNetworks: false, localDomains: true },
    });
  });

  it("deleteChannel removes the channel and its pool rows", () => {
    const created = createChannel(db, { name: "Streaming", policy: manualPolicy });
    setPool(db, created.id, [{ kind: "node", ref: "A" }]);
    deleteChannel(db, created.id);
    expect(readChannel(db, created.id)).toBeUndefined();
    expect(getPool(db, created.id)).toEqual([]);
  });

  it("reorderChannels assigns priorities in the given order and forces Default last", () => {
    const a = createChannel(db, { name: "Streaming", policy: manualPolicy });
    const b = createChannel(db, { name: "Gaming", policy: manualPolicy });
    // Even when Default is listed first, it must end up last.
    reorderChannels(db, ["default", b.id, a.id]);
    const list = listChannels(db);
    expect(list.map((c) => c.id)).toEqual([b.id, a.id, "default"]);
  });

  it("reorders Direct first, middle, or last before the terminal Default", () => {
    const a = createChannel(db, { name: "Streaming", policy: manualPolicy });
    const b = createChannel(db, { name: "Gaming", policy: manualPolicy });
    insertDirect(db);

    for (const order of [
      ["direct", a.id, b.id],
      [a.id, "direct", b.id],
      [a.id, b.id, "direct"],
    ]) {
      reorderChannels(db, order);
      expect(listChannels(db).map((channel) => channel.id)).toEqual([...order, "default"]);
    }
  });

  it("keeps a disabled Direct reorderable while Default remains terminal", () => {
    const a = createChannel(db, { name: "Streaming", policy: manualPolicy });
    const b = createChannel(db, { name: "Gaming", policy: manualPolicy });
    insertDirect(db, { enabled: false });

    for (const order of [
      ["direct", a.id, b.id],
      [a.id, "direct", b.id],
      [a.id, b.id, "direct"],
    ]) {
      reorderChannels(db, order);
      const listed = listChannels(db);
      expect(listed.map((channel) => channel.id)).toEqual([...order, "default"]);
      expect(listed.find((channel) => channel.id === "direct")).toMatchObject({
        enabled: false,
        target: "direct",
      });
    }
  });

  it("rejects a partial, duplicate, or unknown non-default channel order", () => {
    const a = createChannel(db, { name: "Streaming", policy: manualPolicy });
    const b = createChannel(db, { name: "Gaming", policy: manualPolicy });

    expect(() => reorderChannels(db, [a.id])).toThrow(/complete channel order/i);
    expect(() => reorderChannels(db, [a.id, a.id])).toThrow(/complete channel order/i);
    expect(() => reorderChannels(db, [a.id, `${b.id}-unknown`])).toThrow(/complete channel order/i);
  });
});

describe("updateChannel matcher persistence + config regeneration", () => {
  const proxy = (name: string) => ({ name, type: "vless", server: "ex.com", port: 443, uuid: "u" });

  afterEach(() => vi.unstubAllGlobals());

  it("persists a new matcher and carries domains and CIDRs into regenerated rules", async () => {
    const db = freshDb();
    ensureDefaultChannel(db);
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const created = createChannel(db, { name: "Media", policy: manualPolicy });

    updateChannel(db, created.id, {
      matcher: { presets: ["youtube"], domains: ["ex.com"], cidrs: ["10.0.0.0/8"] },
    });

    // The row itself reflects the new matcher — updateChannel persisted it.
    const updated = readChannel(db, created.id);
    expect(updated?.matcher).toEqual({
      presets: ["youtube"],
      domains: ["ex.com"],
      keywords: [],
      ruleProviders: [],
      geosite: [],
      geoip: [],
      cidrs: ["10.0.0.0/8"],
    });

    // And the regenerated config's rules — resolveMatcherDomains(matcher) fed into
    // buildMultiConfig via applyConfig — carry both the custom domain and the
    // preset-expanded one, addressed to this channel's own group.
    const configPath = join(mkdtempSync(join(tmpdir(), "submerge-")), "config.yaml");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(null, { status: 204 })),
    );
    await applyConfig(db, configPath, "/root/.config/mihomo/config.yaml");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const cfg = yaml.load(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(cfg.rules).toContain(`DOMAIN-SUFFIX,ex.com,ch-${created.id}`);
    expect(cfg.rules).toContain(`DOMAIN-SUFFIX,youtube.com,ch-${created.id}`);
    expect(cfg.rules).toContain(`IP-CIDR,10.0.0.0/8,ch-${created.id}`);
  });
});
