import { describe, expect, it } from "vitest";
import { isPublicResolverIp, networkProfileSchema } from "./gateway.js";

describe("networkProfileSchema", () => {
  it("accepts public addresses outside reserved subnets", () => {
    expect(isPublicResolverIp("192.5.5.241")).toBe(true);
    expect(isPublicResolverIp("172.64.0.1")).toBe(true);
    expect(isPublicResolverIp("198.41.0.4")).toBe(true);
    expect(isPublicResolverIp("203.0.113.1")).toBe(false);
  });
  it("keeps gateway opt-in", () => {
    expect(networkProfileSchema.parse({ profile: "proxy" })).toEqual({ profile: "proxy" });
    expect(
      networkProfileSchema.parse({ profile: "gateway", localResolvers: ["192.168.1.1"] }),
    ).toMatchObject({ profile: "gateway", fakeIpRange: "198.19.0.1/16", tunDevice: "sm-gateway" });
  });

  it.each([
    { nameservers: ["system"] },
    { bootstrapResolvers: ["dns.example.com"] },
    { bootstrapResolvers: ["192.168.1.1"] },
    { nameservers: ["127.0.0.1"] },
    { nameservers: ["https://192.168.1.1/dns-query"] },
    { fakeIpRange: "192.168.1.0/24" },
    { fakeIpRange: "198.18.0.1/15" },
    { dnsPort: 9090 },
    { localResolvers: ["192.168.1.1:"] },
    { localDomains: ["broken..lan"] },
    { lanInterface: "eth0" },
    { privateLists: [{ name: "capture", file: "n.txt", target: "proxy" }] },
    { tunDevice: "../../tun" },
    { privateLists: [{ name: "n", file: "../n.txt", target: "notblocked" }] },
    { privateLists: [{ name: "n", file: "n.txt", target: "notblocked", behavior: "classical" }] },
  ])("rejects ambiguous/unsafe gateway configuration %j", (extra) => {
    expect(
      networkProfileSchema.safeParse({
        profile: "gateway",
        localResolvers: ["192.168.1.1"],
        ...extra,
      }).success,
    ).toBe(false);
  });

  it("requires a local resolver, rejects unknown fields and duplicate list names", () => {
    expect(networkProfileSchema.safeParse({ profile: "gateway" }).success).toBe(false);
    expect(networkProfileSchema.safeParse({ profile: "proxy", tun: true }).success).toBe(false);
    expect(
      networkProfileSchema.safeParse({
        profile: "gateway",
        localResolvers: ["192.168.1.1"],
        privateLists: [
          { name: "x", file: "x.txt", target: "proxy" },
          { name: "x", file: "y.txt", target: "ru" },
        ],
      }).success,
    ).toBe(false);
  });
});
