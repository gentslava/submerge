import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkProfileSchema } from "@submerge/shared";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { createDb } from "../../db/client.js";
import { getSetting, setSetting } from "../settings/service.js";
import {
  assertIndependentLocalDns,
  readGatewayPreferences,
  readNetworkProfile,
  seedGatewayMihomoSecret,
  seedNetworkProfile,
  validateGatewayStartup,
  validatePrivateLists,
  writeNetworkProfile,
} from "./settings.js";

function freshDb() {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  return db;
}
const profile = networkProfileSchema.parse({ profile: "gateway", localResolvers: ["192.168.1.1"] });

const previousPassword = env.ADMIN_PASSWORD;
afterEach(() => {
  env.ADMIN_PASSWORD = previousPassword;
});

describe("gateway settings", () => {
  it("retains TUN settings when returning to Proxy and refuses corrupt preferences", () => {
    const db = freshDb();
    writeNetworkProfile(db, profile);
    writeNetworkProfile(db, { profile: "proxy" });
    expect(readNetworkProfile(db)).toEqual({ profile: "proxy" });
    expect(readGatewayPreferences(db)).toEqual(profile);
    setSetting(db, "internal.gatewayPreferences", "{invalid");
    expect(() => readGatewayPreferences(db)).toThrow("Invalid persisted TUN preferences");
  });
  it("seeds confirmed auth once and ignores later environment values", () => {
    const db = freshDb();
    seedGatewayMihomoSecret(db, "first-gateway-confirmed-secret");
    seedGatewayMihomoSecret(db, "changed-environment-secret");
    expect(getSetting(db, "mihomoSecret")).toBe("first-gateway-confirmed-secret");
  });
  it("blocks gateway startup before opening an unauthenticated API", () => {
    const db = freshDb();
    writeNetworkProfile(db, profile);
    setSetting(db, "mihomoSecret", "gateway-secure-secret");
    env.ADMIN_PASSWORD = "";
    expect(() => validateGatewayStartup(db)).toThrow("ADMIN_PASSWORD");
    env.ADMIN_PASSWORD = "gateway-secure-password";
    expect(() => validateGatewayStartup(db)).not.toThrow();
  });
  it("rejects local DNS pointing to either explicit or wildcard own listener", () => {
    const config = networkProfileSchema.parse({
      profile: "gateway",
      dnsListen: "192.168.1.2",
      localResolvers: ["192.168.1.2:1053"],
    });
    if (config.profile !== "gateway") throw new Error("fixture");
    expect(() => assertIndependentLocalDns(config, {})).toThrow("points back");
    const interfaces = {
      eth0: [
        {
          address: "192.168.1.2",
          family: "IPv4",
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "192.168.1.2/24",
        } as const,
      ],
    };
    expect(() =>
      assertIndependentLocalDns({ ...config, dnsListen: "0.0.0.0" }, interfaces),
    ).toThrow();
    expect(() =>
      assertIndependentLocalDns({ ...config, localResolvers: ["192.168.1.2:53"] }, interfaces),
    ).not.toThrow();
  });
  it("survives closing and reopening the SQLite database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gateway-restart-")), "state.db");
    const db = createDb(path);
    migrate(db, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    writeNetworkProfile(db, profile);
    db.$client.close();
    const reopened = createDb(path);
    expect(readNetworkProfile(reopened)).toEqual(profile);
    reopened.$client.close();
  });
  it("defaults to proxy and preserves settings across reseeding", () => {
    const db = freshDb();
    expect(readNetworkProfile(db)).toEqual({ profile: "proxy" });
    writeNetworkProfile(db, profile);
    const directory = mkdtempSync(join(tmpdir(), "gateway-settings-"));
    const path = join(directory, "profile.json");
    writeFileSync(path, '{"profile":"proxy"}');
    seedNetworkProfile(db, path);
    expect(readNetworkProfile(db)).toEqual(profile);
  });

  it("never converts corrupt gateway settings into a proxy fallback", () => {
    const db = freshDb();
    setSetting(db, "networkProfile", "{invalid");
    expect(() => readNetworkProfile(db)).toThrow("Invalid persisted network profile");
  });

  it("reads private lists without collapsing full FQDNs", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-lists-"));
    writeFileSync(
      join(directory, "notblocked.txt"),
      "# exact published FQDNs\n+.docs.google.com\nwww.example.com\n",
    );
    const config = networkProfileSchema.parse({
      profile: "gateway",
      localResolvers: ["192.168.1.1"],
      privateLists: [{ name: "notblocked", file: "notblocked.txt", target: "notblocked" }],
    });
    if (config.profile !== "gateway") throw new Error("test profile");
    expect(validatePrivateLists(config, directory)).toEqual({ "gateway-notblocked": 2 });
    expect(() => validatePrivateLists(config, join(directory, "missing"))).toThrow();
    writeFileSync(join(directory, "notblocked.txt"), "*.google.com\n");
    expect(() => validatePrivateLists(config, directory)).toThrow();
    writeFileSync(join(directory, "notblocked.txt"), "# empty\n");
    expect(() => validatePrivateLists(config, directory)).toThrow();
  });
});
