import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { networkProfileSchema } from "../gateway/engine-settings.js";
import { buildMultiConfig, type ChannelConfigInput, ruleProviderName } from "./multiConfig.js";

const gateway = networkProfileSchema.parse({
  profile: "gateway",
  localResolvers: ["192.168.1.1"],
  privateLists: [
    { name: "notblocked", file: "notblocked.txt", target: "notblocked" },
    { name: "custom", file: "custom.txt", target: "proxy" },
    { name: "ru", file: "ru.txt", target: "ru" },
  ],
});
const channels: ChannelConfigInput[] = [
  {
    id: "default",
    target: "proxy",
    isDefault: true,
    groupName: "AUTO",
    domains: [],
    cidrs: [],
    ruleProviders: [{ url: "file://published/custom.txt", behavior: "domain" }],
    policy: {
      kind: "sticky",
      testUrl: "https://example.com",
      intervalSec: 60,
      failureThreshold: 2,
      maxHoldHours: null,
      initialCriterion: "fastest",
    },
    proxies: [
      {
        name: "vpn",
        type: "ss",
        server: "vpn.example.com",
        port: 443,
        cipher: "aes-128-gcm",
        password: "test",
      },
    ],
  },
  {
    id: "direct",
    target: "direct",
    isDefault: false,
    domains: ["direct.example", "ru", "su", "xn--p1ai"],
    geosite: ["category-ru"],
    ruleProviders: [
      { url: "file://published/notblocked.txt", behavior: "domain" },
      { url: "file://published/ru.txt", behavior: "domain" },
    ],
    cidrs: [],
    directPresets: { localDomains: true, privateNetworks: true },
    geoip: ["RU"],
  },
  {
    id: "forced",
    target: "proxy",
    isDefault: false,
    groupName: "ch-forced",
    domains: ["forced.ru"],
    cidrs: [],
    policy: { kind: "manual", pinnedNode: "vpn", onFailure: "hold" },
    proxies: [],
  },
];
function config(input = channels) {
  return yaml.load(
    buildMultiConfig(input, "secure-test-secret", undefined, undefined, gateway),
  ) as {
    dns: Record<string, unknown>;
    tun: Record<string, unknown>;
    rules: string[];
    "proxy-groups": Array<{ name: string; proxies: string[] }>;
    "rule-providers": Record<string, Record<string, unknown>>;
    proxies: Array<Record<string, unknown>>;
  };
}

it("changes only capture when returning to Proxy with saved TUN preferences", () => {
  if (gateway.profile !== "gateway") throw new Error("fixture");
  const tun = config();
  const proxy = yaml.load(
    buildMultiConfig(
      channels,
      "secure-test-secret",
      undefined,
      undefined,
      { profile: "proxy" },
      gateway,
    ),
  ) as typeof tun;
  expect(proxy.tun.enable).toBe(false);
  expect(proxy.dns).toEqual(tun.dns);
  expect(proxy.rules).toEqual(tun.rules);
  expect(proxy["rule-providers"]).toEqual(tun["rule-providers"]);
  expect(proxy["proxy-groups"]).toEqual(tun["proxy-groups"]);
});

