import type { NodeItem, NodeView } from "@submerge/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrafficDashboardStore } from "./store";

function node(name: string, delay: number | null, history: number[]): NodeItem {
  return { name, type: "vless", delay, history };
}

function view(now: string | null, autoNow: string | null, all: NodeItem[]): NodeView {
  return { now, autoNow, all };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("traffic dashboard store", () => {
  it("records immutable timed samples, caps the window, and notifies once per push", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-15T08:00:00.000Z");
    const store = createTrafficDashboardStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const initial = store.getSnapshot();
    store.pushTraffic({ up: 10, down: 20 });
    const first = store.getSnapshot();

    expect(first).not.toBe(initial);
    expect(first.samples).toEqual([{ up: 10, down: 20, at: Date.now() }]);
    expect(first.currentSample).toEqual({ up: 10, down: 20, at: Date.now() });
    expect(first.lastSampleAt).toBe(Date.now());
    expect(listener).toHaveBeenCalledTimes(1);

    for (let index = 1; index <= 60; index += 1) {
      store.pushTraffic({ up: index, down: index * 2 }, Date.now() + index);
    }

    expect(store.getSnapshot().samples).toHaveLength(60);
    expect(store.getSnapshot().samples[0]).toEqual({ up: 1, down: 2, at: Date.now() + 1 });
    expect(store.getSnapshot().lastSampleAt).toBe(Date.now() + 60);
    expect(listener).toHaveBeenCalledTimes(61);
  });

  it("uses cumulative totals as a non-negative browser-session delta", () => {
    const store = createTrafficDashboardStore();

    expect(store.getSnapshot().sessionBytes).toBeNull();
    store.pushTotals({ up: 100, down: 300 });
    expect(store.getSnapshot()).toMatchObject({
      totals: { up: 100, down: 300 },
      sessionBytes: 0,
    });

    store.pushTotals({ up: 180, down: 520 });
    expect(store.getSnapshot().sessionBytes).toBe(300);
  });

  it("adopts rolled-back engine counters as the new baseline", () => {
    const store = createTrafficDashboardStore();
    store.pushTotals({ up: 100, down: 100 });
    store.pushTotals({ up: 1_000, down: 2_000 });
    expect(store.getSnapshot().sessionBytes).toBe(2_800);

    store.pushTotals({ up: 150, down: 200 });
    expect(store.getSnapshot()).toMatchObject({
      totals: { up: 150, down: 200 },
      sessionBytes: 0,
    });

    store.pushTotals({ up: 175, down: 225 });
    expect(store.getSnapshot().sessionBytes).toBe(50);
  });

  it("resolves AUTO, seeds on active-node changes, and appends only new delays", () => {
    const store = createTrafficDashboardStore();
    const firstHistory = Array.from({ length: 45 }, (_, index) => index + 1);

    store.pushNodeView(
      view("AUTO", "Amsterdam", [
        node("Madrid", 33, [31, 32, 33]),
        node("Amsterdam", 45, firstHistory),
      ]),
    );
    expect(store.getSnapshot().latency).toEqual({
      node: "Amsterdam",
      current: 45,
      samples: firstHistory.slice(-40),
    });

    store.pushNodeView(view("AUTO", "Amsterdam", [node("Amsterdam", 45, firstHistory)]));
    expect(store.getSnapshot().latency.samples).toEqual(firstHistory.slice(-40));

    store.pushNodeView(view("AUTO", "Amsterdam", [node("Amsterdam", 46, [...firstHistory, 46])]));
    expect(store.getSnapshot().latency.samples).toEqual([...firstHistory, 46].slice(-40));

    store.pushNodeView(view("Madrid", "Amsterdam", [node("Madrid", 32, [30, 32])]));
    expect(store.getSnapshot().latency).toEqual({
      node: "Madrid",
      current: 32,
      samples: [30, 32],
    });
  });

  it("resets only displayed session windows and preserves last-seen latency state", () => {
    const history = [41, 42];
    const store = createTrafficDashboardStore();
    store.pushTraffic({ up: 10, down: 20 }, 100);
    store.pushTotals({ up: 1_000, down: 2_000 });
    store.pushTotals({ up: 1_100, down: 2_200 });
    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 42, history)]));

    store.reset();

    expect(store.getSnapshot()).toEqual({
      samples: [],
      currentSample: { up: 10, down: 20, at: 100 },
      lastSampleAt: 100,
      totals: { up: 1_100, down: 2_200 },
      sessionBytes: 0,
      latency: { node: "Amsterdam", current: 42, samples: [] },
    });
    expect(history).toEqual([41, 42]);

    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 42, history)]));
    expect(store.getSnapshot().latency.samples).toEqual([]);

    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 43, [...history, 43])]));
    expect(store.getSnapshot().latency.samples).toEqual([43]);
  });

  it("retains state across subscribers and stops notifying after unsubscribe", () => {
    const store = createTrafficDashboardStore();
    const firstListener = vi.fn();
    const unsubscribe = store.subscribe(firstListener);
    store.pushTraffic({ up: 1, down: 2 }, 10);
    unsubscribe();
    store.pushTraffic({ up: 3, down: 4 }, 20);

    const secondListener = vi.fn();
    store.subscribe(secondListener);

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).not.toHaveBeenCalled();
    expect(store.getSnapshot().samples).toEqual([
      { up: 1, down: 2, at: 10 },
      { up: 3, down: 4, at: 20 },
    ]);
  });
});
