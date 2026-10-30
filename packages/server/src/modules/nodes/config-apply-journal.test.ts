import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { ensureDefaultChannel, readDefaultChannel, setDefaultRoute } from "../channels/service.js";
import { getSetting, getSettingsView, setSetting } from "../settings/service.js";
import {
  beginConfigApply,
  finishConfigApply,
  readConfigApplyRecovery,
  recordConfigApplyCandidate,
} from "./config-apply-journal.js";

describe("common config apply journal", () => {
  let directory: string;
  let configPath: string;
  let db: Db;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "config-apply-journal-"));
    configPath = join(directory, "config.yaml");
    db = createDb(join(directory, "test.db"));
    migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    ensureDefaultChannel(db);
    setDefaultRoute(db, "direct");
    writeFileSync(configPath, "accepted config with a private credential");
  });
  afterEach(() => {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("atomically rolls back both the staged mutation and journal when staging throws", () => {
    expect(() =>
      db.transaction(() => {
        beginConfigApply(db, configPath);
        setDefaultRoute(db, "proxy");
        throw new Error("staging failed");
      }),
    ).toThrow("staging failed");
    expect(readDefaultChannel(db).defaultRoute).toBe("direct");
    expect(getSetting(db, "internal.configApply")).toBeUndefined();
  });

  it("uses the accepted route without discarding the desired settings or exposing the journal", () => {
    db.transaction(() => {
      beginConfigApply(db, configPath);
      setDefaultRoute(db, "proxy");
    });
    expect(readConfigApplyRecovery(db, configPath)).toEqual({
      pending: true,
      defaultRoute: "direct",
    });
    expect(readDefaultChannel(db).defaultRoute).toBe("proxy");
    expect(getSetting(db, "internal.configApply")).not.toContain("private credential");
    expect(getSettingsView(db)).not.toHaveProperty("internal.configApply");
  });

  it("recognizes a candidate at the accepted path but retains pending proof until confirmation", () => {
    const attempt = beginConfigApply(db, configPath);
    setDefaultRoute(db, "proxy");
    recordConfigApplyCandidate(db, configPath, "candidate");
    expect(() => finishConfigApply(db, attempt)).toThrow("not durable");
    writeFileSync(configPath, "candidate");
    expect(readConfigApplyRecovery(db, configPath)).toEqual({
      pending: true,
      defaultRoute: "proxy",
    });
    expect(getSetting(db, "internal.configApply")).toBeDefined();
    finishConfigApply(db, attempt);
    expect(readConfigApplyRecovery(db, configPath)).toEqual({
      pending: false,
      defaultRoute: "proxy",
    });
  });

  it("restores a previous pending journal if a subsequent staged change is rolled back", () => {
    beginConfigApply(db, configPath);
    setDefaultRoute(db, "proxy");
    recordConfigApplyCandidate(db, configPath, "candidate");
    const previous = getSetting(db, "internal.configApply");
    const retry = beginConfigApply(db, configPath);
    setDefaultRoute(db, "direct");
    db.transaction(() => {
      setDefaultRoute(db, "proxy");
      finishConfigApply(db, retry, true);
    });
    expect(getSetting(db, "internal.configApply")).toBe(previous);
    expect(readConfigApplyRecovery(db, configPath)).toEqual({
      pending: true,
      defaultRoute: "direct",
    });
  });

  it.each(["modified", "missing", "path", "invalid-json", "invalid-schema", "invalid-utf8"])(
    "rejects %s proof without changing desired settings or the file",
    (fault) => {
      beginConfigApply(db, configPath);
      setDefaultRoute(db, "proxy");
      if (fault === "modified") writeFileSync(configPath, "unknown config");
      if (fault === "missing") rmSync(configPath);
      if (fault === "invalid-json") setSetting(db, "internal.configApply", "{");
      if (fault === "invalid-schema") setSetting(db, "internal.configApply", "{}");
      if (fault === "invalid-utf8") writeFileSync(configPath, Buffer.from([0xff]));
      const before = fault === "missing" ? null : readFileSync(configPath);
      const path = fault === "path" ? join(directory, "other.yaml") : configPath;
      expect(() => readConfigApplyRecovery(db, path)).toThrow();
      expect(() => beginConfigApply(db, path)).toThrow();
      expect(readDefaultChannel(db).defaultRoute).toBe("proxy");
      expect(getSetting(db, "internal.configApply")).toBeDefined();
      if (before) expect(readFileSync(configPath)).toEqual(before);
    },
  );

  it("allows initial generation only when no accepted file existed", () => {
    rmSync(configPath);
    beginConfigApply(db, configPath);
    setDefaultRoute(db, "proxy");
    expect(readConfigApplyRecovery(db, configPath)).toEqual({
      pending: true,
      defaultRoute: "direct",
    });
    recordConfigApplyCandidate(db, configPath, "initial config");
    writeFileSync(configPath, "initial config");
    expect(readConfigApplyRecovery(db, configPath)).toEqual({
      pending: true,
      defaultRoute: "proxy",
    });
  });
});
