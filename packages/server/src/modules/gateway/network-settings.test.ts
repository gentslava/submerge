import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { createDb } from "../../db/client.js";
import { channels, settings } from "../../db/schema.js";
import {
  ensureDefaultChannel,
  ensureDirectChannel,
  listChannels,
  updateDirect,
} from "../channels/service.js";
import { getSetting, setSetting } from "../settings/service.js";
import {
  initializeNetworkSettings,
  readNetworkSettings,
  writeNetworkSettings,
} from "./settings.js";

it("moves legacy routing once and keeps mode changes independent of Direct", () => {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  ensureDefaultChannel(db);
  ensureDirectChannel(db);
  setSetting(
    db,
    "networkProfile",
    JSON.stringify({
      profile: "gateway",
      localResolvers: ["192.168.1.1"],
      ruZones: ["ru"],
      ruGeosite: [],
      ruGeoip: ["RU"],
      privateLists: [{ name: "notblocked", file: "notblocked.txt", target: "notblocked" }],
    }),
  );
  initializeNetworkSettings(db);
  expect(readNetworkSettings(db)).toEqual({ mode: "tun", localResolvers: ["192.168.1.1"] });
  const direct = listChannels(db).find((c) => c.target === "direct");
  expect(direct?.matcher).toMatchObject({
    domains: expect.arrayContaining(["ru"]),
    geoip: ["RU"],
    ruleProviders: [{ url: "file://published/notblocked.txt", behavior: "domain" }],
  });
  updateDirect(db, { matcher: { ...direct?.matcher, domains: [] } });
  writeNetworkSettings(db, { mode: "proxy", localResolvers: ["192.168.1.1"] });
  initializeNetworkSettings(db);
  writeNetworkSettings(db, { mode: "tun", localResolvers: [] });
  expect(
    db.select().from(channels).where(eq(channels.id, "direct")).get()?.matcher.domains,
  ).toEqual([]);
  expect(getSetting(db, "networkProfile")).toBeUndefined();
  expect(getSetting(db, "internal.gatewayPreferences")).toBeUndefined();
  expect(
    db
      .select()
      .from(settings)
      .all()
      .filter((s) => s.key === "internal.networkSettings"),
  ).toHaveLength(1);
  db.$client.close();
});

it("never hides invalid stored connection data behind the default Proxy mode", () => {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  db.$client
    .prepare("INSERT INTO settings(key,value) VALUES (?,?)")
    .run("internal.networkSettings", Buffer.from("invalid"));
  expect(() => readNetworkSettings(db)).toThrow();
  db.$client.close();
});
