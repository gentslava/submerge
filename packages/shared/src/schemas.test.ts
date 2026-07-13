import { describe, expect, it } from "vitest";
import { DEFAULT_SPEED_POLICY, emptyChannelMatcher } from "./defaults.js";
import {
  channelGroupName,
  channelMatcherInputSchema,
  channelMatcherSchema,
  channelPolicySchema,
  channelPoolMemberSchema,
  channelSchema,
  channelWithPoolSchema,
  cidrVersion,
  createChannelInput,
  deleteChannelInput,
  directChannelSchema,
  directPresetSettingsSchema,
  isValidCidr,
  isValidDomain,
  nodeItemSchema,
  nodeViewSchema,
  proxyChannelSchema,
  proxySchema,
  reorderChannelsInput,
  reorderInput,
  ruleProviderFormat,
  ruleProviderRefSchema,
  selectNodeInput,
  setChannelPolicyInput,
  setChannelPoolInput,
  sourceKindSchema,
  updateChannelInput,
  updateDirectInput,
} from "./schemas.js";

describe("schemas", () => {
  it("accepts a valid kind", () => {
    expect(sourceKindSchema.parse("sub")).toBe("sub");
  });
  it("rejects an unknown kind", () => {
    expect(() => sourceKindSchema.parse("nope")).toThrow();
  });
  it("validates a minimal proxy", () => {
    const p = proxySchema.parse({
      name: "n1",
      type: "vless",
      server: "ex.com",
      port: 443,
      uuid: "u",
    });
    expect(p.name).toBe("n1");
  });
});

describe("channelGroupName", () => {
  it("keeps the Default group as AUTO and namespaces other channels by id", () => {
    expect(channelGroupName({ id: "default", isDefault: true, target: "proxy" })).toBe("AUTO");
    expect(channelGroupName({ id: "streaming", isDefault: false, target: "proxy" })).toBe(
      "ch-streaming",
    );
  });
});

describe("nodeView + tRPC input schemas", () => {
  it("validates a node view (history defaults to [])", () => {
    const v = nodeViewSchema.parse({
      now: "n1",
      autoNow: null,
      all: [{ name: "n1", type: "vless", delay: 42 }],
    });
    expect(v.all[0]?.delay).toBe(42);
    expect(v.all[0]?.history).toEqual([]);
  });
  it("allows a null delay (unreachable / untested)", () => {
    const v = nodeViewSchema.parse({
      now: null,
      autoNow: null,
      all: [{ name: "n1", type: "vless", delay: null, history: [120, 0, 95] }],
    });
    expect(v.all[0]?.delay).toBeNull();
    expect(v.all[0]?.history).toEqual([120, 0, 95]);
  });
  it("validates select + reorder inputs", () => {
    expect(selectNodeInput.parse({ group: "PROXY", name: "n1" }).group).toBe("PROXY");
    expect(reorderInput.parse({ ids: [3, 1, 2] }).ids).toHaveLength(3);
  });
  it("rejects an empty group", () => {
    expect(() => selectNodeInput.parse({ group: "", name: "n1" })).toThrow();
  });
  it("accepts only the public PROXY selection group", () => {
    expect(() => selectNodeInput.parse({ group: "AUTO", name: "n1" })).toThrow();
  });
});

describe("nodeItemSchema.members", () => {
  it("accepts a node without members", () => {
    const n = nodeItemSchema.parse({ name: "A", type: "vless", delay: 47 });
    expect(n.members).toBeUndefined();
  });
  it("parses a collapsed group's members", () => {
    const n = nodeItemSchema.parse({
      name: "G",
      type: "URLTest",
      delay: 40,
      members: [{ name: "G #1", delay: 40, active: true }],
    });
    expect(n.members).toEqual([{ name: "G #1", delay: 40, history: [], active: true }]);
  });
});

