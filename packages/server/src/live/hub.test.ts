import type { LiveEvent, NodeView } from "@submerge/shared";
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

  it("reports a poll error via onError once per outage, again after recovery", async () => {
    const onError = vi.fn();
    let down = true;
    const hub = new LiveHub({
      fetchView: vi.fn(async () => {
        if (down) throw new Error("down");
        return view;
      }),
      streamTraffic: async function* () {},
      getInterval: () => 10,
      onError,
    });
    await hub.pollOnce(); // outage starts — reported
    await hub.pollOnce(); // still down — silent
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("poll", expect.any(Error));
    down = false;
    await hub.pollOnce(); // recovered
    down = true;
    await hub.pollOnce(); // new outage — reported again
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("backs off traffic-stream retries exponentially and reports the first failure", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      let attempts = 0;
      const hub = new LiveHub({
        fetchView: async () => view,
        // biome-ignore lint/correctness/useYield: the stream must fail before yielding
        streamTraffic: async function* () {
          attempts += 1;
          throw new Error("closed");
        },
        getInterval: () => 60_000,
        onError,
      });
      hub.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1); // immediate first attempt
      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(2); // retry after 1 s
      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(2); // next retry needs 2 s — not yet
      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(3);
      expect(onError.mock.calls.filter(([scope]) => scope === "traffic")).toHaveLength(1);
      hub.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls afterView with the fetched view each poll", async () => {
    const view: NodeView = { now: "AUTO", autoNow: "A", all: [] };
    const seen: NodeView[] = [];
    const hub = new LiveHub({
      fetchView: async () => view,
      streamTraffic: async function* () {},
      getInterval: () => 10_000,
      afterView: async (v) => {
        seen.push(v);
      },
    });
    await hub.pollOnce();
    expect(seen).toEqual([view]);
  });

  it("a throwing afterView does not fail the poll (health stays true)", async () => {
    const events: LiveEvent[] = [];
    const hub = new LiveHub({
      fetchView: async () => ({ now: null, autoNow: null, all: [] }),
      streamTraffic: async function* () {},
      getInterval: () => 10_000,
      afterView: async () => {
        throw new Error("boom");
      },
    });
    hub.emitter.on(LIVE_EVENT, (e: LiveEvent) => events.push(e));
    await hub.pollOnce();
    expect(events).toContainEqual({ type: "health", mihomo: true });
  });
});
