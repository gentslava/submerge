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

describe("Prober last-known overlay", () => {
  // Like resp(), but with per-node delay values.
  function respWith(
    entries: Record<string, { time: string; delay: number } | null>,
  ): ProxiesResponse {
    const names = Object.keys(entries);
    const proxies: Record<string, unknown> = {
      PROXY: { name: "PROXY", type: "Selector", all: ["AUTO", ...names], history: [] },
      AUTO: { name: "AUTO", type: "URLTest", history: [] },
    };
    for (const n of names) {
      proxies[n] = { name: n, type: "vless", history: entries[n] ? [entries[n]] : [] };
    }
    return { proxies } as ProxiesResponse;
  }

  const view = (all: Array<{ name: string; delay: number | null; history: number[] }>) => ({
    now: null,
    autoNow: null,
    all: all.map((n) => ({ ...n, type: "vless" })),
  });

  it("restores last-known delays for nodes whose history was wiped by a reload", () => {
    const { prober } = makeProber();
    prober.observe(
      respWith({
        alive: { time: new Date(T0 - 10_000).toISOString(), delay: 321 },
        dead: { time: new Date(T0 - 10_000).toISOString(), delay: 0 },
        virgin: null, // never measured
      }),
    );
    // Reload: mihomo returns the same nodes with EMPTY history.
    prober.observe(respWith({ alive: null, dead: null, virgin: null }));
    const filled = prober.fillLastKnown(
      view([
        { name: "alive", delay: null, history: [] },
        { name: "dead", delay: null, history: [] },
        { name: "virgin", delay: null, history: [] },
      ]),
    );
    expect(filled.all.map((n) => [n.name, n.delay])).toEqual([
      ["alive", 321], // last real measurement survives the reload
      ["dead", 0], // an honest timeout survives too
      ["virgin", null], // never measured stays «— ms»
    ]);
  });

  it("never overrides a real current measurement", () => {
    const { prober } = makeProber();
    prober.observe(respWith({ a: { time: new Date(T0 - 60_000).toISOString(), delay: 999 } }));
    const filled = prober.fillLastKnown(view([{ name: "a", delay: 42, history: [42] }]));
    expect(filled.all[0]?.delay).toBe(42); // fresh engine data wins
  });

  it("keeps memory across a transient partial snapshot (mid-reload), prunes after a sustained absence", () => {
    let nowMs = T0;
    const probe = vi.fn(async () => ({}));
    const prober = new Prober({
      probe,
      getProbeConfig: () => ({ url: "u", intervalSec: 60 }),
      pulseMs: 5000,
      now: () => nowMs,
    });
    prober.observe(respWith({ gone: { time: new Date(T0 - 1_000).toISOString(), delay: 100 } }));
    // Mid-reload mihomo briefly returns a partial set WITHOUT `gone` — the memory
    // must survive (this transient wipe is exactly what blanked the UI).
    prober.observe(respWith({ other: null }));
    let filled = prober.fillLastKnown(view([{ name: "gone", delay: null, history: [] }]));
    expect(filled.all[0]?.delay).toBe(100);
    // …but a SUSTAINED absence (rename/removal) does prune the memory.
    nowMs = T0 + 11 * 60_000; // beyond the grace period
    prober.observe(respWith({ other: null }));
    filled = prober.fillLastKnown(view([{ name: "gone", delay: null, history: [] }]));
    expect(filled.all[0]?.delay).toBeNull();
  });
});

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
    const { prober, probe } = makeProber({ intervalSec: 10 }); // after pruning, names=2 → batch = ceil(2×5/10) = 1
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

describe("Prober batching", () => {
  it("sweeps ceil(total × pulse / interval) per tick and rotates round-robin", async () => {
    // 12 nodes, pulse 5 s, N=30 s → batch = ceil(12×5/30) = 2 per tick
    const { prober, probe } = makeProber({ intervalSec: 30 });
    const names = Array.from({ length: 12 }, (_, i) => `n${i}`);
    prober.observe(resp(names));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(2);
    const first = probe.mock.calls.map((c) => c[0]);
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(4);
    const second = probe.mock.calls.slice(2).map((c) => c[0]);
    // rotation: the second tick probes DIFFERENT nodes
    expect(second.some((n) => first.includes(n))).toBe(false);
  });

  it("caps a burst at the concurrency limit", async () => {
    // 90 nodes, N=5 s → raw batch 90, capped at 10
    const { prober, probe } = makeProber({ intervalSec: 5 });
    prober.observe(resp(Array.from({ length: 90 }, (_, i) => `n${i}`)));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(10);
  });

  it("never re-attempts a failing node within the interval", async () => {
    let nowMs = T0;
    const probe = vi.fn(async () => {
      throw new Error("unreachable");
    });
    const prober = new Prober({
      probe,
      getProbeConfig: () => ({ url: "u", intervalSec: 60 }),
      pulseMs: 5000,
      now: () => nowMs,
    });
    prober.observe(resp(["dead"]));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(1);
    nowMs += 5000; // next pulse — still within N
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(1); // guarded by lastAttempt
    nowMs += 60_000; // interval elapsed
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes at least one node even when the batch formula rounds to <1", async () => {
    // 1 node, pulse 5 s, N=300 s → ceil(1×5/300) < 1 → floor to 1
    const { prober, probe } = makeProber({ intervalSec: 300 });
    prober.observe(resp(["only"]));
    await prober.tick();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