describe("channelPolicySchema", () => {
  it("accepts a speed policy", () => {
    const p = channelPolicySchema.parse({
      kind: "speed",
      testUrl: "https://x/generate_204",
      intervalSec: 300,
      toleranceMs: 50,
      reevaluateWhileHealthy: true,
    });
    expect(p.kind).toBe("speed");
  });
  it("accepts a sticky policy with null maxHoldHours", () => {
    const p = channelPolicySchema.parse({
      kind: "sticky",
      testUrl: "https://x/generate_204",
      intervalSec: 60,
      failureThreshold: 3,
      maxHoldHours: null,
      initialCriterion: "fastest",
    });
    expect(p.kind === "sticky" && p.maxHoldHours).toBeNull();
  });
  it("accepts an optimal policy (no toleranceMs — the switch margin is relative)", () => {
    const p = channelPolicySchema.parse({
      kind: "optimal",
      testUrl: "https://x/generate_204",
      intervalSec: 60,
    });
    expect(p.kind).toBe("optimal");
    // A legacy row carrying the dropped toleranceMs still parses (extra key stripped).
    const legacy = channelPolicySchema.parse({
      kind: "optimal",
      testUrl: "u",
      intervalSec: 60,
      toleranceMs: 50,
    });
    expect(legacy.kind === "optimal" && "toleranceMs" in legacy).toBe(false);
  });
  it("rejects an optimal policy with intervalSec below 1", () => {
    expect(() =>
      channelPolicySchema.parse({ kind: "optimal", testUrl: "u", intervalSec: 0 }),
    ).toThrow();
  });
  it("rejects an unknown kind", () => {
    expect(() => channelPolicySchema.parse({ kind: "nope" })).toThrow();
  });
  it("rejects intervalSec below 1", () => {
    expect(() =>
      channelPolicySchema.parse({
        kind: "speed",
        testUrl: "u",
        intervalSec: 0,
        toleranceMs: 0,
        reevaluateWhileHealthy: false,
      }),
    ).toThrow();
  });
});

describe("domainSchema / isValidDomain", () => {
  it("accepts well-formed hostnames", () => {
    for (const domain of [
      "youtube.com",
      "www.googlevideo.com",
      "t.me",
      "localhost",
      "xn--80ak6aa92e.com",
      "my-domain.com",
    ]) {
      expect(isValidDomain(domain)).toBe(true);
    }
  });

  it("rejects a domain containing a comma, space, or newline (malformed mihomo rule)", () => {
    expect(isValidDomain("bad,domain")).toBe(false);
    expect(isValidDomain("bad domain")).toBe(false);
    expect(isValidDomain("bad\ndomain")).toBe(false);
    expect(isValidDomain(" ")).toBe(false);
  });

  it("rejects malformed hostname shapes", () => {
    expect(isValidDomain("-lead.com")).toBe(false);
    expect(isValidDomain("trail-.com")).toBe(false);
    expect(isValidDomain("a..b.com")).toBe(false);
    expect(isValidDomain("*.youtube.com")).toBe(false);
    expect(isValidDomain("")).toBe(false);
  });
});

describe("channelMatcherSchema (read model stays permissive)", () => {
  it("still accepts a malformed domain — a legacy/corrupt row must not fail parsing", () => {
    const m = channelMatcherSchema.parse({ presets: [], domains: ["bad,domain"] });
    expect(m.domains).toEqual(["bad,domain"]);
  });
  it("defaults the Phase-4a fields (keywords, ruleProviders) to empty on a legacy row", () => {
    const m = channelMatcherSchema.parse({ presets: [], domains: [] });
    expect(m.keywords).toEqual([]);
    expect(m.ruleProviders).toEqual([]);
  });

  it("defaults CIDRs to empty while retaining malformed legacy values", () => {
    expect(channelMatcherSchema.parse({ presets: [], domains: [] }).cidrs).toEqual([]);
    expect(
      channelMatcherSchema.parse({ presets: [], domains: [], cidrs: ["not-a-cidr"] }).cidrs,
    ).toEqual(["not-a-cidr"]);
  });
});

