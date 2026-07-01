import { describe, expect, it } from "vitest";
import {
  nodeItemSchema,
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
