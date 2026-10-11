import { randomUUID } from "node:crypto";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { type GatewayProfile, isPublicResolverIp, PSEUDO_NODE_SET } from "@submerge/shared";
import { probeDnsListener } from "../../clients/gateway-network.js";
import {
  type ActiveRulesResponse,
  getDelay,
  getProxies,
  getRuleProviders,
  getRules,
  getRuntimeConfig,
  type MihomoRuntimeConfig,
  type ProxiesResponse,
  queryDnsResolution,
  queryRealDns,
  type RuleProvidersResponse,
} from "../../clients/mihomo.js";
import {
  assertIndependentLocalDns,
  assertPrivateProvidersLoaded,
  validatePrivateLists,
} from "./settings.js";

export interface GatewayReadinessDeps {
  runtime: () => Promise<MihomoRuntimeConfig>;
  rules: () => Promise<ActiveRulesResponse>;
  providers: () => Promise<RuleProvidersResponse>;
  proxies: () => Promise<ProxiesResponse>;
  listener: (host: string, port: number, protocol: "tcp" | "udp") => Promise<string[]>;
  realDns: (name: string) => Promise<string[]>;
  localDns: (name: string) => Promise<boolean>;
  upstreamDns: (name: string) => Promise<boolean>;
  vpnProbe: (group: string) => Promise<number>;
  interfaces: () => Record<string, NetworkInterfaceInfo[] | undefined>;
  files: (profile: GatewayProfile) => Record<string, number>;
}
export const gatewayReadinessDeps: GatewayReadinessDeps = {
  runtime: getRuntimeConfig,
  rules: getRules,
  providers: getRuleProviders,
  proxies: getProxies,
  listener: probeDnsListener,
  realDns: queryRealDns,
  localDns: queryDnsResolution,
  upstreamDns: queryDnsResolution,
  vpnProbe: async (group) =>
    (await getDelay(group, undefined, { timeoutMs: 3000, expected: "200-399" })).delay,
  interfaces: networkInterfaces,
  files: validatePrivateLists,
};

export interface GatewayReadiness {
  profile: "gateway" | "proxy";
  ready: boolean;
  checks: Array<{ name: string; ok: boolean; error?: string }>;
}

type NetworkActivationDeps = Pick<GatewayReadinessDeps, "runtime" | "interfaces" | "listener">;

/** A successful config reload does not prove Linux could create the TUN/listeners. */
export async function assertGatewayNetworkActivated(
  profile: GatewayProfile,
  deps: NetworkActivationDeps = gatewayReadinessDeps,
  tunEnabled = true,
): Promise<void> {
  const prefix = profile.fakeIpRange.split(".").slice(0, 2).join(".");
  const host = profile.dnsListen === "0.0.0.0" ? "127.0.0.1" : profile.dnsListen;
  const runtime = await deps.runtime();
  const interfaces = deps.interfaces();
  if (
    runtime.mode !== "rule" ||
    runtime.tun !== tunEnabled ||
    runtime.ipv6 !== false ||
    !interfaces[profile.outboundInterface]?.length ||
    (tunEnabled && !interfaces[profile.lanInterface]?.length) ||
    (tunEnabled
      ? !interfaces[profile.tunDevice]?.some((entry) => entry.address.startsWith(`${prefix}.`))
      : Boolean(interfaces[profile.tunDevice]?.length))
  ) {
    throw new Error("Gateway TUN or LAN/WAN interfaces are unavailable");
  }
  const responses = await Promise.all([
    deps.listener(host, profile.dnsPort, "udp"),
    deps.listener(host, profile.dnsPort, "tcp"),
  ]);
  if (!responses.every((ips) => ips.length > 0 && ips.every((ip) => ip.startsWith(`${prefix}.`)))) {
    throw new Error("Gateway DNS listeners are unavailable");
  }
}