describe("CIDR matcher fields", () => {
  it("trims and accepts IPv4 and IPv6 CIDRs at the write boundary", () => {
    const matcher = channelMatcherInputSchema.parse({
      presets: [],
      domains: [],
      cidrs: [" 10.0.0.0/8 ", " 2001:db8::/32 "],
    });
    expect(matcher.cidrs).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
  });

  it("rejects bare IPs, invalid prefixes, delimiters, newlines, and blanks", () => {
    for (const cidr of [
      "192.168.1.1",
      "2001:db8::1",
      "10.0.0.0/33",
      "2001:db8::/129",
      "10.0.0.0/8,192.168.0.0/16",
      "10.0.0.0/8\n192.168.0.0/16",
      " ",
    ]) {
      expect(
        channelMatcherInputSchema.safeParse({ presets: [], domains: [], cidrs: [cidr] }).success,
      ).toBe(false);
    }
  });

  it("validates and identifies CIDR families through the shared contract", () => {
    expect(isValidCidr(" 10.0.0.0/8 ")).toBe(true);
    expect(isValidCidr("2001:db8::/32")).toBe(true);
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(cidrVersion(" 10.0.0.0/8 ")).toBe(4);
    expect(cidrVersion("2001:db8::/32")).toBe(6);
    expect(cidrVersion("not-a-cidr")).toBeNull();
  });

  it("includes CIDRs in a fresh empty matcher", () => {
    expect(emptyChannelMatcher().cidrs).toEqual([]);
  });
});

describe("ruleProviderFormat (derived from the URL extension)", () => {
  it("maps extensions to mihomo formats, defaulting to yaml", () => {
    expect(ruleProviderFormat("https://x/a.yaml")).toBe("yaml");
    expect(ruleProviderFormat("https://x/a.yml")).toBe("yaml");
    expect(ruleProviderFormat("https://x/a.list")).toBe("text");
    expect(ruleProviderFormat("https://x/a.txt")).toBe("text");
    expect(ruleProviderFormat("https://x/a.mrs")).toBe("mrs");
    expect(ruleProviderFormat("https://x/get?list=ads")).toBe("yaml"); // no clear ext → default
  });
  it("ignores query/hash when reading the extension", () => {
    expect(ruleProviderFormat("https://x/a.mrs?v=2")).toBe("mrs");
    expect(ruleProviderFormat("https://x/a.list#frag")).toBe("text");
  });
});

describe("ruleProviderRefSchema (format is derived from the URL, not chosen)", () => {
  it("accepts an https classical provider (no format field)", () => {
    const r = ruleProviderRefSchema.parse({
      url: "https://example.com/reject.yaml",
      behavior: "classical",
    });
    expect(r.behavior).toBe("classical");
    expect("format" in r).toBe(false);
  });
  it("accepts an .mrs url with domain behavior", () => {
    const r = ruleProviderRefSchema.parse({ url: "https://example.com/x.mrs", behavior: "domain" });
    expect(r.behavior).toBe("domain");
  });
  it("rejects an .mrs url with classical behavior (mihomo forbids mrs+classical)", () => {
    expect(() =>
      ruleProviderRefSchema.parse({ url: "https://example.com/x.mrs", behavior: "classical" }),
    ).toThrow();
  });
  it("rejects a non-http(s) url", () => {
    expect(() =>
      ruleProviderRefSchema.parse({ url: "ftp://example.com/x.yaml", behavior: "domain" }),
    ).toThrow();
  });
  it("keeps a legacy http(s) prefix readable even when the host is invalid", () => {
    expect(ruleProviderRefSchema.parse({ url: "http://", behavior: "domain" }).url).toBe("http://");
  });
  it("rejects an unknown behavior", () => {
    expect(() =>
      ruleProviderRefSchema.parse({ url: "https://example.com/x", behavior: "bogus" }),
    ).toThrow();
  });
});

describe("geo matcher fields (Phase 4b)", () => {
  it("accepts geosite categories (incl. geolocation-!cn / tag@attr) and geoip codes", () => {
    const m = channelMatcherInputSchema.parse({
      presets: [],
      domains: [],
      geosite: ["youtube", "category-ads-all", "geolocation-!cn", "youtube@ads"],
      geoip: ["RU", "CN", "PRIVATE", "LAN"],
    });
    expect(m.geosite).toEqual(["youtube", "category-ads-all", "geolocation-!cn", "youtube@ads"]);
    expect(m.geoip).toEqual(["RU", "CN", "PRIVATE", "LAN"]);
  });
  it("rejects a non-code geoip token like TELEGRAM", () => {
    expect(() =>
      channelMatcherInputSchema.parse({ presets: [], domains: [], geoip: ["TELEGRAM"] }),
    ).toThrow();
  });
  it("defaults geosite/geoip to []", () => {
    const m = channelMatcherInputSchema.parse({ presets: [], domains: [] });
    expect(m.geosite).toEqual([]);
    expect(m.geoip).toEqual([]);
  });
  it("rejects an upper-case geosite category or a lower-case / malformed geoip code", () => {
    expect(() =>
      channelMatcherInputSchema.parse({ presets: [], domains: [], geosite: ["YouTube"] }),
    ).toThrow();
    expect(() =>
      channelMatcherInputSchema.parse({ presets: [], domains: [], geoip: ["ru"] }),
    ).toThrow();
    expect(() =>
      channelMatcherInputSchema.parse({ presets: [], domains: [], geoip: ["R1"] }),
    ).toThrow();
  });
  it("read model defaults geo fields on a legacy row", () => {
    const m = channelMatcherSchema.parse({ presets: [], domains: [] });
    expect(m.geosite).toEqual([]);
    expect(m.geoip).toEqual([]);
  });
});

