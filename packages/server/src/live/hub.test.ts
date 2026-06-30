import type { LiveEvent } from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { LIVE_EVENT, LiveHub } from "./hub.js";

const view = {
  now: "NL-1",
  autoNow: null,
  all: [{ name: "NL-1", type: "vless", delay: 9, history: [9] }],
};

function collect(hub: LiveHub, n: number): Promise<LiveEvent[]> {
  return new Promise((resolve) => {
    const out: LiveEvent[] = [];
    hub.emitter.on(LIVE_EVENT, (e: LiveEvent) => {
      out.push(e);
      if (out.length === n) resolve(out);
    });
  });
}

describe("LiveHub", () => {
  it("emits nodeUpdate + health(true) after a successful poll", async () => {
    const hub = new LiveHub({
      fetchView: vi.fn(async () => view),
      streamTraffic: async function* () {},
      getInterval: () => 10,
    });
    const got = collect(hub, 2);
    await hub.pollOnce();
    const events = await got;
    expect(events).toContainEqual({ type: "health", mihomo: true });
    expect(events).toContainEqual({ type: "nodeUpdate", view });
    expect(hub.snapshot()).toContainEqual({ type: "nodeUpdate", view });
  });

  it("probes the active node on the poll after it becomes active", async () => {
    const probeActive = vi.fn(async () => {});
    const hub = new LiveHub({
      fetchView: vi.fn(async () => view),
      streamTraffic: async function* () {},
      getInterval: () => 10,
      probeActive,
    });
    // First poll learns the active node (no probe yet); the second probes it.
    await hub.pollOnce();
    expect(probeActive).not.toHaveBeenCalled();
    await hub.pollOnce();
    expect(probeActive).toHaveBeenCalledWith("NL-1");
  });

  it("keeps polling when an active-node probe rejects", async () => {
    const probeActive = vi.fn(async () => {
      throw new Error("unreachable");
    });
    const hub = new LiveHub({
      fetchView: vi.fn(async () => view),
      streamTraffic: async function* () {},
      getInterval: () => 10,
      probeActive,
    });
    await hub.pollOnce();
    await hub.pollOnce(); // probe rejects here — must not throw or flip health
    expect(hub.snapshot()).toContainEqual({ type: "health", mihomo: true });
  });

  it("emits and snapshots cumulative totals when fetchTotals is set", async () => {
    const hub = new LiveHub({
      fetchView: vi.fn(async () => view),
      streamTraffic: async function* () {},
      getInterval: () => 10,
      fetchTotals: vi.fn(async () => ({ up: 1200, down: 8400 })),
    });
    await hub.pollOnce();
    expect(hub.snapshot()).toContainEqual({ type: "totals", up: 1200, down: 8400 });
  });

  it("emits health(false) when the poll throws", async () => {
    const hub = new LiveHub({
      fetchView: vi.fn(async () => {
        throw new Error("down");
      }),
      streamTraffic: async function* () {},
      getInterval: () => 10,
    });
    const got = collect(hub, 1);
    await hub.pollOnce();
    expect(await got).toEqual([{ type: "health", mihomo: false }]);
  });
});
