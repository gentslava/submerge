import type { NodeItem, NodeView } from "@submerge/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrafficDashboardStore } from "./store";

function node(
  name: string,
  delay: number | null,
  history: number[],
  historyTimestamps?: string[],
): NodeItem {
  return {
    name,
    type: "vless",
    delay,
    history,
    ...(historyTimestamps ? { historyTimestamps } : {}),
  };
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
    expect(initial.monitoringStartedAt).toBe(Date.now());
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
    expect(store.getSnapshot().monitoringStartedAt).toBe(initial.monitoringStartedAt);
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
      sampleTimes: Array.from({ length: 40 }, () => null),
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
      sampleTimes: [null, null],
    });
  });

  it("advances a full latency window when equal delays have distinct timestamps", () => {
    const store = createTrafficDashboardStore();
    const history = Array.from({ length: 40 }, () => 42);
    const timestamps = Array.from({ length: 40 }, (_, index) => `2026-07-15T00:00:${index}Z`);

    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 42, history, timestamps)]));
    store.reset();
    store.pushNodeView(
      view("Amsterdam", null, [
        node("Amsterdam", 42, history, [...timestamps.slice(1), "2026-07-15T00:01:00Z"]),
      ]),
    );

    expect(store.getSnapshot().latency.samples).toEqual([42]);
    expect(store.getSnapshot().latency.sampleTimes).toEqual([Date.parse("2026-07-15T00:01:00Z")]);
  });

  it("reseeds latency when a collapsed group's active member changes", () => {
    const store = createTrafficDashboardStore();
    const first = node("Amsterdam", 42, [40, 42], ["2026-07-15T00:00:00Z", "2026-07-15T00:00:10Z"]);
    first.members = [
      { name: "Amsterdam #1", delay: 42, history: [40, 42], active: true },
      { name: "Amsterdam #2", delay: 70, history: [68, 70], active: false },
    ];
    store.pushNodeView(view("Amsterdam", null, [first]));

    const second = node(
      "Amsterdam",
      70,
      [68, 70],
      ["2026-07-15T00:00:00Z", "2026-07-15T00:00:10Z"],
    );
    second.members = [
      { name: "Amsterdam #1", delay: 42, history: [40, 42], active: false },
      { name: "Amsterdam #2", delay: 70, history: [68, 70], active: true },
    ];
    store.pushNodeView(view("Amsterdam", null, [second]));

    expect(store.getSnapshot().latency).toEqual({
      node: "Amsterdam",
      current: 70,
      samples: [68, 70],
      sampleTimes: [Date.parse("2026-07-15T00:00:00Z"), Date.parse("2026-07-15T00:00:10Z")],
    });
  });

  it("resets only displayed session windows and preserves last-seen latency state", () => {
    const history = [41, 42];
    const store = createTrafficDashboardStore();
    store.pushTraffic({ up: 10, down: 20 }, 100);
    store.pushTotals({ up: 1_000, down: 2_000 });
    store.pushTotals({ up: 1_100, down: 2_200 });
    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 42, history)]));
    const monitoringStartedAt = store.getSnapshot().monitoringStartedAt;

    store.reset();

    expect(store.getSnapshot()).toEqual({
      monitoringStartedAt,
      samples: [],
      currentSample: { up: 10, down: 20, at: 100 },
      lastSampleAt: 100,
      totals: { up: 1_100, down: 2_200 },
      sessionBytes: 0,
      latency: { node: "Amsterdam", current: 42, samples: [], sampleTimes: [] },
    });
    expect(history).toEqual([41, 42]);

    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 42, history)]));
    expect(store.getSnapshot().latency.samples).toEqual([]);

    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 42, [...history, 42])]));
    expect(store.getSnapshot().latency.samples).toEqual([42]);

    store.pushNodeView(view("Amsterdam", null, [node("Amsterdam", 43, [...history, 42, 43])]));
    expect(store.getSnapshot().latency.samples).toEqual([42, 43]);
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
