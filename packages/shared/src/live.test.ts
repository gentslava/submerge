import { describe, expect, it } from "vitest";
import { liveEventSchema, trafficSampleSchema } from "./schemas.js";

describe("live schemas", () => {
  it("parses a traffic sample", () => {
    expect(trafficSampleSchema.parse({ up: 10, down: 20 })).toEqual({ up: 10, down: 20 });
  });

  it("parses a nodeUpdate event", () => {
    const evt = liveEventSchema.parse({
      type: "nodeUpdate",
      view: { now: "NL-1", autoNow: null, all: [{ name: "NL-1", type: "vless", delay: 42 }] },
    });
    expect(evt.type).toBe("nodeUpdate");
  });

  it("parses a traffic event and a health event", () => {
    expect(liveEventSchema.parse({ type: "traffic", up: 1, down: 2 }).type).toBe("traffic");
    expect(liveEventSchema.parse({ type: "health", mihomo: false }).type).toBe("health");
  });

  it("parses a totals event (cumulative bytes)", () => {
    const evt = liveEventSchema.parse({ type: "totals", up: 1200, down: 8400 });
    expect(evt).toEqual({ type: "totals", up: 1200, down: 8400 });
  });

  it("rejects an unknown event type", () => {
    expect(() => liveEventSchema.parse({ type: "nope" })).toThrow();
  });
});
