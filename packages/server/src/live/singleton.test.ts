import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../log.js", () => ({ log: { warn: vi.fn() } }));
vi.mock("../clients/mihomo.js", () => ({
  getDelay: vi.fn(async () => ({ delay: 42 })),
  getProxies: vi.fn(async () => ({
    proxies: { PROXY: { name: "PROXY", type: "Selector", all: ["A"], history: [] } },
  })),
  getTotals: vi.fn(),
  streamTraffic: vi.fn(),
}));
vi.mock("../modules/channels/instance.js", () => ({
  channelController: { tick: vi.fn(async () => {}) },
}));
vi.mock("../modules/channels/service.js", () => ({
  policyProbe: vi.fn(() => ({ url: "https://probe/check", intervalSec: 30 })),
  readDefaultPolicy: vi.fn(() => ({})),
}));
vi.mock("../modules/nodes/service.js", () => ({
  collectProxies: vi.fn(() => []),
  proxyMeta: vi.fn(),
  toNodeView: vi.fn(() => ({ now: null, autoNow: null, all: [] })),
}));

async function load() {
  vi.resetModules();
  vi.clearAllMocks();
  const channels = await import("../modules/channels/instance.js");
  const singleton = await import("./singleton.js");
  return { ...singleton, controllerTick: vi.mocked(channels.channelController.tick) };
}

describe("live singleton wiring", () => {
  it("fetchView feeds each raw snapshot into prober.observe", async () => {
    const { liveHub, prober } = await load();
    const observe = vi.spyOn(prober, "observe");
    await liveHub.pollOnce();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toHaveProperty("proxies.PROXY");
  });

  it("afterView runs the controller first, then a prober tick", async () => {
    const { liveHub, prober, controllerTick } = await load();
    const order: string[] = [];
    controllerTick.mockImplementation(async () => {
      order.push("controller");
    });
    const tick = vi.spyOn(prober, "tick").mockImplementation(async () => {
      order.push("prober");
    });
    await liveHub.pollOnce();
    expect(order).toEqual(["controller", "prober"]);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
