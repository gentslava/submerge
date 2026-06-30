import { describe, expect, it } from "vitest";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { toNodeView } from "./service.js";

const resp: ProxiesResponse = {
  proxies: {
    PROXY: { name: "PROXY", type: "Selector", now: "NL-1", all: ["NL-1", "DE-2"], history: [] },
    AUTO: { name: "AUTO", type: "URLTest", now: "NL-1", all: ["NL-1", "DE-2"], history: [] },
    "NL-1": {
      name: "NL-1",
      type: "Vless",
      history: [
        { time: "t", delay: 0 },
        { time: "t", delay: 42 },
      ],
    },
    "DE-2": { name: "DE-2", type: "Vless", history: [{ time: "t", delay: 0 }] },
  },
};

describe("toNodeView", () => {
  it("maps the PROXY group to a NodeView with delays, history and autoNow", () => {
    const view = toNodeView(resp);
    expect(view.now).toBe("NL-1");
    expect(view.autoNow).toBe("NL-1");
    expect(view.all).toEqual([
      // timeouts (0) are KEPT in history (stability signal); last value drives delay
      { name: "NL-1", type: "Vless", delay: 42, history: [0, 42] },
      { name: "DE-2", type: "Vless", delay: null, history: [0] },
    ]);
  });

  it("returns an empty view when there is no PROXY group", () => {
    expect(toNodeView({ proxies: {} })).toEqual({ now: null, autoNow: null, all: [] });
  });
});
