import type { TimedTrafficSample } from "./store";

export type TrafficViewState = "loading" | "no-nodes" | "reconnecting" | "idle" | "populated";

export interface TrafficViewStateInput {
  nodesResolved: boolean;
  realNodeCount: number;
  connectionCount: number | null;
  sample: TimedTrafficSample | null;
  lastSampleAt: number | null;
  mihomo: boolean | null;
  now: number;
}

export interface ChartSummary {
  current: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export function chartSummary(values: readonly number[]): ChartSummary {
  const successful = values.filter((value) => value > 0);
  return {
    current: values.at(-1) ?? null,
    min: successful.length > 0 ? Math.min(...successful) : null,
    max: successful.length > 0 ? Math.max(...successful) : null,
    count: values.length,
  };
}

export function throughputPeak(samples: readonly TimedTrafficSample[]): number {
  return samples.reduce((peak, sample) => Math.max(peak, sample.up + sample.down), 0);
}

export function connectionCountForMetric(
  cachedCount: number | undefined,
  queryFailed: boolean,
): number | null {
  return queryFailed ? null : (cachedCount ?? null);
}

export function trafficViewState(input: TrafficViewStateInput): TrafficViewState {
  const positiveTraffic = input.sample !== null && (input.sample.up > 0 || input.sample.down > 0);
  const activeConnections = (input.connectionCount ?? 0) > 0;

  if (!input.nodesResolved && input.sample === null) return "loading";
  if (input.realNodeCount === 0 && !activeConnections && !positiveTraffic) return "no-nodes";
  if (
    input.mihomo === false ||
    (input.lastSampleAt !== null && input.now - input.lastSampleAt > 5_000)
  ) {
    return "reconnecting";
  }
  if (positiveTraffic || activeConnections) return "populated";
  return input.sample === null ? "loading" : "idle";
}
