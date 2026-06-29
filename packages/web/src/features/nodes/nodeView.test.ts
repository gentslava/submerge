import { describe, expect, it } from "vitest";
import { latencyClass, latencyLabel, splitNodes } from "./nodeView";

describe("nodeView", () => {
  it("classifies latency", () => {
    expect(latencyClass(null)).toBe("idle");
    expect(latencyClass(0)).toBe("timeout");
    expect(latencyClass(47)).toBe("online");
    expect(latencyClass(100)).toBe("slow");
    expect(latencyClass(210)).toBe("slow");
  });
  it("labels latency", () => {
    expect(latencyLabel(null)).toBe("— ms");
    expect(latencyLabel(0)).toBe("timeout");
    expect(latencyLabel(47)).toBe("47 ms");
  });
  it("separates pseudo modes from real nodes", () => {
    const { modes, nodes } = splitNodes([
      { name: "AUTO", type: "URLTest", delay: null },
      { name: "NL-1", type: "vless", delay: 47 },
      { name: "DIRECT", type: "Direct", delay: null },
    ]);
    expect(modes.map((m) => m.name)).toEqual(["AUTO", "DIRECT"]);
    expect(nodes.map((n) => n.name)).toEqual(["NL-1"]);
  });
});
