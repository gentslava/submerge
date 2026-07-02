import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The singleton wires the hub to the real db/clients at import time — mock every
// side-effectful dependency so only the throttle logic under test remains.
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../log.js", () => ({ log: { warn: vi.fn() } }));
vi.mock("../clients/mihomo.js", () => ({
  getDelay: vi.fn(async () => ({ delay: 42 })),
  getProxies: vi.fn(),
  getTotals: vi.fn(),
  streamTraffic: vi.fn(),
}));
vi.mock("../modules/channels/instance.js", () => ({ channelController: { tick: vi.fn() } }));
vi.mock("../modules/channels/service.js", () => ({
  policyProbe: vi.fn(() => ({ url: "https://probe/check", intervalSec: 30 })),
  readDefaultPolicy: vi.fn(() => ({})),
}));
vi.mock("../modules/nodes/service.js", () => ({
  collectProxies: vi.fn(() => []),
  proxyMeta: vi.fn(),
  toNodeView: vi.fn(),
}));
vi.mock("../modules/settings/service.js", () => ({ getSetting: vi.fn(() => null) }));

// `lastProbe` is module-global state — re-import a fresh registry per test so the
// throttle starts cold. Mock instances survive resetModules, so also clear their
// accumulated call counts.
async function load() {
  vi.resetModules();
  vi.clearAllMocks();
  const mihomo = await import("../clients/mihomo.js");
  const singleton = await import("./singleton.js");
  return { probe: singleton.probeActiveThrottled, getDelay: vi.mocked(mihomo.getDelay) };
}

describe("probeActiveThrottled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("never delay-tests mihomo's built-in pseudo policies", async () => {
    const { probe, getDelay } = await load();
    for (const pseudo of ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]) {
      await probe(pseudo);
    }
    expect(getDelay).not.toHaveBeenCalled();
    // …and a pseudo call must not consume the throttle window for real nodes.
    await probe("NL-1");
    expect(getDelay).toHaveBeenCalledExactlyOnceWith("NL-1", "https://probe/check");
  });

  it("probes at most once per check interval", async () => {
    const { probe, getDelay } = await load();
    await probe("NL-1");
    await probe("NL-1"); // same tick — throttled
    vi.advanceTimersByTime(10_000);
    await probe("NL-1"); // 10 s of a 30 s interval — still throttled
    expect(getDelay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000); // 30 s elapsed
    await probe("NL-1");
    expect(getDelay).toHaveBeenCalledTimes(2);
  });

  it("allows 1 s of poll-timing jitter before the full interval", async () => {
    const { probe, getDelay } = await load();
    await probe("NL-1");
    vi.advanceTimersByTime(29_000 - 1); // just inside interval - slack
    await probe("NL-1");
    expect(getDelay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); // exactly interval - 1 s slack
    await probe("NL-1");
    expect(getDelay).toHaveBeenCalledTimes(2);
  });
});
