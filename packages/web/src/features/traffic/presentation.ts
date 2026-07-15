import { useCallback, useEffect, useRef, useState } from "react";
import type { TimedTrafficSample, TrafficDashboardSnapshot, TrafficDashboardStore } from "./store";

export const TRAFFIC_PRESENTATION_MS = 3_000;
export const TRAFFIC_BUCKET_CAP = 20;

export interface TrafficBucketSample extends TimedTrafficSample {
  startedAt: number;
  endedAt: number;
  peak: number;
  sampleCount: number;
}

export interface TrafficPresentationSnapshot {
  buckets: readonly TrafficBucketSample[];
  currentBucket: TrafficBucketSample | null;
  connectionCount: number | null;
  sessionBytes: number | null;
}

export interface TrafficPresentationController {
  snapshot: TrafficPresentationSnapshot;
  reset(): void;
}

export function aggregateTrafficBuckets(
  samples: readonly TimedTrafficSample[],
  boundaryAt: number,
): TrafficBucketSample[] {
  const groups = new Map<number, TimedTrafficSample[]>();

  for (const sample of samples) {
    const startedAt = Math.floor(sample.at / TRAFFIC_PRESENTATION_MS) * TRAFFIC_PRESENTATION_MS;
    if (startedAt + TRAFFIC_PRESENTATION_MS > boundaryAt) continue;
    const group = groups.get(startedAt);
    if (group) group.push(sample);
    else groups.set(startedAt, [sample]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startedAt, group]) => {
      const totals = group.reduce(
        (result, sample) => ({
          up: result.up + sample.up,
          down: result.down + sample.down,
          peak: Math.max(result.peak, sample.up + sample.down),
        }),
        { up: 0, down: 0, peak: 0 },
      );
      const endedAt = startedAt + TRAFFIC_PRESENTATION_MS;
      return {
        up: Math.round(totals.up / group.length),
        down: Math.round(totals.down / group.length),
        at: endedAt,
        startedAt,
        endedAt,
        peak: totals.peak,
        sampleCount: group.length,
      };
    })
    .slice(-TRAFFIC_BUCKET_CAP);
}

function presentationBoundary(at: number): number {
  return Math.floor(at / TRAFFIC_PRESENTATION_MS) * TRAFFIC_PRESENTATION_MS;
}

function createPresentationSnapshot(
  raw: TrafficDashboardSnapshot,
  connectionCount: number | null,
  boundaryAt: number,
): TrafficPresentationSnapshot {
  const buckets = aggregateTrafficBuckets(raw.samples, boundaryAt);
  return {
    buckets,
    currentBucket: buckets.at(-1) ?? null,
    connectionCount,
    sessionBytes: raw.sessionBytes,
  };
}

export function useTrafficPresentation(
  store: TrafficDashboardStore,
  connectionCount: number | null,
): TrafficPresentationController {
  const latestConnectionCount = useRef(connectionCount);
  latestConnectionCount.current = connectionCount;
  const [snapshot, setSnapshot] = useState(() =>
    createPresentationSnapshot(
      store.getSnapshot(),
      connectionCount,
      presentationBoundary(Date.now()),
    ),
  );

  useEffect(() => {
    let interval: number | undefined;
    const commit = () => {
      setSnapshot((current) => {
        const next = createPresentationSnapshot(
          store.getSnapshot(),
          latestConnectionCount.current,
          presentationBoundary(Date.now()),
        );
        return next.currentBucket === null
          ? { ...next, currentBucket: current.currentBucket }
          : next;
      });
    };
    const remainder = Date.now() % TRAFFIC_PRESENTATION_MS;
    const delay = remainder === 0 ? TRAFFIC_PRESENTATION_MS : TRAFFIC_PRESENTATION_MS - remainder;
    const timeout = window.setTimeout(() => {
      commit();
      interval = window.setInterval(commit, TRAFFIC_PRESENTATION_MS);
    }, delay);

    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [store]);

  const reset = useCallback(() => {
    const raw = store.getSnapshot();
    setSnapshot((current) => ({
      buckets: [],
      currentBucket: current.currentBucket,
      connectionCount: current.connectionCount,
      sessionBytes: raw.sessionBytes,
    }));
  }, [store]);

  return { snapshot, reset };
}
