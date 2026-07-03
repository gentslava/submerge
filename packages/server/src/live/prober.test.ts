import { describe, expect, it, vi } from "vitest";
import type { ProxiesResponse } from "../clients/mihomo.js";
import { Prober } from "./prober.js";

// PROXY.all lists AUTO (pseudo, must be ignored) + the real node names.
// `times[name]` = ISO timestamp of the node's latest measurement (absent = never).
function resp(names: string[], times: Record<string, string> = {}): ProxiesResponse {
  const proxies: Record<string, unknown> = {
    PROXY: { name: "PROXY", type: "Selector", all: ["AUTO", ...names], history: [] },
    AUTO: { name: "AUTO", type: "URLTest", history: [] },
  };
  for (const n of names) {
    proxies[n] = {
      name: n,
      type: "vless",
      history: times[n] ? [{ time: times[n], delay: 50 }] : [],
    };
  }
  return { proxies } as ProxiesResponse;
}

const T0 = 1_000_000_000_000; // fixed "now" for deterministic staleness math

function makeProber(over: { intervalSec?: number; nowMs?: () => number } = {}) {
  const probe = vi.fn(async () => ({}));
  const prober = new Prober({
    probe,
    getProbeConfig: () => ({ url: "https://t/check", intervalSec: over.intervalSec ?? 60 }),
    pulseMs: 5000,
    now: over.nowMs ?? (() => T0),
  });
  return { prober, probe };
}

describe("Prober staleness", () => {
  it("probes only nodes without a fresh measurement, sweeping across ticks", async () => {
    const { prober, probe } = makeProber();
    prober.observe(
      resp(["fresh", "stale", "never"], {
        fresh: new Date(T0 - 1_000).toISOString(), // 1 s ago — fresh
        stale: new Date(T0 - 120_000).toISOString(), // 2 min ago — older than N=60 s
      }),
    );
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(1); // batch = max(1, ceil(3×5000/60000)) = 1
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(2); // rotation reaches the second stale node
    const probed = probe.mock.calls.map((c) => c[0]).sort();
    expect(probed).toEqual(["never", "stale"]); // fresh is never probed
    expect(probe).toHaveBeenCalledWith("stale", "https://t/check");
  });

  it("ignores pseudo names and probes nothing when everything is fresh", async () => {
    const { prober, probe } = makeProber();
    prober.observe(resp(["a"], { a: new Date(T0 - 1_000).toISOString() }));
    await prober.tick();
    expect(probe).not.toHaveBeenCalled();
  });

  it("drops vanished nodes from rotation and state on the next observe", async () => {
    const { prober, probe } = makeProber({ intervalSec: 10 }); // batch = ceil(3×5/10) = 2
    prober.observe(resp(["a", "b", "c"])); // all stale (never measured)
    prober.observe(resp(["a", "c"])); // b vanished (reload/rename)
    await prober.tick();
    await prober.tick();
    const probed = probe.mock.calls.map((c) => c[0]);
    expect(probed).toContain("a");
    expect(probed).toContain("c");
    expect(probed).not.toContain("b"); // pruned from names/rotation — never probed
  });
});
