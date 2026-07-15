import { describe, expect, it } from "vitest";
import {
  chartSummary,
  connectionCountForMetric,
  type TrafficViewStateInput,
  throughputPeak,
  trafficViewState,
} from "./state";

const NOW = 10_000;

function input(overrides: Partial<TrafficViewStateInput> = {}): TrafficViewStateInput {
  return {
    nodesResolved: true,
    realNodeCount: 2,
    connectionCount: 0,
    sample: { up: 0, down: 0, at: NOW },
    lastSampleAt: NOW,
    monitoringStartedAt: NOW,
    mihomo: true,
    now: NOW,
    ...overrides,
  };
}

describe("trafficViewState", () => {
  it("loads only while neither nodes nor a live sample have resolved", () => {
    expect(
      trafficViewState(input({ nodesResolved: false, sample: null, lastSampleAt: null })),
    ).toBe("loading");
    expect(
      trafficViewState(
        input({
          nodesResolved: false,
          sample: null,
          lastSampleAt: null,
          monitoringStartedAt: NOW - 5_001,
          mihomo: false,
        }),
      ),
    ).toBe("loading");
    expect(trafficViewState(input({ nodesResolved: false }))).toBe("idle");
  });

  it("shows no-nodes before reconnecting when no useful activity exists", () => {
    expect(
      trafficViewState(
        input({
          realNodeCount: 0,
          connectionCount: 0,
          sample: null,
          lastSampleAt: null,
          mihomo: false,
        }),
      ),
    ).toBe("no-nodes");

    expect(
      trafficViewState(
        input({
          realNodeCount: 0,
          connectionCount: null,
          sample: null,
          lastSampleAt: null,
        }),
      ),
    ).toBe("loading");
  });

  it("does not mistake an unavailable node list for a successful empty result", () => {
    expect(
      trafficViewState(
        input({
          nodesResolved: true,
          realNodeCount: null,
          connectionCount: 0,
          sample: null,
          lastSampleAt: null,
          mihomo: false,
        }),
      ),
    ).toBe("reconnecting");
  });

  it("marks explicit health failure or a sample older than five seconds as reconnecting", () => {
    expect(trafficViewState(input({ mihomo: false }))).toBe("reconnecting");
    expect(trafficViewState(input({ lastSampleAt: NOW - 5_001 }))).toBe("reconnecting");
    expect(trafficViewState(input({ lastSampleAt: NOW - 5_000 }))).toBe("idle");
  });

  it("marks a stream without its first sample as stale after five seconds", () => {
    expect(
      trafficViewState(
        input({
          sample: null,
          lastSampleAt: null,
          monitoringStartedAt: NOW - 5_000,
        }),
      ),
    ).toBe("loading");
    expect(
      trafficViewState(
        input({
          sample: null,
          lastSampleAt: null,
          monitoringStartedAt: NOW - 5_001,
        }),
      ),
    ).toBe("reconnecting");
  });

  it("treats a fresh zero sample with no connections as honest idle", () => {
    expect(trafficViewState(input())).toBe("idle");
    expect(trafficViewState(input({ connectionCount: null }))).toBe("populated");
  });

  it("treats positive traffic or an active connection as populated", () => {
    expect(
      trafficViewState(input({ sample: { up: 1, down: 0, at: NOW }, connectionCount: null })),
    ).toBe("populated");
    expect(trafficViewState(input({ connectionCount: 1 }))).toBe("populated");
    expect(
      trafficViewState(
        input({ realNodeCount: 0, sample: { up: 0, down: 10, at: NOW }, connectionCount: 0 }),
      ),
    ).toBe("populated");
  });

  it("keeps loading when nodes resolved but no live or connection data exists", () => {
    expect(
      trafficViewState(input({ sample: null, lastSampleAt: null, connectionCount: null })),
    ).toBe("loading");
  });
});

describe("connectionCountForMetric", () => {
  it("does not render a cached count after a failed refetch", () => {
    expect(connectionCountForMetric(12, true)).toBeNull();
    expect(connectionCountForMetric(12, false)).toBe(12);
    expect(connectionCountForMetric(undefined, false)).toBeNull();
  });
});

describe("traffic chart models", () => {
  it("summarizes successful latency values without treating timeouts as zero latency", () => {
    expect(chartSummary([])).toEqual({ current: null, min: null, max: null, count: 0 });
    expect(chartSummary([0, 0])).toEqual({ current: 0, min: null, max: null, count: 2 });
    expect(chartSummary([48, 0, 72, 51])).toEqual({
      current: 51,
      min: 48,
      max: 72,
      count: 4,
    });
    expect(chartSummary([48, 72, 0])).toEqual({ current: 0, min: 48, max: 72, count: 3 });
  });

  it("finds the largest combined throughput sample", () => {
    expect(throughputPeak([])).toBe(0);
    expect(
      throughputPeak([
        { up: 0, down: 0, at: 1 },
        { up: 20, down: 30, at: 2 },
        { up: 45, down: 4, at: 3 },
      ]),
    ).toBe(50);
  });
});
