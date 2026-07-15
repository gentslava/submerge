import type { NodeView, TrafficSample } from "@submerge/shared";

const TRAFFIC_WINDOW = 60;
const LATENCY_WINDOW = 40;

export interface TimedTrafficSample extends TrafficSample {
  at: number;
}

export interface TrafficLatencySnapshot {
  node: string | null;
  current: number | null;
  samples: readonly number[];
}

export interface TrafficDashboardSnapshot {
  monitoringStartedAt: number;
  samples: readonly TimedTrafficSample[];
  currentSample: TimedTrafficSample | null;
  lastSampleAt: number | null;
  totals: { up: number; down: number } | null;
  sessionBytes: number | null;
  latency: TrafficLatencySnapshot;
}

export interface TrafficDashboardStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TrafficDashboardSnapshot;
  pushTraffic(sample: TrafficSample, at?: number): void;
  pushTotals(totals: { up: number; down: number }): void;
  pushNodeView(view: NodeView): void;
  reset(): void;
}

function sessionDelta(
  totals: { up: number; down: number } | null,
  baseline: { up: number; down: number } | null,
): number | null {
  if (!totals || !baseline) return null;
  return Math.max(0, totals.up - baseline.up + totals.down - baseline.down);
}

function appendedHistoryValues<T>(previous: readonly T[], next: readonly T[]): T[] {
  if (next.length === 0) return [];

  for (let overlap = Math.min(previous.length, next.length); overlap > 0; overlap -= 1) {
    const previousOffset = previous.length - overlap;
    const matches = Array.from(
      { length: overlap },
      (_, index) => previous[previousOffset + index] === next[index],
    ).every(Boolean);
    if (matches) return next.slice(overlap);
  }

  return previous.length === 0 ? [...next] : [next.at(-1) as T];
}

export function createTrafficDashboardStore(): TrafficDashboardStore {
  const listeners = new Set<() => void>();
  const monitoringStartedAt = Date.now();
  let samples: TimedTrafficSample[] = [];
  let currentSample: TimedTrafficSample | null = null;
  let lastSampleAt: number | null = null;
  let totals: { up: number; down: number } | null = null;
  let baseline: { up: number; down: number } | null = null;
  let latencyNode: string | null = null;
  let latencyCurrent: number | null = null;
  let latencySamples: number[] = [];
  let lastLatencyHistory: number[] = [];
  let lastLatencyHistoryTimestamps: string[] | null = null;

  let snapshot: TrafficDashboardSnapshot = {
    monitoringStartedAt,
    samples: [],
    currentSample: null,
    lastSampleAt: null,
    totals: null,
    sessionBytes: null,
    latency: { node: null, current: null, samples: [] },
  };

  function publish(): void {
    snapshot = {
      monitoringStartedAt,
      samples: [...samples],
      currentSample: currentSample ? { ...currentSample } : null,
      lastSampleAt,
      totals: totals ? { ...totals } : null,
      sessionBytes: sessionDelta(totals, baseline),
      latency: {
        node: latencyNode,
        current: latencyCurrent,
        samples: [...latencySamples],
      },
    };
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    pushTraffic(sample, at = Date.now()) {
      const timedSample = { ...sample, at };
      samples = [...samples, timedSample].slice(-TRAFFIC_WINDOW);
      currentSample = timedSample;
      lastSampleAt = at;
      publish();
    },
    pushTotals(nextTotals) {
      const rolledBack =
        totals !== null && (nextTotals.up < totals.up || nextTotals.down < totals.down);
      totals = { ...nextTotals };
      if (baseline === null || rolledBack) baseline = { ...nextTotals };
      publish();
    },
    pushNodeView(view) {
      const active = view.now === "AUTO" ? view.autoNow : view.now;
      const activeNode = active ? view.all.find((item) => item.name === active) : undefined;

      if (active !== latencyNode) {
        latencyNode = active;
        latencyCurrent = activeNode?.delay ?? null;
        latencySamples = activeNode?.history.slice(-LATENCY_WINDOW) ?? [];
        lastLatencyHistory = activeNode ? [...activeNode.history] : [];
        lastLatencyHistoryTimestamps = activeNode?.historyTimestamps
          ? [...activeNode.historyTimestamps]
          : null;
      } else {
        latencyCurrent = activeNode?.delay ?? null;
        if (activeNode) {
          const nextTimestamps = activeNode.historyTimestamps;
          const timestampIdentityAvailable =
            lastLatencyHistoryTimestamps !== null &&
            nextTimestamps !== undefined &&
            nextTimestamps.length === activeNode.history.length;
          const appendedTimestampCount = timestampIdentityAvailable
            ? appendedHistoryValues(lastLatencyHistoryTimestamps ?? [], nextTimestamps ?? []).length
            : 0;
          const appended = timestampIdentityAvailable
            ? appendedTimestampCount > 0
              ? activeNode.history.slice(-appendedTimestampCount)
              : []
            : appendedHistoryValues(lastLatencyHistory, activeNode.history);
          if (appended.length > 0) {
            latencySamples = [...latencySamples, ...appended].slice(-LATENCY_WINDOW);
          }
          lastLatencyHistory = [...activeNode.history];
          lastLatencyHistoryTimestamps = nextTimestamps ? [...nextTimestamps] : null;
        }
      }
      publish();
    },
    reset() {
      baseline = totals ? { ...totals } : null;
      samples = [];
      latencySamples = [];
      publish();
    },
  };
}
