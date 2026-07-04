import { fileURLToPath } from "node:url";
import { DEFAULT_AUTO_TEST_URL, DEFAULT_SPEED_POLICY } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
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
    expect(a.matcher).toEqual({ presets: [], domains: [] });
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
});