describe("gateway config", () => {
  it("owns independent DNS and TUN with separate local name resolution", () => {
    const cfg = config();
    expect(cfg.dns).toMatchObject({
      listen: "0.0.0.0:1053",
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.19.0.1/16",
      "default-nameserver": ["1.1.1.1", "8.8.8.8"],
      "nameserver-policy": { "+.lan": ["192.168.1.1"] },
      "direct-nameserver-follow-policy": true,
    });
    expect(JSON.stringify(cfg.dns)).not.toContain('"system"');
    expect(cfg.rules.indexOf("DOMAIN,fastly.jsdelivr.net,DIRECT")).toBeLessThan(
      cfg.rules.indexOf(
        `RULE-SET,${ruleProviderName({ url: "file://published/notblocked.txt", behavior: "domain" })},DIRECT`,
      ),
    );
    expect(cfg.rules).toContain("DOMAIN,fastly.jsdelivr.net,DIRECT");
    expect(cfg.tun).toMatchObject({
      enable: true,
      device: "sm-gateway",
      "auto-route": true,
      "auto-redirect": true,
      "include-interface": ["lan0"],
      "exclude-uid": [999],
      "route-address": ["0.0.0.0/0"],
      "route-address-set": ["gateway-capture"],
      "iproute2-table-index": 20220,
      "iproute2-rule-index": 20220,
      "auto-detect-interface": true,
    });
    expect(cfg).not.toHaveProperty("interface-name");
    expect(cfg.proxies[0]).toHaveProperty("interface-name", "eth0");
  });

  it("resolves explicit service CIDRs before forced domain rules", () => {
    const cfg = yaml.load(
      buildMultiConfig(
        channels.map((channel) =>
          channel.target === "direct" ? { ...channel, cidrs: ["203.0.113.0/24"] } : channel,
        ),
        "secure-test-secret",
        undefined,
        undefined,
        gateway,
      ),
    ) as { rules: string[] };
    expect(cfg.rules).toContain("IP-CIDR,203.0.113.0/24,DIRECT");
    expect(cfg.rules.indexOf("IP-CIDR,203.0.113.0/24,DIRECT")).toBeLessThan(
      cfg.rules.indexOf("DOMAIN-SUFFIX,forced.ru,ch-forced"),
    );
  });

  it("enforces local > notblocked > forced proxy > RU > VPN precedence", () => {
    const { rules, "rule-providers": providers } = config();
    const positions = [
      "DOMAIN-SUFFIX,lan,DIRECT",
      `RULE-SET,${ruleProviderName({ url: "file://published/notblocked.txt", behavior: "domain" })},DIRECT`,
      `RULE-SET,${ruleProviderName({ url: "file://published/custom.txt", behavior: "domain" })},AUTO`,
      "DOMAIN-SUFFIX,forced.ru,ch-forced",
      `RULE-SET,${ruleProviderName({ url: "file://published/ru.txt", behavior: "domain" })},DIRECT`,
      "GEOIP,RU,DIRECT",
      "MATCH,AUTO",
    ].map((rule) => rules.indexOf(rule));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(rules).not.toContain("GEOIP,RU,DIRECT,no-resolve");
    expect(
      providers[ruleProviderName({ url: "file://published/notblocked.txt", behavior: "domain" })],
    ).toEqual({
      type: "file",
      behavior: "domain",
      format: "text",
      path: "./private-lists/notblocked.txt",
    });
  });

  it("rejects empty VPN groups instead of silently selecting DIRECT", () => {
    const cfg = config(channels.map((c) => (c.target === "proxy" ? { ...c, proxies: [] } : c)));
    expect(cfg.rules).not.toContain("MATCH,DIRECT");
    expect(cfg.rules.at(-1)).toBe("MATCH,AUTO");
    for (const group of cfg["proxy-groups"]) expect(group.proxies).not.toContain("DIRECT");
    expect(cfg["proxy-groups"].find((g) => g.name === "AUTO")?.proxies).toEqual(["REJECT"]);
    expect(cfg["rule-providers"]).toHaveProperty(
      ruleProviderName({ url: "file://published/notblocked.txt", behavior: "domain" }),
    );
  });

  it("blocks an empty default pool even when another channel has VPN nodes", () => {
    const cfg = config(
      channels.map((c) => (c.id === "default" && c.target === "proxy" ? { ...c, race: [] } : c)),
    );
    expect(cfg.rules.at(-1)).toBe("MATCH,AUTO");
    expect(cfg["proxy-groups"].find((g) => g.name === "AUTO")?.proxies).toEqual(["REJECT"]);
    expect(cfg.rules).toContain("DOMAIN,vpn.example.com,DIRECT");
  });
});
