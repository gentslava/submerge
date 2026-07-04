import { describe, expect, it } from "vitest";
import {
  channelMatcherSchema,
  channelPolicySchema,
  channelPoolMemberSchema,
  channelSchema,
  channelWithPoolSchema,
  createChannelInput,
  deleteChannelInput,
  isValidDomain,
  nodeItemSchema,
  nodeViewSchema,
  proxySchema,
  reorderChannelsInput,
  reorderInput,
  selectNodeInput,
  setChannelPolicyInput,
  setChannelPoolInput,
  sourceKindSchema,
  updateChannelInput,
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
});

describe("channelSchema", () => {
  it("parses a default channel row", () => {
    const c = channelSchema.parse({
      id: "default",
      name: "Default",
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
      matcher: { presets: [], domains: [] },
      lastReason: null,
      lastReasonAt: null,
    });
    expect(c.isDefault).toBe(true);
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
      matcher: { presets: [], domains: [] },
      lastReason: null,
      lastReasonAt: null,
      pool: [{ kind: "source", ref: "1" }],
    });
    expect(c.pool).toEqual([{ kind: "source", ref: "1" }]);
  });
});
