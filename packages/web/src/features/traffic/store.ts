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

export function createTrafficDashboardStore(): TrafficDashboardStore {
  const listeners = new Set<() => void>();
  let samples: TimedTrafficSample[] = [];
  let currentSample: TimedTrafficSample | null = null;
  let lastSampleAt: number | null = null;
  let totals: { up: number; down: number } | null = null;
  let baseline: { up: number; down: number } | null = null;
  let latencyNode: string | null = null;
  let latencyCurrent: number | null = null;
  let latencySamples: number[] = [];
  let lastLatencyValue: number | undefined;

  let snapshot: TrafficDashboardSnapshot = {
    samples: [],
    currentSample: null,
    lastSampleAt: null,
    totals: null,
    sessionBytes: null,
    latency: { node: null, current: null, samples: [] },
  };

  function publish(): void {
    snapshot = {
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
        lastLatencyValue = activeNode?.history.at(-1);
      } else {
        latencyCurrent = activeNode?.delay ?? null;
        const latest = activeNode?.history.at(-1);
        if (latest !== undefined && latest !== lastLatencyValue) {
          latencySamples = [...latencySamples, latest].slice(-LATENCY_WINDOW);
          lastLatencyValue = latest;
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
