import { describe, expect, it } from "vitest";
import { connectionCountForMetric, type TrafficViewStateInput, trafficViewState } from "./state";

const NOW = 10_000;

function input(overrides: Partial<TrafficViewStateInput> = {}): TrafficViewStateInput {
  return {
    nodesResolved: true,
    realNodeCount: 2,
    connectionCount: 0,
    sample: { up: 0, down: 0, at: NOW },
    lastSampleAt: NOW,
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
  });

  it("marks explicit health failure or a sample older than five seconds as reconnecting", () => {
    expect(trafficViewState(input({ mihomo: false }))).toBe("reconnecting");
    expect(trafficViewState(input({ lastSampleAt: NOW - 5_001 }))).toBe("reconnecting");
    expect(trafficViewState(input({ lastSampleAt: NOW - 5_000 }))).toBe("idle");
  });

  it("treats a fresh zero sample with no connections as honest idle", () => {
    expect(trafficViewState(input())).toBe("idle");
    expect(trafficViewState(input({ connectionCount: null }))).toBe("idle");
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
