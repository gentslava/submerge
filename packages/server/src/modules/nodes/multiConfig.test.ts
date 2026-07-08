import {
  type ChannelPolicy,
  DEFAULT_SPEED_POLICY,
  type Proxy as ProxyConfig,
} from "@submerge/shared";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { buildConfig } from "./config.js";
import { buildMultiConfig, type ChannelConfigInput } from "./multiConfig.js";

const px = (name: string, server = "ex.com", port = 443): ProxyConfig => ({
  name,
  type: "vless",
  server,
  port,
  uuid: "u",
});

const sticky: ChannelPolicy = {
  kind: "sticky",
  testUrl: "https://x/generate_204",
  intervalSec: 60,
  failureThreshold: 3,
  maxHoldHours: null,
  initialCriterion: "fastest",
};

const channel = (over: Partial<ChannelConfigInput>): ChannelConfigInput => ({
  id: "default",
  groupName: "AUTO",
  isDefault: true,
  policy: DEFAULT_SPEED_POLICY,
  domains: [],
  proxies: [],
  ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
const parse = (raw: string): Record<string, any> => yaml.load(raw) as Record<string, any>;

// The hidden speed-test rule prepended to every non-empty config (Phase 4c).
const PROBE_RULE = "DOMAIN,speed.cloudflare.com,PROBE";

describe("buildMultiConfig — single Default channel (byte-identity)", () => {
  it("reproduces buildConfig output exactly for the default-only case", () => {
    const proxies = [px("A"), px("B")];
    const legacy = buildConfig(proxies, DEFAULT_SPEED_POLICY);
    const multi = buildMultiConfig([channel({ proxies })]);
    // The invariant: delegation makes these byte-for-byte identical.
    expect(multi).toBe(legacy);

    const cfg = parse(multi);
    const groups = cfg["proxy-groups"];
    expect(groups[0]).toMatchObject({ name: "PROXY", proxies: ["AUTO", "A", "B", "DIRECT"] });
    expect(groups[1]).toMatchObject({ name: "AUTO", type: "url-test", proxies: ["A", "B"] });
    expect(cfg.rules).toEqual([PROBE_RULE, "MATCH,PROXY"]);
  });
});

describe("buildMultiConfig — optimal policy", () => {
  it("emits the group as type select (controller-driven), not url-test", () => {
    const optimal: ChannelPolicy = {
      kind: "optimal",
      testUrl: "https://x/generate_204",
      intervalSec: 60,
    };
    const cfg = parse(
      buildMultiConfig([channel({ proxies: [px("A"), px("B")], policy: optimal })]),
    );
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const groups = cfg["proxy-groups"] as any[];
    const auto = groups.find((g) => g.name === "AUTO");
    // The controller owns the pick for optimal, so AUTO must be a plain selector.
    expect(auto.type).toBe("select");
    expect(auto.proxies).toEqual(["A", "B"]);
  });

  it("collapsed url-test subgroups inherit the policy's interval + url (not the 300s default)", () => {
    const optimal: ChannelPolicy = {
      kind: "optimal",
      testUrl: "https://probe.example/gen_204",
      intervalSec: 10,
    };
    // Two same-named endpoints collapse into a url-test subgroup "A".
    const A1 = px("A", "a1.com");
    const A2 = px("A", "a2.com");
    const cfg = parse(buildMultiConfig([channel({ proxies: [A1, A2], policy: optimal })]));
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const groups = cfg["proxy-groups"] as any[];
    const sub = groups.find((g) => g.name === "A");
    expect(sub.type).toBe("url-test");
    // The bug: non-speed policies used to pin subgroups to the 300 s default url/interval,
    // so members were measured far too rarely for the optimal ranking to be meaningful.
    expect(sub.interval).toBe(10);
    expect(sub.url).toBe("https://probe.example/gen_204");
    // optimal has no toleranceMs → the subgroup gets the default tolerance; always re-tests.
    expect(sub.tolerance).toBe(50);
    expect(sub.lazy).toBe(false);
  });
});

describe("buildMultiConfig — url-test subgroup tuning per policy kind", () => {
  const A1 = px("A", "a1.com");
  const A2 = px("A", "a2.com");
  const subOf = (policy: ChannelPolicy) => {
    const cfg = parse(buildMultiConfig([channel({ proxies: [A1, A2], policy })]));
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    return (cfg["proxy-groups"] as any[]).find((g) => g.name === "A");
  };

  it("sticky: subgroup inherits url+interval but gets the DEFAULT tolerance (no toleranceMs field)", () => {
    const sub = subOf({
      kind: "sticky",
      testUrl: "https://sticky.example/gen",
      intervalSec: 15,
      failureThreshold: 3,
      maxHoldHours: null,
      initialCriterion: "fastest",
    });
    expect(sub.type).toBe("url-test");
    expect(sub.url).toBe("https://sticky.example/gen");
    expect(sub.interval).toBe(15);
    expect(sub.tolerance).toBe(50); // sticky has no toleranceMs → default
    expect(sub.lazy).toBe(false);
  });

  it("manual: subgroup gets ALL built-in defaults (no probe fields on the policy)", () => {
    const sub = subOf({ kind: "manual", pinnedNode: "A", onFailure: "hold" });
    expect(sub.type).toBe("url-test");
    expect(sub.url).toBe("https://www.gstatic.com/generate_204");
    expect(sub.interval).toBe(300);
    expect(sub.tolerance).toBe(50);
    expect(sub.lazy).toBe(false);
  });
});

describe("buildMultiConfig — default channel with a race subset (pool)", () => {
  it("defines + lists the whole inventory in PROXY while AUTO races only the pool", () => {
    const A = px("A", "a.com");
    const B = px("B", "b.com");
    const C = px("C", "c.com");
    // The Default DEFINES all three (the inventory) but RACES only [A, B] (the pool),
    // so C stays defined + pinged + manually selectable but isn't in the auto race.
    const cfg = parse(buildMultiConfig([channel({ proxies: [A, B, C], race: [A, B] })]));
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const groups = cfg["proxy-groups"] as any[];
    const proxy = groups.find((g) => g.name === "PROXY");
    const auto = groups.find((g) => g.name === "AUTO");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["A", "B", "C"]);
    expect(proxy.proxies).toEqual(["AUTO", "A", "B", "C", "DIRECT"]);
    expect(auto.proxies).toEqual(["A", "B"]);
  });

  it("an empty race (empty pool → all) still races everything — byte-identity", () => {
    const A = px("A", "a.com");
    const B = px("B", "b.com");
    // race === proxies is the empty-pool case; AUTO must list every node.
    const cfg = parse(buildMultiConfig([channel({ proxies: [A, B], race: [A, B] })]));
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const auto = (cfg["proxy-groups"] as any[]).find((g) => g.name === "AUTO");
    expect(auto.proxies).toEqual(["A", "B"]);
  });

  it("races by node name, not endpoint — a same-server:port twin isn't raced", () => {
    const A = px("A", "x.com");
    const A2 = px("A2", "x.com"); // distinct name, SAME server:port as A
    // Both are defined + selectable, but the pool selects only A.
    const cfg = parse(buildMultiConfig([channel({ proxies: [A, A2], race: [A] })]));
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const groups = cfg["proxy-groups"] as any[];
    const proxy = groups.find((g) => g.name === "PROXY");
    const auto = groups.find((g) => g.name === "AUTO");
    expect(proxy.proxies).toEqual(["AUTO", "A", "A2", "DIRECT"]);
    expect(auto.proxies).toEqual(["A"]); // endpoint-keyed matching would leak A2 here
  });
});

describe("buildMultiConfig — multiple channels", () => {
  it("shares a node across channels and routes non-default domains", () => {
    const A = px("A", "a.com");
    const B = px("B", "b.com");
    const C = px("C", "c.com");
    const raw = buildMultiConfig([
      channel({ proxies: [A, B] }),
      channel({
        id: "media",
        groupName: "ch-media",
        isDefault: false,
        policy: sticky,
        domains: ["youtube.com"],
        proxies: [B, C],
      }),
    ]);
    const cfg = parse(raw);

    // A, B, C each defined once; B is shared between the two channels.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["A", "B", "C"]);

    const groups = cfg["proxy-groups"];
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const proxy = groups.find((g: any) => g.name === "PROXY");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const auto = groups.find((g: any) => g.name === "AUTO");
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const media = groups.find((g: any) => g.name === "ch-media");
    expect(auto.type).toBe("url-test");
    expect(auto.proxies).toEqual(["A", "B"]);
    expect(media.type).toBe("select");
    expect(media.proxies).toEqual(["B", "C"]);

    // PROXY is the manual-override selector surfaced on the web Nodes screen —
    // it must reflect only the Default channel's own options, never a routing
    // group like ch-media (that's reached via the DOMAIN-SUFFIX rule below, not
    // through PROXY, and must not appear as a selectable "node").
    expect(proxy.proxies).toEqual(["AUTO", "A", "B", "DIRECT"]);
    expect(proxy.proxies).not.toContain("ch-media");

    expect(cfg.rules).toEqual([PROBE_RULE, "DOMAIN-SUFFIX,youtube.com,ch-media", "MATCH,AUTO"]);
    // The routing group itself must still exist — only its listing inside
    // PROXY is removed, not the group or the rule that targets it.
    expect(media).toBeDefined();
  });

  it("keeps same-name collapse per channel while still sharing endpoints", () => {
    const x1 = px("X", "x1.com");
    const x2 = px("X", "x2.com");
    const raw = buildMultiConfig([
      channel({ proxies: [x1, x2] }),
      channel({
        id: "media",
        groupName: "ch-media",
        isDefault: false,
        policy: sticky,
        domains: [],
        proxies: [x1],
      }),
    ]);
    const cfg = parse(raw);
    const groups = cfg["proxy-groups"];

    // Default collapses the two same-named endpoints into a subgroup.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const auto = groups.find((g: any) => g.name === "AUTO");
    expect(auto.proxies).toEqual(["X"]);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const sub = groups.find((g: any) => g.name === "X");
    expect(sub.type).toBe("url-test");
    expect(sub.proxies).toEqual(["X #1", "X #2"]);

    // media references only the shared x1 endpoint — the collapse doesn't leak in.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const media = groups.find((g: any) => g.name === "ch-media");
    expect(media.proxies).toEqual(["X #1"]);
    // Endpoints defined once, shared by index.
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    expect(cfg.proxies.map((p: any) => p.name)).toEqual(["X #1", "X #2"]);
  });

  it("falls back to MATCH,DIRECT when no channel has any proxies", () => {
    const raw = buildMultiConfig([
      channel({ proxies: [] }),
      channel({
        id: "media",
        groupName: "ch-media",
        isDefault: false,
        policy: sticky,
        domains: ["youtube.com"],
        proxies: [],
      }),
    ]);
    const cfg = parse(raw);
    expect(cfg.proxies).toEqual([]);
    expect(cfg.rules).toEqual(["MATCH,DIRECT"]);
  });

  it("emits DOMAIN-KEYWORD rules for a channel's keywords", () => {
    const A = px("A", "a.com");
    const B = px("B", "b.com");
    const cfg = parse(
      buildMultiConfig([
        channel({ proxies: [A] }),
        channel({
          id: "ads",
          groupName: "ch-ads",
          isDefault: false,
          policy: sticky,
          keywords: ["doubleclick", "adservice"],
          proxies: [B],
        }),
      ]),
    );
    expect(cfg.rules).toEqual([
      PROBE_RULE,
      "DOMAIN-KEYWORD,doubleclick,ch-ads",
      "DOMAIN-KEYWORD,adservice,ch-ads",
      "MATCH,AUTO",
    ]);
  });

  it("emits a rule-providers entry + a RULE-SET rule for an external provider", () => {
    const A = px("A", "a.com");
    const B = px("B", "b.com");
    const cfg = parse(
      buildMultiConfig([
        channel({ proxies: [A] }),
        channel({
          id: "ads",
          groupName: "ch-ads",
          isDefault: false,
          policy: sticky,
          ruleProviders: [{ url: "https://example.com/ads.yaml", behavior: "classical" }],
          proxies: [B],
        }),
      ]),
    );
    const providers = cfg["rule-providers"] as Record<string, Record<string, unknown>>;
    const names = Object.keys(providers);
    expect(names).toHaveLength(1);
    const name = names[0] as string;
    expect(name.startsWith("rp-")).toBe(true);
    expect(providers[name]).toMatchObject({
      type: "http",
      url: "https://example.com/ads.yaml",
      behavior: "classical",
      format: "yaml",
      proxy: "DIRECT",
    });
    expect(providers[name]?.path).toBe(`./providers/${name}.yaml`);
    expect(cfg.rules).toEqual([PROBE_RULE, `RULE-SET,${name},ch-ads`, "MATCH,AUTO"]);
  });

  it("dedupes an identical provider across channels into one def with two RULE-SET rules", () => {
    const A = px("A", "a.com");
    const B = px("B", "b.com");
    const ref = { url: "https://example.com/list.mrs", behavior: "domain" } as const;
    const cfg = parse(
      buildMultiConfig([
        channel({ proxies: [A] }),
        channel({
          id: "c1",
          groupName: "ch-c1",
          isDefault: false,
          policy: sticky,
          ruleProviders: [ref],
          proxies: [B],
        }),
        channel({
          id: "c2",
          groupName: "ch-c2",
          isDefault: false,
          policy: sticky,
          ruleProviders: [ref],
          proxies: [B],
        }),
      ]),
    );
    const providers = cfg["rule-providers"] as Record<string, unknown>;
    expect(Object.keys(providers)).toHaveLength(1);
    const name = Object.keys(providers)[0] as string;
    // One shared def, but each channel gets its own RULE-SET line to its own group.
    expect(cfg.rules).toEqual([
      PROBE_RULE,
      `RULE-SET,${name},ch-c1`,
      `RULE-SET,${name},ch-c2`,
      "MATCH,AUTO",
    ]);
  });

  it("omits the rule-providers key entirely when no channel has a provider", () => {
    const cfg = parse(buildMultiConfig([channel({ proxies: [px("A")] })]));
    expect(cfg["rule-providers"]).toBeUndefined();
  });

  it("emits GEOSITE/GEOIP rules and turns on geodata when a channel uses geo", () => {
    const cfg = parse(
      buildMultiConfig([
        channel({ proxies: [px("A")] }),
        channel({
          id: "geo",
          groupName: "ch-geo",
          isDefault: false,
          policy: sticky,
          geosite: ["youtube"],
          geoip: ["RU"],
          proxies: [px("B", "b.com")],
        }),
      ]),
    );
    expect(cfg.rules).toEqual([
      PROBE_RULE,
      "GEOSITE,youtube,ch-geo",
      "GEOIP,RU,ch-geo,no-resolve",
      "MATCH,AUTO",
    ]);
    expect(cfg["geodata-mode"]).toBe(true);
    expect(cfg["geox-url"].geosite).toContain("geosite.dat");
  });

  it("keeps a geo-free config free of any geodata keys", () => {
    const cfg = parse(buildMultiConfig([channel({ proxies: [px("A")] })]));
    expect(cfg["geodata-mode"]).toBeUndefined();
    expect(cfg["geox-url"]).toBeUndefined();
  });

  it("keeps a collapsed subgroup name distinct from a same-name proxy contributed by another channel", () => {
    // Default's restricted pool has two distinct endpoints sharing the name "X" —
    // groupProxies collapses them, and the Default channel keeps the bare base
    // name, so the subgroup is named "X" (see allocateSubGroupName).
    const x1 = px("X", "x1.com");
    const x2 = px("X", "x2.com");
    // A later channel independently contributes a THIRD, distinct "X" endpoint
    // that doesn't collapse (it's the only "X" in its own pool) — so it stays a
    // bare proxy literally named "X". Without the joint-namespace guard this
    // proxy and the "X" subgroup would share a name, which mihomo rejects.
    const x3 = px("X", "x3.com");
    const raw = buildMultiConfig([
      channel({ proxies: [x1, x2] }),
      channel({
        id: "media",
        groupName: "ch-media",
        isDefault: false,
        policy: sticky,
        domains: [],
        proxies: [x3],
      }),
    ]);
    const cfg = parse(raw);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const proxyNames: string[] = cfg.proxies.map((p: any) => p.name);
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const groupNames: string[] = cfg["proxy-groups"].map((g: any) => g.name);

    // The two namespaces must be jointly unique — no name may appear in both.
    const overlap = proxyNames.filter((n) => groupNames.includes(n));
    expect(overlap).toEqual([]);

    // Each namespace stays internally unique too (structurally valid config).
    expect(new Set(proxyNames).size).toBe(proxyNames.length);
    expect(new Set(groupNames).size).toBe(groupNames.length);

    // The collapsed subgroup still exists (renamed out of the way of "X"),
    // and the media channel's bare proxy still resolves to "X".
    // biome-ignore lint/suspicious/noExplicitAny: parsed yaml is untyped
    const media = cfg["proxy-groups"].find((g: any) => g.name === "ch-media");
    expect(media.proxies).toEqual(["X"]);
  });
});