describe("stickyPolicySchema highest-bandwidth (Phase 4c)", () => {
  it("accepts the highest-bandwidth criterion", () => {
    const p = channelPolicySchema.parse({
      kind: "sticky",
      testUrl: "https://x/generate_204",
      intervalSec: 60,
      failureThreshold: 3,
      maxHoldHours: null,
      initialCriterion: "highest-bandwidth",
    });
    expect(p.kind === "sticky" && p.initialCriterion).toBe("highest-bandwidth");
  });
});

describe("channelMatcherInputSchema (Phase-4a: keywords + ruleProviders)", () => {
  it("accepts keywords and rule-provider refs", () => {
    const m = channelMatcherInputSchema.parse({
      presets: [],
      domains: [],
      keywords: ["google", "double-click"],
      ruleProviders: [{ url: "https://example.com/ads.yaml", behavior: "classical" }],
    });
    expect(m.keywords).toEqual(["google", "double-click"]);
    expect(m.ruleProviders).toHaveLength(1);
  });
  it("defaults keywords and ruleProviders to []", () => {
    const m = channelMatcherInputSchema.parse({ presets: [], domains: [] });
    expect(m.keywords).toEqual([]);
    expect(m.ruleProviders).toEqual([]);
  });
  it("rejects a keyword with whitespace or a comma (malformed mihomo rule)", () => {
    expect(() =>
      channelMatcherInputSchema.parse({ presets: [], domains: [], keywords: ["bad kw"] }),
    ).toThrow();
    expect(() =>
      channelMatcherInputSchema.parse({ presets: [], domains: [], keywords: ["bad,kw"] }),
    ).toThrow();
  });
  it("rejects a rule-provider with a bad url at the write boundary", () => {
    expect(() =>
      channelMatcherInputSchema.parse({
        presets: [],
        domains: [],
        ruleProviders: [{ url: "not-a-url", behavior: "domain" }],
      }),
    ).toThrow();
    expect(() =>
      channelMatcherInputSchema.parse({
        presets: [],
        domains: [],
        ruleProviders: [{ url: "http://", behavior: "domain" }],
      }),
    ).toThrow();
  });
});

