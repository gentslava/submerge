import { fileURLToPath } from "node:url";
import { type Channel, emptyChannelMatcher } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { channels, sources } from "../../db/schema.js";
import { getPool, groupNameFor, resolveChannelProxies, setPool } from "./pool.js";
import { ensureDefaultChannel } from "./service.js";

function freshDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
  return db;
}

function proxy(name: string, server: string, port: number) {
  return { name, type: "vless", server, port };
}

const manualPolicy = { kind: "manual", pinnedNode: "X", onFailure: "hold" } as const;

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: "ch1",
    name: "Streaming",
    target: "proxy",
    priority: -1,
    enabled: true,
    isDefault: false,
    policy: manualPolicy,
    matcher: emptyChannelMatcher(),
    lastReason: null,
    lastReasonAt: null,
    ...overrides,
  };
}

describe("groupNameFor", () => {
  it("returns AUTO for the default channel", () => {
    expect(groupNameFor(channel({ id: "default", isDefault: true }))).toBe("AUTO");
  });

  it("returns ch-<id> for a non-default channel", () => {
    expect(groupNameFor(channel({ id: "ch1", isDefault: false }))).toBe("ch-ch1");
  });
});

describe("getPool / setPool", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
    ensureDefaultChannel(db);
  });

  it("starts empty", () => {
    expect(getPool(db, "default")).toEqual([]);
  });

  it("replaces the pool and dedupes repeated members", () => {
    setPool(db, "default", [
      { kind: "node", ref: "A" },
      { kind: "node", ref: "A" }, // duplicate, must be deduped
      { kind: "source", ref: "1" },
    ]);
    expect(getPool(db, "default")).toEqual([
      { kind: "node", ref: "A" },
      { kind: "source", ref: "1" },
    ]);

    // A second call fully replaces the previous set (not a merge).
    setPool(db, "default", [{ kind: "node", ref: "B" }]);
    expect(getPool(db, "default")).toEqual([{ kind: "node", ref: "B" }]);
  });
});

describe("resolveChannelProxies", () => {
  let db: Db;
  const ch = channel({ id: "ch1", isDefault: false });
  const allProxies = [
    proxy("A", "a.example", 443),
    proxy("B", "b.example", 443),
    proxy("C", "c.example", 443),
  ];

  beforeEach(() => {
    db = freshDb();
    ensureDefaultChannel(db);
    db.insert(channels)
      .values({
        id: "ch1",
        name: "Streaming",
        target: "proxy",
        priority: -1,
        policy: manualPolicy,
      })
      .run();
  });

  it("returns all proxies when the pool is empty (all-nodes, like Default)", () => {
    expect(resolveChannelProxies(db, ch, allProxies)).toEqual(allProxies);
  });

  it("resolves a source member to that source's proxies", () => {
    const sourceProxies = [proxy("S1", "s1.example", 1080), proxy("S2", "s2.example", 1080)];
    const src = db
      .insert(sources)
      .values({ kind: "vless", value: "vless://s", label: "Src", proxies: sourceProxies })
      .returning()
      .get();
    setPool(db, "ch1", [{ kind: "source", ref: String(src.id) }]);
    expect(resolveChannelProxies(db, ch, allProxies)).toEqual(sourceProxies);
  });

  it("skips a disabled source member", () => {
    const sourceProxies = [proxy("S1", "s1.example", 1080)];
    const src = db
      .insert(sources)
      .values({
        kind: "vless",
        value: "vless://disabled",
        label: "Disabled source",
        enabled: false,
        proxies: sourceProxies,
      })
      .returning()
      .get();
    setPool(db, "ch1", [{ kind: "source", ref: String(src.id) }]);

    expect(resolveChannelProxies(db, ch, allProxies)).toEqual([]);
  });

  it("resolves a node member to the matching proxy in allProxies", () => {
    setPool(db, "ch1", [{ kind: "node", ref: "B" }]);
    expect(resolveChannelProxies(db, ch, allProxies)).toEqual([proxy("B", "b.example", 443)]);
  });

  it("skips a node ref that doesn't match any proxy (best-effort)", () => {
    setPool(db, "ch1", [
      { kind: "node", ref: "missing" },
      { kind: "node", ref: "A" },
    ]);
    expect(resolveChannelProxies(db, ch, allProxies)).toEqual([proxy("A", "a.example", 443)]);
  });

  it("skips a source ref that doesn't exist (best-effort)", () => {
    setPool(db, "ch1", [
      { kind: "source", ref: "999" },
      { kind: "node", ref: "A" },
    ]);
    expect(resolveChannelProxies(db, ch, allProxies)).toEqual([proxy("A", "a.example", 443)]);
  });

  it("de-dupes by server:port across source+node members, preserving first-seen order", () => {
    // This source redundantly carries a proxy with the same server:port as node ref "A".
    const sourceProxies = [proxy("A", "a.example", 443), proxy("D", "d.example", 8080)];
    const src = db
      .insert(sources)
      .values({ kind: "vless", value: "vless://s2", label: "Src2", proxies: sourceProxies })
      .returning()
      .get();
    setPool(db, "ch1", [
      { kind: "source", ref: String(src.id) },
      { kind: "node", ref: "A" },
      { kind: "node", ref: "B" },
    ]);
    expect(resolveChannelProxies(db, ch, allProxies)).toEqual([
      proxy("A", "a.example", 443),
      proxy("D", "d.example", 8080),
      proxy("B", "b.example", 443),
    ]);
  });
});
