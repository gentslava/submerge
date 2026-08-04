import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../log.js", () => ({
  log: { warn: vi.fn() },
  operationalLog: vi.fn(),
}));
vi.mock("../clients/mihomo.js", () => ({
  getDelay: vi.fn(async () => ({ delay: 42 })),
  getConnections: vi.fn(async () => []),
  getProxies: vi.fn(async () => ({
    proxies: { PROXY: { name: "PROXY", type: "Selector", all: ["A"], history: [] } },
  })),
  getTotals: vi.fn(),
  openLogStream: vi.fn(async function* () {}),
  prepareForcedRouteProof: vi.fn(),
  streamTraffic: vi.fn(),
}));
vi.mock("../modules/channels/instance.js", () => ({
  registry: { runOnce: vi.fn(async () => {}) },
}));
vi.mock("../modules/channels/service.js", () => ({
  policyProbe: vi.fn(() => ({ url: "https://probe/check", intervalSec: 30 })),
  readDefaultPolicy: vi.fn(() => ({})),
}));
vi.mock("../modules/logs/singleton.js", () => ({
  domainIntelligenceRuntimeCoordinator: { recoverIfNeeded: vi.fn(async () => undefined) },
  recoverDomainRuleDeploymentIfNeeded: vi.fn(async () => undefined),
  reconcileDomainRuleDeployment: vi.fn(async () => ({
    nodes: 0,
    applied: true,
    activationVerified: true,
  })),
}));
vi.mock("../modules/nodes/service.js", () => ({
  applyConfig: vi.fn(async () => ({ nodes: 0, applied: true })),
  collectActiveRoutingInputs: vi.fn(() => ({ inputs: [], inventory: [] })),
  collectProxies: vi.fn(() => []),
  getExcludedSet: vi.fn(() => new Set()),
  hasDomainValidationRoute: vi.fn(() => false),
  proxyMeta: vi.fn(),
  readDomainValidationProxyPassword: vi.fn(() => null),
  toNodeView: vi.fn(() => ({ now: null, autoNow: null, all: [] })),
  mergeDbInventory: vi.fn((view) => view),
}));

async function load() {
  vi.resetModules();
  vi.clearAllMocks();
  const channels = await import("../modules/channels/instance.js");
  const mihomo = await import("../clients/mihomo.js");
  const logger = await import("../log.js");
  const domainIntelligence = await import("../modules/logs/singleton.js");
  const singleton = await import("./singleton.js");
  return {
    ...singleton,
    getProxiesMock: vi.mocked(mihomo.getProxies),
    operationalLogMock: vi.mocked(logger.operationalLog),
    reconcileDomainRuleDeploymentMock: vi.mocked(domainIntelligence.reconcileDomainRuleDeployment),
    recoverDomainRuleDeploymentIfNeededMock: vi.mocked(
      domainIntelligence.recoverDomainRuleDeploymentIfNeeded,
    ),
    recoverIfNeededMock: vi.mocked(
      domainIntelligence.domainIntelligenceRuntimeCoordinator.recoverIfNeeded,
    ),
    registryRunOnce: vi.mocked(channels.registry.runOnce),
  };
}

describe("live singleton wiring", () => {
  it("fetchView feeds each raw snapshot into prober.observe", async () => {
    const { liveHub, prober } = await load();
    const observe = vi.spyOn(prober, "observe");
    await liveHub.pollOnce();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toHaveProperty("proxies.PROXY");
  });

  it("afterView runs the controllers first, then a prober tick", async () => {
    const { liveHub, prober, registryRunOnce } = await load();
    const order: string[] = [];
    registryRunOnce.mockImplementation(async () => {
      order.push("controller");
    });
    const tick = vi.spyOn(prober, "tick").mockImplementation(async () => {
      order.push("prober");
    });
    await liveHub.pollOnce();
    expect(order).toEqual(["controller", "prober"]);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("routes the first mihomo outage through the curated operational logger", async () => {
    const { getProxiesMock, liveHub, operationalLogMock } = await load();
    const err = new Error("engine down");
    getProxiesMock.mockRejectedValueOnce(err);

    await liveHub.pollOnce();

    expect(operationalLogMock).toHaveBeenCalledWith("mihomo-live-failed", { scope: "poll" }, err);
  });

  it("retries deployment before runtime activation on the first healthy engine poll", async () => {
    const { liveHub, recoverDomainRuleDeploymentIfNeededMock, recoverIfNeededMock } = await load();
    const events: string[] = [];
    recoverDomainRuleDeploymentIfNeededMock.mockImplementationOnce(async () => {
      events.push("deployment");
    });
    recoverIfNeededMock.mockImplementationOnce(async () => {
      events.push("runtime");
    });

    await liveHub.pollOnce();

    await vi.waitFor(() => expect(recoverIfNeededMock).toHaveBeenCalledOnce());
    expect(events).toEqual(["deployment", "runtime"]);
  });

  it("runs full deployment reconciliation after a genuine engine reconnect", async () => {
    const { getProxiesMock, liveHub, reconcileDomainRuleDeploymentMock } = await load();
    await liveHub.pollOnce();
    getProxiesMock.mockRejectedValueOnce(new Error("engine restarting"));
    await liveHub.pollOnce();

    await liveHub.pollOnce();

    await vi.waitFor(() => expect(reconcileDomainRuleDeploymentMock).toHaveBeenCalledOnce());
  });
});
