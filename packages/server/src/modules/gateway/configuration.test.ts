import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayDraft, gatewayProfileSchema } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { createDb } from "../../db/client.js";
import { setSetting } from "../settings/service.js";
import { getGatewayConfiguration } from "./service.js";
import { writeNetworkProfile } from "./settings.js";

const savedEnvironment = { password: env.ADMIN_PASSWORD, lists: env.GATEWAY_LISTS_PATH };
afterEach(() => {
  env.ADMIN_PASSWORD = savedEnvironment.password;
  env.GATEWAY_LISTS_PATH = savedEnvironment.lists;
});
function fixture() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  env.GATEWAY_LISTS_PATH = mkdtempSync(join(tmpdir(), "tun-configuration-"));
  return db;
}
describe("native TUN configuration", () => {
  it("requires an explicit local resolver and never invents an available LAN", () => {
    const db = fixture();
    env.ADMIN_PASSWORD = "";
    const configuration = getGatewayConfiguration(db, {});
    expect(configuration.profile).toEqual({ profile: "proxy" });
    expect(configuration.tun.localResolvers).toEqual([]);
    expect(gatewayProfileSchema.safeParse(configuration.tun).success).toBe(false);
    expect(configuration.connection.lanAddress).toBeNull();
    expect(
      configuration.prerequisites.filter((check) => !check.ok).map((check) => check.name),
    ).toContain("network");
  });
  it("reuses saved preferences in Proxy and detects only the published default lists", () => {
    const db = fixture();
    writeFileSync(join(env.GATEWAY_LISTS_PATH, "notblocked.txt"), "+.docs.google.com\n");
    writeFileSync(join(env.GATEWAY_LISTS_PATH, "custom.txt"), "+.example.com\n");
    writeFileSync(join(env.GATEWAY_LISTS_PATH, "deploy-key"), "not exposed");
    const first = getGatewayConfiguration(db, {});
    expect(first.availableLists).toEqual(["custom.txt", "notblocked.txt"]);
    expect(first.tun.privateLists.map((list) => list.target)).toEqual(["notblocked", "proxy"]);
    const tun = gatewayProfileSchema.parse({
      ...createGatewayDraft(),
      localResolvers: ["192.168.1.1"],
      mtu: 1400,
    });
    writeNetworkProfile(db, tun);
    writeNetworkProfile(db, { profile: "proxy" });
    env.ADMIN_PASSWORD = "strong-admin-password";
    setSetting(db, "mihomoSecret", "strong-engine-secret");
    const configuration = getGatewayConfiguration(db, {
      eth0: [{ family: "IPv4", address: "172.20.0.2" } as never],
      lan0: [{ family: "IPv4", address: "172.30.220.2" } as never],
    });
    expect(configuration.tun).toEqual(tun);
    expect(
      configuration.prerequisites.filter((check) => check.ok !== null).every((check) => check.ok),
    ).toBe(true);
    expect(configuration.prerequisites.find((check) => check.name === "tun-access")?.ok).toBeNull();
    expect(configuration.connection).toMatchObject({
      lanAddress: "172.30.220.2",
      access: "bridge",
    });
  });
  it("never presents loopback as a LAN gateway or loopback-only DNS as reachable from LAN", () => {
    const db = fixture();
    const previousAccess = env.GATEWAY_LAN_ACCESS;
    env.GATEWAY_LAN_ACCESS = "lan";
    try {
      writeNetworkProfile(
        db,
        gatewayProfileSchema.parse({
          ...createGatewayDraft(),
          localResolvers: ["192.168.1.1"],
          dnsListen: "127.0.0.1",
        }),
      );
      const interfaces = {
        eth0: [{ family: "IPv4", address: "172.20.0.2" } as never],
        lan0: [{ family: "IPv4", address: "192.168.1.2" } as never],
      };
      expect(getGatewayConfiguration(db, interfaces).connection).toMatchObject({
        lanAddress: "192.168.1.2",
        dnsAddress: null,
      });
      expect(
        getGatewayConfiguration(db, {
          ...interfaces,
          lan0: [{ family: "IPv4", address: "127.0.0.1", internal: true } as never],
        }).connection,
      ).toMatchObject({ lanAddress: null, dnsAddress: null });
    } finally {
      env.GATEWAY_LAN_ACCESS = previousAccess;
    }
  });
});
