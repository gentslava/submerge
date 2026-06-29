import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { sources } from "./schema.js";

describe("db", () => {
  it("creates and reads a source in an in-memory DB", () => {
    // Use :memory: so the test never touches the filesystem.
    const db = createDb(":memory:");
    migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

    db.insert(sources).values({ kind: "sub", value: "https://x", label: "X" }).run();

    const rows = db.select().from(sources).where(eq(sources.kind, "sub")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
    expect(rows[0]?.hwid).toBe(false);
    expect(rows[0]?.proxies).toEqual([]);
  });
});
