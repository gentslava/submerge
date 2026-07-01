import { fileURLToPath } from "node:url";
import { DEFAULT_AUTO_TEST_URL, DEFAULT_SPEED_POLICY } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { setSetting } from "../settings/service.js";
import {
  ensureDefaultChannel,
  policyProbe,
  readDefaultPolicy,
  setChannelPolicy,
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
