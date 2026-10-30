import { DEFAULT_SPEED_POLICY, type Proxy as ProxyConfig } from "@submerge/shared";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { networkProfileSchema } from "../gateway/engine-settings.js";
import { buildMultiConfig, type ProxyChannelConfigInput, ruleProviderName } from "./multiConfig.js";

const vpn: ProxyConfig = {
  name: "vpn",
  type: "ss",
  server: "vpn.example.com",
  port: 443,
  cipher: "aes-128-gcm",
  password: "test",
};
const gateway = networkProfileSchema.parse({ profile: "gateway" });
const defaultChannel = (proxies: ProxyConfig[] = [vpn]) => ({
  id: "default",
  target: "proxy" as const,
  isDefault: true,
  defaultRoute: "direct" as const,
  groupName: "AUTO",
  policy: DEFAULT_SPEED_POLICY,
  domains: [],
  cidrs: [],
  proxies,
});
const explicitChannel = (proxies: ProxyConfig[] = [vpn]): ProxyChannelConfigInput => ({
  ...defaultChannel(proxies),
  id: "packages",
  isDefault: false,
  groupName: "ch-packages",
  domains: ["docker.io", "npmjs.org"],
});

it("keeps Default's explicit Always VPN lists on its saved VPN pool with Direct catch-all", () => {
  const list = { url: "https://rules.example.com/forced.yaml", behavior: "domain" as const };
  const cfg = yaml.load(buildMultiConfig([{ ...defaultChannel(), ruleProviders: [list] }])) as {
    rules: string[];
  };
  expect(cfg.rules).toContain(`RULE-SET,${ruleProviderName(list)},AUTO`);
  expect(cfg.rules.at(-1)).toBe("MATCH,DIRECT");
});

describe.each(["legacy-proxy", "prepared-proxy", "tun"] as const)("Direct default: %s", (mode) => {
  function config(proxies: ProxyConfig[] = [vpn], explicitProxies: ProxyConfig[] = proxies) {
    return yaml.load(
      buildMultiConfig(
        [defaultChannel(proxies), explicitChannel(explicitProxies)],
        "secure-test-secret",
        undefined,
        undefined,
        mode === "tun" ? gateway : { profile: "proxy" },
        mode === "legacy-proxy" || gateway.profile !== "gateway" ? undefined : gateway,
      ),
    ) as { rules: string[]; "proxy-groups": Array<{ name: string; proxies: string[] }> };
  }

  it("routes only explicit package destinations through VPN and everything else directly", () => {
    const cfg = config();
    expect(cfg.rules).toContain("DOMAIN-SUFFIX,docker.io,ch-packages");
    expect(cfg.rules).toContain("DOMAIN-SUFFIX,npmjs.org,ch-packages");
    expect(cfg.rules.at(-1)).toBe("MATCH,DIRECT");
  });

  it.each([true, false])(
    "rejects an empty explicit VPN pool (inventory present: %s)",
    (hasInventory) => {
      const cfg = config(hasInventory ? [vpn] : [], []);
      expect(cfg.rules).toContain("DOMAIN-SUFFIX,docker.io,ch-packages");
      expect(cfg["proxy-groups"].find((group) => group.name === "ch-packages")?.proxies).toEqual([
        "REJECT",
      ]);
      expect(cfg.rules.at(-1)).toBe("MATCH,DIRECT");
    },
  );
});
