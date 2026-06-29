import { describe, expect, it } from "vitest";
import {
  nodeViewSchema,
  proxySchema,
  reorderInput,
  selectNodeInput,
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

describe("phase2 schemas", () => {
  it("validates a node view", () => {
    const v = nodeViewSchema.parse({ now: "n1", all: [{ name: "n1", type: "vless", delay: 42 }] });
    expect(v.all[0]?.delay).toBe(42);
  });
  it("allows a null delay (unreachable / untested)", () => {
    const v = nodeViewSchema.parse({
      now: null,
      all: [{ name: "n1", type: "vless", delay: null }],
    });
    expect(v.all[0]?.delay).toBeNull();
  });
  it("validates select + reorder inputs", () => {
    expect(selectNodeInput.parse({ group: "PROXY", name: "n1" }).group).toBe("PROXY");
    expect(reorderInput.parse({ ids: [3, 1, 2] }).ids).toHaveLength(3);
  });
});