export async function checkGatewayReadiness(
  profile: GatewayProfile,
  applyState: "applied" | "failed" | "unknown",
  defaultGroup: string,
  deps: GatewayReadinessDeps = gatewayReadinessDeps,
  tunEnabled = true,
): Promise<GatewayReadiness> {
  const nonce = randomUUID();
  const prefix = profile.fakeIpRange.split(".").slice(0, 2).join(".");
  const host = profile.dnsListen === "0.0.0.0" ? "127.0.0.1" : profile.dnsListen;
  const checks: GatewayReadiness["checks"] = [
    { name: "config-applied", ok: applyState === "applied" },
  ];
  const tasks: Array<[string, () => Promise<boolean> | boolean]> = [
    [
      "lan-wan-interfaces",
      () =>
        Boolean(
          (!tunEnabled || deps.interfaces()[profile.lanInterface]?.length) &&
            deps.interfaces()[profile.outboundInterface]?.length,
        ),
    ],
    [
      "local-dns",
      async () => {
        if (profile.localResolvers.length === 0) return false;
        assertIndependentLocalDns(profile, deps.interfaces());
        const suffix =
          profile.localDomains.find(
            (domain) => domain !== "localhost" && !domain.endsWith("arpa"),
          ) ?? profile.localDomains[0];
        return deps.localDns(`submerge-gateway-readiness.${nonce}.${suffix}`);
      },
    ],
    [
      "runtime",
      async () => {
        const config = await deps.runtime();
        return config.mode === "rule" && config.tun === tunEnabled && config.ipv6 === false;
      },
    ],
    [
      tunEnabled ? "tun-interface" : "tun-disabled",
      () =>
        tunEnabled
          ? (deps.interfaces()[profile.tunDevice] ?? []).some((address) =>
              address.address.startsWith(`${prefix}.`),
            )
          : !deps.interfaces()[profile.tunDevice]?.length,
    ],
    [
      "dns-udp",
      async () => {
        const ips = await deps.listener(host, profile.dnsPort, "udp");
        return ips.length > 0 && ips.every((ip) => ip.startsWith(`${prefix}.`));
      },
    ],
    [
      "dns-tcp",
      async () => {
        const ips = await deps.listener(host, profile.dnsPort, "tcp");
        return ips.length > 0 && ips.every((ip) => ip.startsWith(`${prefix}.`));
      },
    ],
    [
      "dns-upstream",
      async () => {
        const [ips, fresh] = await Promise.all([
          deps.realDns("example.com"),
          deps.upstreamDns(`submerge-gateway-readiness.${nonce}.example.com`),
        ]);
        return fresh && ips.length > 0 && ips.every(isPublicResolverIp);
      },
    ],
    [
      "private-lists",
      async () => {
        const counts = deps.files(profile);
        assertPrivateProvidersLoaded(profile, counts, await deps.providers());
        return true;
      },
    ],
    [
      "default-rule",
      async () => {
        const { rules } = await deps.rules();
        const active = rules.filter((rule) => !rule.extra.disabled);
        return (
          active.at(-1)?.type.toLowerCase() === "match" &&
          active.at(-1)?.proxy === defaultGroup &&
          !active.some((rule) => rule.type.toLowerCase() === "match" && rule.proxy === "DIRECT")
        );
      },
    ],
    [
      "vpn-pool",
      async () => {
        const { proxies } = await deps.proxies();
        const visited = new Set<string>();
        const hasNode = (name: string): boolean => {
          if (visited.has(name) || name === "DIRECT" || name === "REJECT" || name === "REJECT-DROP")
            return false;
          visited.add(name);
          const proxy = proxies[name];
          if (!proxy) return false;
          return proxy.all
            ? proxy.all.every((member) => member !== "DIRECT") && proxy.all.some(hasNode)
            : !PSEUDO_NODE_SET.has(name);
        };
        return hasNode(defaultGroup);
      },
    ],
    ["vpn-egress", async () => (await deps.vpnProbe(defaultGroup)) > 0],
  ];
  const results = await Promise.all(
    tasks
      .filter(([name]) => name !== "local-dns" || tunEnabled || profile.localResolvers.length > 0)
      .map(async ([name, check]) => {
        try {
          return { name, ok: await check() };
        } catch {
          return { name, ok: false, error: "Проверка не пройдена" };
        }
      }),
  );
  checks.push(...results);
  return {
    profile: tunEnabled ? "gateway" : "proxy",
    ready: checks.every((check) => check.ok),
    checks,
  };
}
