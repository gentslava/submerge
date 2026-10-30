import { cidrVersion, isPublicResolverIp, localResolverSchema } from "@submerge/shared";
import { z } from "zod";

const publicResolver = z
  .string()
  .max(256)
  .refine((value) => {
    if (isPublicResolverIp(value)) return true;
    const match = /^(https|tls|udp|tcp):\/\/([0-9.]+)(?::([0-9]+))?(\/[a-zA-Z0-9._/-]*)?$/u.exec(
      value,
    );
    return Boolean(
      match &&
        isPublicResolverIp(match[2] ?? "") &&
        (!match[3] || (Number(match[3]) > 0 && Number(match[3]) <= 65535)) &&
        (!match[4] || match[1] === "https"),
    );
  }, "Use an explicit public IPv4 resolver, optionally with https/tls/udp/tcp");

const localResolver = localResolverSchema;

const domain = z
  .string()
  .max(253)
  .refine(
    (value) =>
      value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)),
    "Invalid DNS suffix",
  );
const cidr = z.string().refine((value) => cidrVersion(value) !== null, "Invalid CIDR");

export const gatewayListSchema = z
  .strictObject({
    name: z
      .string()
      .max(48)
      .regex(/^[a-z][a-z0-9-]*$/u)
      .refine((name) => name !== "capture", "Reserved gateway provider name"),
    file: z
      .string()
      .max(128)
      .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.txt$/u),
    target: z.enum(["notblocked", "proxy", "ru"]),
    behavior: z.enum(["domain", "classical", "ipcidr"]).default("domain"),
  })
  .refine(
    (value) => value.target !== "notblocked" || value.behavior === "domain",
    "notblocked must contain exact domain entries",
  );

export const gatewayProfileSchema = z
  .strictObject({
    profile: z.literal("gateway"),
    dnsListen: z.ipv4().default("0.0.0.0"),
    dnsPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((p) => ![3000, 7890, 7891, 9090].includes(p))
      .default(1053),
    fakeIpRange: z
      .string()
      .regex(/^198\.(?:18|19)\.0\.1\/16$/u)
      .default("198.19.0.1/16"),
    nameservers: z
      .array(publicResolver)
      .min(1)
      .max(8)
      .default(["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"]),
    bootstrapResolvers: z
      .array(z.ipv4().refine(isPublicResolverIp))
      .min(1)
      .max(8)
      .default(["1.1.1.1", "8.8.8.8"]),
    localResolvers: z.array(localResolver).max(8).default([]),
    localDomains: z
      .array(domain)
      .min(1)
      .max(64)
      .default(["localhost", "local", "lan", "home.arpa", "in-addr.arpa", "ip6.arpa"]),
    serviceCidrs: z.array(cidr).max(128).default([]),
    tunDevice: z
      .string()
      .max(15)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u)
      .default("sm-gateway"),
    tunStack: z.enum(["system", "gvisor", "mixed"]).default("mixed"),
    routeTable: z.number().int().min(10000).max(2147483647).default(20220),
    routeRule: z.number().int().min(10000).max(32000).default(20220),
    mtu: z.number().int().min(1280).max(9000).default(1500),
    outboundInterface: z
      .string()
      .max(15)
      .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/u)
      .default("eth0"),
    lanInterface: z
      .string()
      .max(15)
      .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/u)
      .default("lan0"),
    ruZones: z.array(domain).max(32).default(["ru", "su", "xn--p1ai"]),
    ruGeosite: z
      .array(z.string().regex(/^[a-zA-Z0-9@_-]+$/u))
      .max(32)
      .default(["category-ru"]),
    ruGeoip: z
      .array(z.string().regex(/^[A-Z]{2}$/u))
      .max(32)
      .default(["RU"]),
    privateLists: z.array(gatewayListSchema).max(32).default([]),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.privateLists.map((list) => list.name)).size !== value.privateLists.length) {
      ctx.addIssue({ code: "custom", path: ["privateLists"], message: "Duplicate list names" });
    }
    if (value.tunDevice === value.outboundInterface) {
      ctx.addIssue({
        code: "custom",
        path: ["tunDevice"],
        message: "TUN cannot be the outbound interface",
      });
    }
    if (value.lanInterface === value.outboundInterface || value.lanInterface === value.tunDevice) {
      ctx.addIssue({
        code: "custom",
        path: ["lanInterface"],
        message: "LAN, WAN and TUN must be separate interfaces",
      });
    }
  });

export const networkProfileSchema = z.discriminatedUnion("profile", [
  z.strictObject({ profile: z.literal("proxy") }),
  gatewayProfileSchema,
]);
export type NetworkProfile = z.infer<typeof networkProfileSchema>;
export type GatewayProfile = z.infer<typeof gatewayProfileSchema>;
export type GatewayList = z.infer<typeof gatewayListSchema>;

// Engine defaults. Routing is populated from channels, never a second settings form.
export function createGatewayDraft(): GatewayProfile {
  return z
    .strictObject({
      ...gatewayProfileSchema.shape,
      localResolvers: z.array(localResolver).max(8).default([]),
    })
    .parse({ profile: "gateway" });
}
