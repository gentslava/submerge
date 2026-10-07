import { fileURLToPath } from "node:url";
import { DEFAULT_SPEED_POLICY, type Proxy as ProxyConfig } from "@submerge/shared";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { channels, sources } from "../../db/schema.js";
import { setPool } from "../channels/pool.js";
import { createChannel, ensureDefaultChannel } from "../channels/service.js";
import { getPolicyNodeNames, setExcluded } from "./service.js";

const proxy = (name: string, server = "example.test"): ProxyConfig => ({
  name,
  server,
  port: 443,
  type: "vless",
});

describe("getPolicyNodeNames — canonical pool candidates", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
    ensureDefaultChannel(db);
    db.insert(sources)
      .values({
        id: 1,
        kind: "sub",
        value: "https://example.test/1",
        label: "Europe",
        proxies: [proxy("AUTO"), proxy("DE-1"), proxy("hop")],
        updatedAt: "2026-10-07",
        createdAt: "2026-10-07",
      })
      .run();
    db.insert(sources)
      .values({
        id: 2,
        kind: "sub",
        value: "https://example.test/2",
        label: "US",
        proxies: [proxy("US-1")],
        updatedAt: "2026-10-07",
        createdAt: "2026-10-07",
      })
      .run();
    setExcluded(db, "hop", true);
  });

  it("uses generated engine names for source membership, excluding other sources and hops", () => {
    setPool(db, "default", [{ kind: "source", ref: "1" }]);
    expect(getPolicyNodeNames(db, "default")).toEqual(["AUTO-2", "DE-1"]);
  });

  it("unions node/source membership and preserves unrestricted empty pools", () => {
    expect(getPolicyNodeNames(db, "default")).toEqual(["AUTO-2", "DE-1", "US-1"]);
    setPool(db, "default", [
      { kind: "source", ref: "1" },
      { kind: "node", ref: "US-1" },
    ]);
    expect(getPolicyNodeNames(db, "default")).toEqual(["AUTO-2", "DE-1", "US-1"]);
    setPool(db, "default", [{ kind: "node", ref: "DE-1" }]);
    expect(getPolicyNodeNames(db, "default")).toEqual(["DE-1"]);
  });

  it("does not turn stale or disabled sources into unrestricted candidates or DIRECT", () => {
    db.update(sources).set({ enabled: false }).where(eq(sources.id, 1)).run();
    setPool(db, "default", [
      { kind: "source", ref: "1" },
      { kind: "node", ref: "gone" },
    ]);
    expect(getPolicyNodeNames(db, "default")).toEqual([]);
  });

  it("keeps disabled channel policies editable without changing persisted enabled state", () => {
    const channel = createChannel(db, { name: "Work", policy: DEFAULT_SPEED_POLICY });
    db.update(channels).set({ enabled: false }).where(eq(channels.id, channel.id)).run();
    setPool(db, channel.id, [{ kind: "source", ref: "1" }]);
    expect(getPolicyNodeNames(db, channel.id)).toEqual(["AUTO-2", "DE-1"]);
    expect(db.select().from(channels).where(eq(channels.id, channel.id)).get()?.enabled).toBe(
      false,
    );
  });

  it("returns collapsed same-name pool groups rather than inventing individual targets", () => {
    db.update(sources)
      .set({ proxies: [proxy("Shared", "a.test"), proxy("Shared", "b.test")] })
      .where(eq(sources.id, 1))
      .run();
    setPool(db, "default", [{ kind: "source", ref: "1" }]);
    expect(getPolicyNodeNames(db, "default")).toEqual(["Shared"]);
  });
});
