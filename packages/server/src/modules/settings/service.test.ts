import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../../db/client.js";
import {
  getAllSettings,
  getOrCreateHwid,
  getOrCreateInternalSecret,
  getSetting,
  getSettingsView,
  setSetting,
} from "./service.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}

describe("settings service", () => {
  it("sets, gets, and lists settings", () => {
    const db = freshDb();
    setSetting(db, "theme", "dark");
    expect(getSetting(db, "theme")).toBe("dark");
    expect(getSetting(db, "missing")).toBeUndefined();
    setSetting(db, "poll", "5");
    setSetting(db, "empty", "");
    expect(getSetting(db, "empty")).toBe("");
    expect(getAllSettings(db)).toEqual({ theme: "dark", poll: "5", empty: "" });
  });

  it("upserts an existing key", () => {
    const db = freshDb();
    setSetting(db, "theme", "dark");
    setSetting(db, "theme", "light");
    expect(getSetting(db, "theme")).toBe("light");
  });

  it("rejects oversized writes and does not materialize oversized corrupt values", () => {
    const db = freshDb();
    const oversized = "x".repeat(1_048_577);

    expect(() => setSetting(db, "domainIntelligence", oversized)).toThrow();
    expect(() => setSetting(db, "nulSetting", "{}\0garbage")).toThrow();
    db.$client
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("domainIntelligence", oversized);
    db.$client
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("nulSetting", `{}\0${"x".repeat(1_048_577)}`);
    db.$client
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("blobSetting", Buffer.from("dark"));
    db.$client
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(Buffer.from("blobKey"), "dark");
    setSetting(db, "�", "replacement-value");
    db.$client.exec(
      "INSERT INTO settings (key, value) VALUES ('invalidUtf8Value', cast(x'80' as text))",
    );
    db.$client.exec(
      "INSERT INTO settings (key, value) VALUES (cast(x'80' as text), 'invalid-key-value')",
    );
    expect(getSetting(db, "domainIntelligence")).toBeUndefined();
    expect(getSetting(db, "nulSetting")).toBeUndefined();
    expect(getSetting(db, "blobSetting")).toBeUndefined();
    expect(getSetting(db, "blobKey")).toBeUndefined();
    expect(getSetting(db, "\uD800")).toBeUndefined();
    expect(getSetting(db, "\uDC00")).toBeUndefined();
    expect(getSetting(db, "�")).toBe("replacement-value");
    expect(getSetting(db, "invalidUtf8Value")).toBeUndefined();
    expect(getAllSettings(db)).not.toHaveProperty("domainIntelligence");
    expect(getAllSettings(db)).not.toHaveProperty("nulSetting");
    expect(getAllSettings(db)).not.toHaveProperty("blobSetting");
    expect(getAllSettings(db)).not.toHaveProperty("blobKey");
    expect(getAllSettings(db)).not.toHaveProperty("invalidUtf8Value");
    expect(getAllSettings(db)).toMatchObject({ "�": "replacement-value" });
    expect(Object.values(getAllSettings(db))).not.toContain("invalid-key-value");
  });

  it("persists internal secrets without exposing them in the settings API view", () => {
    const db = freshDb();
    const key = "internal.domainValidationProxyPassword";
    const secret = getOrCreateInternalSecret(db, key);
    setSetting(db, "domainIntelligence", '{"enabled":false}');

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(getOrCreateInternalSecret(db, key)).toBe(secret);
    expect(getSetting(db, key)).toBe(secret);
    expect(getSettingsView(db)).not.toHaveProperty(key);
    expect(getSettingsView(db)).not.toHaveProperty("domainIntelligence");
    expect(JSON.stringify(getSettingsView(db))).not.toContain(secret);
    expect(() => getOrCreateInternalSecret(db, "public-setting")).toThrow(
      "internal secret key is not protected",
    );
  });

  it("generates a hwid, persists it, and mirrors it to the file", () => {
    const db = freshDb();
    const file = join(mkdtempSync(join(tmpdir(), "submerge-")), "hwid.txt");
    const hwid = getOrCreateHwid(db, file);
    expect(hwid).toMatch(/^[0-9a-f]{32}$/);
    expect(getSetting(db, "hwid")).toBe(hwid); // persisted in DB
    expect(readFileSync(file, "utf8").trim()).toBe(hwid); // mirrored to file
    expect(getOrCreateHwid(db, file)).toBe(hwid); // stable on second call
  });

  it("adopts hwid from an existing file when DB is empty", () => {
    const db = freshDb();
    const file = join(mkdtempSync(join(tmpdir(), "submerge-")), "hwid.txt");
    const existing = "aabbccddeeff00112233445566778899";
    writeFileSync(file, `${existing}\n`); // trailing newline as the PoC writes
    const hwid = getOrCreateHwid(db, file);
    expect(hwid).toBe(existing); // adopted, not regenerated
    expect(getSetting(db, "hwid")).toBe(existing); // now persisted to DB
  });
});
