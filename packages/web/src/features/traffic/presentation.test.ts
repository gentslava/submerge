import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateTrafficBuckets,
  TRAFFIC_PRESENTATION_MS,
  type TrafficBucketSample,
  useTrafficPresentation,
} from "./presentation";
import { createTrafficDashboardStore } from "./store";

afterEach(() => {
  vi.useRealTimers();
});

describe("traffic presentation buckets", () => {
  it("commits one averaged bucket only after the three-second boundary", () => {
    const buckets = aggregateTrafficBuckets(
      [
        { up: 0, down: 300, at: 0 },
        { up: 300, down: 600, at: 1_000 },
        { up: 600, down: 0, at: 2_000 },
        { up: 9_000, down: 9_000, at: 3_000 },
      ],
      3_000,
    );

    expect(TRAFFIC_PRESENTATION_MS).toBe(3_000);
    expect(buckets).toEqual<TrafficBucketSample[]>([
      {
        up: 300,
        down: 300,
        at: 3_000,
        startedAt: 0,
        endedAt: 3_000,
        peak: 900,
        sampleCount: 3,
      },
    ]);
  });

  it("rounds averages deterministically and keeps only the latest twenty buckets", () => {
    const samples = Array.from({ length: 22 }, (_, index) => ({
      up: index * 2 + 1,
      down: index * 4 + 1,
      at: index * TRAFFIC_PRESENTATION_MS + 1_000,
    }));

    const buckets = aggregateTrafficBuckets(samples, 22 * TRAFFIC_PRESENTATION_MS);

    expect(buckets).toHaveLength(20);
    expect(buckets[0]).toMatchObject({
      up: 5,
      down: 9,
      startedAt: 6_000,
      endedAt: 9_000,
      peak: 14,
    });
    expect(buckets.at(-1)).toMatchObject({
      up: 43,
      down: 85,
      startedAt: 63_000,
      endedAt: 66_000,
      peak: 128,
    });
  });

  it("does not expose the currently open bucket", () => {
    expect(aggregateTrafficBuckets([{ up: 10, down: 20, at: 3_500 }], 5_999)).toEqual([]);
  });

  it("commits rates, chart, connections, and session bytes on one shared boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = createTrafficDashboardStore();
    const { result, rerender } = renderHook(
      ({ connections }) => useTrafficPresentation(store, connections),
      { initialProps: { connections: 1 } },
    );

    act(() => {
      store.pushTotals({ up: 100, down: 200 });
      store.pushTotals({ up: 400, down: 800 });
      store.pushTraffic({ up: 0, down: 300 }, 0);
      store.pushTraffic({ up: 300, down: 600 }, 1_000);
      store.pushTraffic({ up: 600, down: 0 }, 2_000);
      rerender({ connections: 12 });
      vi.advanceTimersByTime(2_999);
    });

    expect(result.current.snapshot).toMatchObject({
      currentBucket: null,
      buckets: [],
      connectionCount: 1,
      sessionBytes: null,
    });

    act(() => vi.advanceTimersByTime(1));

    expect(result.current.snapshot).toMatchObject({
      currentBucket: { up: 300, down: 300, at: 3_000 },
      connectionCount: 12,
      sessionBytes: 900,
    });
    expect(result.current.snapshot.buckets).toHaveLength(1);
  });

  it("clears charts and session immediately while retaining committed rates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = createTrafficDashboardStore();
    store.pushTotals({ up: 100, down: 200 });
    store.pushTotals({ up: 400, down: 800 });
    store.pushTraffic({ up: 30, down: 60 }, 1_000);
    const { result, rerender } = renderHook(
      ({ connections }) => useTrafficPresentation(store, connections),
      { initialProps: { connections: 4 } },
    );

    act(() => vi.advanceTimersByTime(3_000));
    const committedRates = result.current.snapshot.currentBucket;

    act(() => {
      rerender({ connections: 8 });
      store.reset();
      result.current.reset();
    });

    expect(result.current.snapshot).toMatchObject({
      currentBucket: committedRates,
      buckets: [],
      connectionCount: 4,
      sessionBytes: 0,
    });

    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current.snapshot).toMatchObject({
      currentBucket: committedRates,
      buckets: [],
      connectionCount: 8,
      sessionBytes: 0,
    });

    act(() => {
      store.pushTraffic({ up: 90, down: 180 }, 6_000);
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.snapshot.currentBucket).toMatchObject({ up: 90, down: 180, at: 9_000 });
  });
});
