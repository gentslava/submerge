import { networkProfileSchema } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import {
  assertGatewayNetworkActivated,
  checkGatewayReadiness,
  type GatewayReadinessDeps,
} from "./readiness.js";

const profile = networkProfileSchema.parse({
  profile: "gateway",
  localResolvers: ["192.168.1.1"],
  privateLists: [{ name: "n", file: "n.txt", target: "notblocked" }],
});
if (profile.profile !== "gateway") throw new Error("fixture");
const deps: GatewayReadinessDeps = {
  runtime: async () => ({ mode: "rule", tun: true, dns: null, ipv6: false }),
  rules: async () => ({
    rules: [
      { index: 0, type: "Match", payload: "", proxy: "AUTO", size: -1, extra: { disabled: false } },
    ],
  }),
  providers: async () => ({
    providers: {
      "gateway-n": {
        name: "gateway-n",
        type: "Rule",
        behavior: "Domain",
        format: "Text",
        vehicleType: "File",
        ruleCount: 1,
      },
    },
  }),
  proxies: async () => ({
    proxies: {
      AUTO: { name: "AUTO", type: "Selector", now: "vpn", all: ["vpn"], history: [] },
      vpn: { name: "vpn", type: "Shadowsocks", history: [] },
    },
  }),
  listener: async () => ["198.19.0.2"],
  realDns: async () => ["93.184.215.14"],
  localDns: async () => true,
  upstreamDns: async () => true,
  vpnProbe: async () => 42,
  interfaces: () => ({
    eth0: [{ address: "172.30.0.2" } as never],
    lan0: [{ address: "192.168.1.2" } as never],
    "sm-gateway": [
      {
        address: "198.19.0.1",
        family: "IPv4",
        netmask: "255.255.0.0",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "198.19.0.1/16",
      },
    ],
  }),
  files: () => ({ "gateway-n": 1 }),
};
describe("gateway readiness", () => {
  it("does not require first TUN local-DNS setup for otherwise healthy Proxy", async () => {
    const proxyDeps = {
      ...deps,
      runtime: async () => ({ mode: "rule", tun: false, dns: null, ipv6: false }),
      interfaces: () => ({ eth0: deps.interfaces().eth0 }),
    };
    const unconfigured = { ...profile, localResolvers: [] };
    const result = await checkGatewayReadiness(unconfigured, "applied", "AUTO", proxyDeps, false);
    expect(result.ready).toBe(true);
    expect(result.checks.find((check) => check.name === "local-dns")).toBeUndefined();
    expect((await checkGatewayReadiness(unconfigured, "applied", "AUTO", deps)).ready).toBe(false);
    expect(
      (
        await checkGatewayReadiness(
          profile,
          "applied",
          "AUTO",
          { ...proxyDeps, localDns: async () => false },
          false,
        )
      ).ready,
    ).toBe(false);
  });
  it("verifies live TUN and both DNS sockets before publishing", async () => {
    await expect(assertGatewayNetworkActivated(profile, deps)).resolves.toBeUndefined();
    await expect(
      assertGatewayNetworkActivated(profile, { ...deps, interfaces: () => ({}) }),
    ).rejects.toThrow("TUN");
    await expect(
      assertGatewayNetworkActivated(profile, { ...deps, listener: async () => [] }),
    ).rejects.toThrow("DNS");
  });
  it("requires live listener, real DNS, TUN, lists and VPN state", async () => {
    expect((await checkGatewayReadiness(profile, "applied", "AUTO", deps)).ready).toBe(true);
  });
  it("verifies TUN really stopped before reporting Proxy activation", async () => {
    const proxyDeps = {
      ...deps,
      runtime: async () => ({ mode: "rule", tun: false, dns: null, ipv6: false }),
      interfaces: () => ({ eth0: deps.interfaces().eth0, lan0: deps.interfaces().lan0 }),
    };
    await expect(assertGatewayNetworkActivated(profile, proxyDeps, false)).resolves.toBeUndefined();
    await expect(assertGatewayNetworkActivated(profile, deps, false)).rejects.toThrow("TUN");
    expect((await checkGatewayReadiness(profile, "applied", "AUTO", proxyDeps, false)).ready).toBe(
      true,
    );
    expect((await checkGatewayReadiness(profile, "applied", "AUTO", deps, false)).ready).toBe(
      false,
    );
  });
  it("detects resolver outage after warming public and local DNS caches", async () => {
    let online = true;
    const cached = new Set<string>();
    const probe = async (name: string) => {
      if (online) cached.add(name);
      return online || cached.has(name);
    };
    const cachedDeps = { ...deps, localDns: probe, upstreamDns: probe };
    expect((await checkGatewayReadiness(profile, "applied", "AUTO", cachedDeps)).ready).toBe(true);
    online = false;
    const result = await checkGatewayReadiness(profile, "applied", "AUTO", cachedDeps);
    expect(result.checks.find((check) => check.name === "local-dns")?.ok).toBe(false);
    expect(result.checks.find((check) => check.name === "dns-upstream")?.ok).toBe(false);
  });
  it.each([
    { interfaces: () => ({}) },
    { realDns: async () => ["198.18.0.2"] },
    { realDns: async () => [] },
    { listener: async () => [] },
    { listener: async () => ["93.184.215.14"] },
    { providers: async () => ({ providers: {} }) },
    { files: () => ({ "gateway-n": 2 }) },
    {
      proxies: async () => ({
        proxies: {
          AUTO: { name: "AUTO", type: "Selector", now: "REJECT", all: ["REJECT"], history: [] },
        },
      }),
    },
    { runtime: async () => ({ mode: "direct", tun: true, dns: null, ipv6: false }) },
    {
      files: () => {
        throw new Error("missing");
      },
    },
    { vpnProbe: async () => 0 },
    { localDns: async () => false },
    { upstreamDns: async () => false },
  ])("does not report ready for a broken gateway %j", async (extra) => {
    expect(
      (await checkGatewayReadiness(profile, "applied", "AUTO", { ...deps, ...extra })).ready,
    ).toBe(false);
  });
  it("can stop TUN after a failed edit to the inactive LAN capture interface", async () => {
    const failedPreferences = { ...profile, lanInterface: "missing-lan" };
    const proxyDeps = {
      ...deps,
      runtime: async () => ({ mode: "rule", tun: false, dns: null, ipv6: false }),
      interfaces: () => ({ eth0: deps.interfaces().eth0, lan0: deps.interfaces().lan0 }),
    };
    await expect(assertGatewayNetworkActivated(failedPreferences, deps)).rejects.toThrow("TUN");
    await expect(
      assertGatewayNetworkActivated(failedPreferences, proxyDeps, false),
    ).resolves.toBeUndefined();
    expect(
      (await checkGatewayReadiness(failedPreferences, "applied", "AUTO", proxyDeps, false)).ready,
    ).toBe(true);
  });
  it("never hides a failed apply or an unreachable engine", async () => {
    expect((await checkGatewayReadiness(profile, "failed", "AUTO", deps)).ready).toBe(false);
    expect(
      (
        await checkGatewayReadiness(profile, "applied", "AUTO", {
          ...deps,
          runtime: async () => {
            throw new Error("timeout");
          },
        })
      ).ready,
    ).toBe(false);
  });
});
