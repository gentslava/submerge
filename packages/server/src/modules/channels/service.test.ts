import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTO_TEST_URL, DEFAULT_SPEED_POLICY } from "@submerge/shared";
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
  listChannels,
  policyProbe,
  readChannel,
  readDefaultChannel,
  readDefaultPolicy,
  reorderChannels,
  setChannelPolicy,
  updateChannel,
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
    expect(a.isDefault).toBe(false);
    expect(a.matcher).toEqual({
      presets: [],
      domains: [],
      keywords: [],
      ruleProviders: [],
      geosite: [],
      geoip: [],
    });
    const defaultPriority = readDefaultChannel(db).priority;
    expect(a.priority).toBeLessThan(defaultPriority);
    expect(b.priority).toBeLessThan(defaultPriority);
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
    };
    db.insert(channels)
      .values({
        id: "legacy",
        name: "Legacy",
        priority: 1,
        enabled: true,
        isDefault: false,
        policy: manualPolicy,
        matcher,
      })
      .run();

    expect(readChannel(db, "legacy")?.matcher).toEqual(matcher);
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

  it("persists a new matcher and reflects it in the regenerated config's DOMAIN-SUFFIX rules", async () => {
    const db = freshDb();
    ensureDefaultChannel(db);
    db.insert(sources)
      .values({ kind: "sub", value: "a", label: "a", proxies: [proxy("A")] })
      .run();
    const created = createChannel(db, { name: "Media", policy: manualPolicy });

    updateChannel(db, created.id, { matcher: { presets: ["youtube"], domains: ["ex.com"] } });

    // The row itself reflects the new matcher — updateChannel persisted it.
    const updated = readChannel(db, created.id);
    expect(updated?.matcher).toEqual({
      presets: ["youtube"],
      domains: ["ex.com"],
      keywords: [],
      ruleProviders: [],
      geosite: [],
      geoip: [],
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
  });
});
