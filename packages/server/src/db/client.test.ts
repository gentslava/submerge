import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { channelPool, channels, sources } from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

function preDirectMigrationsFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "submerge-pre-direct-"));
  mkdirSync(join(folder, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  for (let index = 0; index <= 6; index++) {
    const prefix = `${String(index).padStart(4, "0")}_`;
    const entry = journal.entries.find((candidate) => candidate.idx === index);
    if (!entry?.tag.startsWith(prefix)) throw new Error(`missing migration ${prefix}`);
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 6) }),
  );
  return folder;
}

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

  it("has a channels table after migrations", () => {
    const testDb = createDb(":memory:");
    // Apply migrations against the in-memory db the same way runMigrations does.
    migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    expect(() => testDb.select().from(channels).all()).not.toThrow();
  });

  it("has a channel_pool table after migrations", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    expect(() => testDb.select().from(channelPool).all()).not.toThrow();
  });

  it("upgrades the real pre-Direct schema without losing channels or pool rows", () => {
    const testDb = createDb(":memory:");
    migrate(testDb, { migrationsFolder: preDirectMigrationsFolder() });

    const policy = JSON.stringify({ kind: "manual", pinnedNode: "A", onFailure: "hold" });
    const matcher = JSON.stringify({
      presets: ["youtube"],
      domains: ["example.com"],
      keywords: [],
      ruleProviders: [],
      geosite: [],
      geoip: [],
      cidrs: ["10.0.0.0/8"],
    });
    const insertLegacy = testDb.$client.prepare(
      "INSERT INTO channels (id, name, priority, enabled, is_default, policy, matcher, last_reason, last_reason_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertLegacy.run("default", "Default", 7, 1, 1, policy, matcher, "default reason", 100);
    insertLegacy.run("ch-a", "A", -3, 1, 0, policy, matcher, "reason a", 101);
    insertLegacy.run("ch-b", "B", -3, 0, 0, policy, matcher, null, null);
    const insertPool = testDb.$client.prepare(
      "INSERT INTO channel_pool (channel_id, kind, ref) VALUES (?, ?, ?)",
    );
    insertPool.run("ch-a", "source", "1");
    insertPool.run("ch-a", "node", "NL-1");
    insertPool.run("ch-b", "node", "DE-1");

    migrate(testDb, { migrationsFolder });

    expect(
      testDb.$client
        .prepare(
          "SELECT id, name, priority, enabled, is_default, target, policy, matcher, last_reason, last_reason_at, direct_presets FROM channels ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "ch-a",
        name: "A",
        priority: -3,
        enabled: 1,
        is_default: 0,
        target: "proxy",
        policy,
        matcher,
        last_reason: "reason a",
        last_reason_at: 101,
        direct_presets: null,
      },
      {
        id: "ch-b",
        name: "B",
        priority: -3,
        enabled: 0,
        is_default: 0,
        target: "proxy",
        policy,
        matcher,
        last_reason: null,
        last_reason_at: null,
        direct_presets: null,
      },
      {
        id: "default",
        name: "Default",
        priority: 7,
        enabled: 1,
        is_default: 1,
        target: "proxy",
        policy,
        matcher,
        last_reason: "default reason",
        last_reason_at: 100,
        direct_presets: null,
      },
    ]);
    expect(
      testDb.$client
        .prepare("SELECT channel_id, kind, ref FROM channel_pool ORDER BY channel_id, kind, ref")
        .all(),
    ).toEqual([
      { channel_id: "ch-a", kind: "node", ref: "NL-1" },
      { channel_id: "ch-a", kind: "source", ref: "1" },
      { channel_id: "ch-b", kind: "node", ref: "DE-1" },
    ]);

    expect(() =>
      testDb.$client
        .prepare(
          "INSERT INTO channels (id, name, target, policy, matcher) VALUES ('bad-proxy', 'Bad proxy', 'proxy', NULL, '{}')",
        )
        .run(),
    ).toThrow();

    const insertDirect = testDb.$client.prepare(
      "INSERT INTO channels (id, name, target, is_default, policy, matcher, direct_presets) VALUES (?, ?, 'direct', ?, ?, '{}', ?)",
    );
    expect(() => insertDirect.run("direct-policy", "Direct policy", 0, policy, "{}")).toThrow();
    expect(() => insertDirect.run("direct-default", "Direct default", 1, null, "{}")).toThrow();
    expect(() => insertDirect.run("direct-presets", "Direct presets", 0, null, null)).toThrow();
    insertDirect.run(
      "direct",
      "Direct",
      0,
      null,
      JSON.stringify({ privateNetworks: true, localDomains: true }),
    );
    expect(() =>
      insertDirect.run(
        "direct-2",
        "Direct 2",
        0,
        null,
        JSON.stringify({ privateNetworks: true, localDomains: true }),
      ),
    ).toThrow();

    expect(testDb.$client.pragma("foreign_key_check")).toEqual([]);
    expect(testDb.$client.pragma("foreign_key_list(channel_pool)")).toEqual([
      expect.objectContaining({ table: "channels", from: "channel_id", to: "id" }),
    ]);

    testDb.$client.prepare("DELETE FROM channels WHERE id = 'ch-a'").run();
    expect(
      testDb.$client.prepare("SELECT channel_id FROM channel_pool WHERE channel_id = 'ch-a'").all(),
    ).toEqual([]);
  });
});