describe("channelSchema", () => {
  it("parses a default channel row", () => {
    const c = channelSchema.parse({
      id: "default",
      name: "Default",
      target: "proxy",
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: {
        kind: "speed",
        testUrl: "u",
        intervalSec: 300,
        toleranceMs: 50,
        reevaluateWhileHealthy: true,
      },
      matcher: emptyChannelMatcher(),
      lastReason: null,
      lastReasonAt: null,
    });
    expect(c.isDefault).toBe(true);
    expect(c).toHaveProperty("target", "proxy");
  });

  it("requires the explicit proxy target and rejects unknown fields", () => {
    const row = {
      id: "default",
      name: "Default",
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: {
        kind: "speed" as const,
        testUrl: "u",
        intervalSec: 300,
        toleranceMs: 50,
        reevaluateWhileHealthy: true,
      },
      matcher: emptyChannelMatcher(),
      lastReason: null,
      lastReasonAt: null,
    };

    expect(() => channelSchema.parse(row)).toThrow();
    expect(() => channelSchema.parse({ ...row, target: "direct" })).toThrow();
    expect(() => channelSchema.parse({ ...row, target: "proxy", directPresets: null })).toThrow();
  });

  it("parses the strict Direct variant with its literal system identity", () => {
    const direct = channelSchema.parse({
      id: "direct",
      name: "Direct",
      target: "direct",
      priority: 0,
      enabled: true,
      isDefault: false,
      matcher: emptyChannelMatcher(),
      directPresets: { privateNetworks: true, localDomains: true },
    });

    expect(direct).toEqual({
      id: "direct",
      name: "Direct",
      target: "direct",
      priority: 0,
      enabled: true,
      isDefault: false,
      matcher: emptyChannelMatcher(),
      directPresets: { privateNetworks: true, localDomains: true },
    });
  });

  it("keeps both target variants strict and rejects proxy-only fields on Direct", () => {
    const direct = {
      id: "direct",
      name: "Direct",
      target: "direct" as const,
      priority: 0,
      enabled: true,
      isDefault: false,
      matcher: emptyChannelMatcher(),
      directPresets: { privateNetworks: true, localDomains: true },
    };
    expect(() => channelSchema.parse({ ...direct, policy: DEFAULT_SPEED_POLICY })).toThrow();
    expect(() => channelSchema.parse({ ...direct, lastReason: null })).toThrow();
    expect(() => channelSchema.parse({ ...direct, id: "other" })).toThrow();
    expect(() => channelSchema.parse({ ...direct, name: "Bypass" })).toThrow();
    expect(() => channelSchema.parse({ ...direct, isDefault: true })).toThrow();
  });

  it("exports distinct strict target schemas", () => {
    expect(proxyChannelSchema).not.toBe(channelSchema);
    expect(() =>
      directChannelSchema.parse({
        id: "direct",
        name: "Direct",
        target: "direct",
        priority: 0,
        enabled: true,
        isDefault: false,
        matcher: emptyChannelMatcher(),
        directPresets: { privateNetworks: true, localDomains: true },
        unknown: true,
      }),
    ).toThrow();
  });
});

