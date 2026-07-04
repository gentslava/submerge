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

  it("does not report a traffic error on graceful stop()", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const hub = new LiveHub({
        fetchView: async () => view,
        streamTraffic: async function* (signal) {
          yield { up: 1, down: 1 };
          await new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
        getInterval: () => 60_000,
        onError,
      });
      hub.start();
      await vi.advanceTimersByTimeAsync(0);
      hub.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(onError.mock.calls.filter(([scope]) => scope === "traffic")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps escalating backoff when a flapping stream yields a sample before each drop", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      let attempts = 0;
      const hub = new LiveHub({
        fetchView: async () => view,
        // Flapping stream: one sample, then an immediate error — short-lived, so
        // the backoff must still escalate and onError must fire only once.
        streamTraffic: async function* () {
          attempts += 1;
          yield { up: 1, down: 1 };
          throw new Error("dropped");
        },
        getInterval: () => 60_000,
        onError,
      });
      hub.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1000); // retry #1 after 1 s
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1000); // needs 2 s now — not yet
      expect(attempts).toBe(2);
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

  it("does not call onReconnect on the initial connect", async () => {
    const onReconnect = vi.fn();
    const hub = new LiveHub({
      fetchView: vi.fn(async () => view),
      streamTraffic: async function* () {},
      getInterval: () => 10,
      onReconnect,
    });
    await hub.pollOnce(); // first-ever success — boot-apply already covers this
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("calls onReconnect when mihomo recovers after being unreachable", async () => {
    const onReconnect = vi.fn();
    let down = false;
    const hub = new LiveHub({
      fetchView: vi.fn(async () => {
        if (down) throw new Error("down");
        return view;
      }),
      streamTraffic: async function* () {},
      getInterval: () => 10,
      onReconnect,
    });
    await hub.pollOnce(); // initial connect — no reconnect
    down = true;
    await hub.pollOnce(); // outage
    down = false;
    await hub.pollOnce(); // genuine reconnect
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("a synchronously-throwing onReconnect does not corrupt health or livelock", async () => {
    const events: LiveEvent[] = [];
    let down = false;
    const onReconnect = vi.fn(() => {
      throw new Error("reconnect handler boom");
    });
    const hub = new LiveHub({
      fetchView: vi.fn(async () => {
        if (down) throw new Error("down");
        return view;
      }),
      streamTraffic: async function* () {},
      getInterval: () => 10,
      onReconnect,
    });
    hub.emitter.on(LIVE_EVENT, (e: LiveEvent) => events.push(e));
    await hub.pollOnce(); // initial connect — no reconnect
    down = true;
    await hub.pollOnce(); // outage
    down = false;
    await hub.pollOnce(); // genuine reconnect — onReconnect throws synchronously
    // Give any swallowed rejection's microtask a turn before asserting.
    await Promise.resolve();
    await Promise.resolve();

    const health = events
      .filter((e): e is Extract<LiveEvent, { type: "health" }> => e.type === "health")
      .map((e) => e.mihomo);
    // Exactly one transition per poll: true (initial), false (outage), true
    // (reconnect). A spurious trailing `false` would mean the throwing
    // handler escaped setHealth and corrupted lastHealth back to unhealthy.
    expect(health).toEqual([true, false, true]);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // A later successful poll must not re-fire onReconnect — corruption would
    // make wasHealthy read false again and re-trigger it every tick (livelock).
    await hub.pollOnce();
    await hub.pollOnce();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
