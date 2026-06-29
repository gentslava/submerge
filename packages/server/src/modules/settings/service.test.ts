import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "../../db/client.js";
import { getAllSettings, getOrCreateHwid, getSetting, setSetting } from "./service.js";

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
    expect(getAllSettings(db)).toEqual({ theme: "dark", poll: "5" });
  });

  it("upserts an existing key", () => {
    const db = freshDb();
    setSetting(db, "theme", "dark");
    setSetting(db, "theme", "light");
    expect(getSetting(db, "theme")).toBe("light");
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