describe("directPresetSettingsSchema", () => {
  it("requires exactly both system-preset booleans", () => {
    expect(
      directPresetSettingsSchema.safeParse({ privateNetworks: true, localDomains: false }).success,
    ).toBe(true);
    expect(directPresetSettingsSchema.safeParse({ privateNetworks: true }).success).toBe(false);
    expect(
      directPresetSettingsSchema.safeParse({
        privateNetworks: true,
        localDomains: false,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("setChannelPolicyInput", () => {
  it("requires id and a valid policy", () => {
    expect(() => setChannelPolicyInput.parse({ id: "", policy: {} })).toThrow();
  });
});

describe("channelPoolMemberSchema", () => {
  it("accepts a source pool member", () => {
    const m = channelPoolMemberSchema.parse({ kind: "source", ref: "1" });
    expect(m).toEqual({ kind: "source", ref: "1" });
  });
  it("accepts a node pool member", () => {
    const m = channelPoolMemberSchema.parse({ kind: "node", ref: "n1" });
    expect(m.kind).toBe("node");
  });
  it("rejects an unknown kind", () => {
    expect(() => channelPoolMemberSchema.parse({ kind: "proxy", ref: "n1" })).toThrow();
  });
  it("rejects an empty ref", () => {
    expect(() => channelPoolMemberSchema.parse({ kind: "source", ref: "" })).toThrow();
  });
});

describe("createChannelInput", () => {
  const policy = {
    kind: "speed",
    testUrl: "https://x/generate_204",
    intervalSec: 300,
    toleranceMs: 50,
    reevaluateWhileHealthy: true,
  } as const;

  it("accepts a name + policy, matcher optional", () => {
    const input = createChannelInput.parse({ name: "Streaming", policy });
    expect(input.name).toBe("Streaming");
    expect(input.matcher).toBeUndefined();
  });
  it("accepts an explicit matcher", () => {
    const input = createChannelInput.parse({
      name: "Streaming",
      policy,
      matcher: { presets: ["netflix"], domains: [] },
    });
    expect(input.matcher?.presets).toEqual(["netflix"]);
  });
  it("rejects an empty name", () => {
    expect(() => createChannelInput.parse({ name: "", policy })).toThrow();
  });
  it("rejects a matcher with a comma in a domain (write-boundary validation)", () => {
    expect(() =>
      createChannelInput.parse({
        name: "Streaming",
        policy,
        matcher: { presets: [], domains: ["bad,domain"] },
      }),
    ).toThrow();
  });
  it("accepts a matcher with a well-formed domain", () => {
    const input = createChannelInput.parse({
      name: "Streaming",
      policy,
      matcher: { presets: [], domains: ["youtube.com"] },
    });
    expect(input.matcher?.domains).toEqual(["youtube.com"]);
  });
});

describe("updateChannelInput", () => {
  it("accepts a partial update (name only)", () => {
    const input = updateChannelInput.parse({ id: "c1", name: "Renamed" });
    expect(input.enabled).toBeUndefined();
  });
  it("accepts id-only (all other fields optional)", () => {
    const input = updateChannelInput.parse({ id: "c1" });
    expect(input.id).toBe("c1");
  });
  it("rejects an empty name when provided", () => {
    expect(() => updateChannelInput.parse({ id: "c1", name: "" })).toThrow();
  });
  it("rejects a missing id", () => {
    expect(() => updateChannelInput.parse({ name: "Renamed" })).toThrow();
  });
  it("rejects a matcher with a space in a domain (write-boundary validation)", () => {
    expect(() =>
      updateChannelInput.parse({ id: "c1", matcher: { presets: [], domains: ["bad domain"] } }),
    ).toThrow();
  });
  it("accepts a matcher with a well-formed domain", () => {
    const input = updateChannelInput.parse({
      id: "c1",
      matcher: { presets: [], domains: ["youtube.com"] },
    });
    expect(input.matcher?.domains).toEqual(["youtube.com"]);
  });
});

describe("updateDirectInput", () => {
  it("accepts only non-empty atomic Direct patches", () => {
    expect(updateDirectInput.safeParse({ enabled: false }).success).toBe(true);
    expect(
      updateDirectInput.safeParse({
        matcher: { presets: [], domains: [], cidrs: ["10.0.0.0/8"] },
        directPresets: { privateNetworks: false, localDomains: true },
      }).success,
    ).toBe(true);
    expect(updateDirectInput.safeParse({}).success).toBe(false);
  });

  it("rejects every proxy-only and unknown field instead of stripping it", () => {
    for (const forbidden of [
      { id: "direct" },
      { name: "Direct" },
      { policy: DEFAULT_SPEED_POLICY },
      { pool: [] },
      { isDefault: false },
      { target: "direct" },
      { lastReason: null },
      { unknown: true },
    ]) {
      expect(updateDirectInput.safeParse({ enabled: true, ...forbidden }).success).toBe(false);
    }
  });
});

describe("deleteChannelInput", () => {
  it("requires a non-empty id", () => {
    expect(deleteChannelInput.parse({ id: "c1" }).id).toBe("c1");
    expect(() => deleteChannelInput.parse({ id: "" })).toThrow();
  });
});

describe("reorderChannelsInput", () => {
  it("accepts an array of ids", () => {
    expect(reorderChannelsInput.parse({ ids: ["c1", "c2"] }).ids).toEqual(["c1", "c2"]);
  });
  it("rejects an empty-string id in the array", () => {
    expect(() => reorderChannelsInput.parse({ ids: ["c1", ""] })).toThrow();
  });
});

describe("setChannelPoolInput", () => {
  it("accepts an id + array of pool members", () => {
    const input = setChannelPoolInput.parse({
      id: "c1",
      members: [
        { kind: "source", ref: "1" },
        { kind: "node", ref: "n1" },
      ],
    });
    expect(input.members).toHaveLength(2);
  });
  it("rejects an unknown member kind", () => {
    expect(() =>
      setChannelPoolInput.parse({ id: "c1", members: [{ kind: "bogus", ref: "1" }] }),
    ).toThrow();
  });
});

describe("channelWithPoolSchema", () => {
  it("extends channelSchema with a pool array", () => {
    const c = channelWithPoolSchema.parse({
      id: "default",
      name: "Default",
      target: "proxy",
      priority: 0,
      enabled: true,
      isDefault: true,
      policy: {
        kind: "speed",
        testUrl: "u",
        intervalSec: 300,
        toleranceMs: 50,
        reevaluateWhileHealthy: true,
      },
      matcher: emptyChannelMatcher(),
      lastReason: null,
      lastReasonAt: null,
      pool: [{ kind: "source", ref: "1" }],
    });
    expect(c.pool).toEqual([{ kind: "source", ref: "1" }]);
  });
});
