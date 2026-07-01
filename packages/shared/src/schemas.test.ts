import { describe, expect, it } from "vitest";
import {
  channelPolicySchema,
  channelSchema,
  nodeItemSchema,
  nodeViewSchema,
  proxySchema,
  reorderInput,
  selectNodeInput,
  setChannelPolicyInput,
  sourceKindSchema,
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
