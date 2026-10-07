import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createReadOnlyDb } from "./read-only.js";
import { settings } from "./schema.js";

describe("read-only database", () => {
  it("reads existing state but rejects mutations without changing the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "submerge-readonly-db-")), "submerge.db");
    const writable = new Database(path);
    writable.exec("CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    writable.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("mode", "report");
    writable.close();
    const before = readFileSync(path);

    const db = createReadOnlyDb(path);

    try {
      expect(db.select().from(settings).where(eq(settings.key, "mode")).get()).toEqual({
        key: "mode",
        value: "report",
      });
      expect(() => db.insert(settings).values({ key: "write", value: "blocked" }).run()).toThrow();
      expect(readFileSync(path)).toEqual(before);
    } finally {
      db.$client.close();
    }
  });

  it("does not create a missing database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "submerge-readonly-missing-")), "missing.db");

    expect(() => createReadOnlyDb(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
