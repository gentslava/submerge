import { afterEach, describe, expect, it, vi } from "vitest";
import type { MihomoConnection, MihomoLogFrame } from "../../clients/mihomo.js";
import { DomainIntelligenceObserver } from "./instance.js";
import {
  type DomainObservation,
  OBSERVATION_RECONCILIATION_WINDOW_MS,
  observationFromConnection,
  observationFromLogFrame,
} from "./observer.js";
import {
  DOMAIN_SNAPSHOT_INTERVAL_MS,
  DomainIntelligenceScheduler,
  type SnapshotObservationSink,
} from "./scheduler.js";

function connection(id: string, start: string, host = "api.service.example"): MihomoConnection {
  return {
    id,
    metadata: {
      network: "tcp",
      host,
      destinationIP: "203.0.113.10",
      destinationPort: "443",
      sourceIP: "192.0.2.10",
      process: "",
    },
    upload: 0,
    download: 0,
    start,
    chains: ["PROXY"],
  };
}

function logObservation(host: string, observedAt: number): DomainObservation {
  const frame: MihomoLogFrame = {
    level: "info",
    message: `[TCP] 127.0.0.1:51234 --> ${host}:443 match RuleSet(custom)`,
    fields: { host, network: "tcp", port: 443 },
  };
  const observation = observationFromLogFrame(frame, observedAt);
  if (!observation) throw new Error("test log observation must be valid");
  return observation;
}

function sink(recent: DomainObservation[] = []): SnapshotObservationSink {
  return {
    observeConnection: (item, snapshotAt) => observationFromConnection(item, snapshotAt),
    recentLogObservations: (since) => recent.filter((item) => item.observedAt >= since),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DomainIntelligenceScheduler", () => {
  it("runs one pulse at a time and schedules the next only after completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const first = deferred<MihomoConnection[]>();
    const fetchConnections = vi
      .fn<(signal: AbortSignal) => Promise<MihomoConnection[]>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue([]);
    const scheduler = new DomainIntelligenceScheduler({ fetchConnections, observer: sink() });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS * 3);
    expect(fetchConnections).toHaveBeenCalledTimes(1);

    first.resolve([]);
    await scheduler.pulseOnce();
    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS);
    await vi.waitFor(() => expect(fetchConnections).toHaveBeenCalledTimes(2));

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS * 3);
    expect(fetchConnections).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight pulse and restarts with a fresh generation", async () => {
    const signals: AbortSignal[] = [];
    const fetchConnections = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length > 1) return Promise.resolve([]);
      return new Promise<MihomoConnection[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const scheduler = new DomainIntelligenceScheduler({ fetchConnections, observer: sink() });

    scheduler.start();
    expect(fetchConnections).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(signals[0]?.aborted).toBe(true);
    scheduler.start();
    await vi.waitFor(() => expect(fetchConnections).toHaveBeenCalledTimes(2));
    expect(signals[1]?.aborted).toBe(false);
    scheduler.stop();
  });

  it("marks parser drift degraded and recovers after a correlated new connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const c1 = connection("c1", "2026-08-03T12:00:00.000Z");
    const c2 = connection("c2", "2026-08-03T12:00:05.000Z", "cdn.service.example");
    const recent: DomainObservation[] = [];
    const fetchConnections = vi
      .fn<(signal: AbortSignal) => Promise<MihomoConnection[]>>()
      .mockResolvedValueOnce([c1])
      .mockResolvedValueOnce([c1, c2])
      .mockResolvedValueOnce([c1, c2]);
    const scheduler = new DomainIntelligenceScheduler({
      fetchConnections,
      observer: sink(recent),
    });

    scheduler.start();
    await scheduler.pulseOnce();
    expect(scheduler.health()).toMatchObject({
      status: "accumulating",
      reason: "awaiting-correlation",
      snapshotDomainConnections: 1,
    });

    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS);
    await vi.waitFor(() => expect(fetchConnections).toHaveBeenCalledTimes(2));
    expect(scheduler.health()).toMatchObject({
      status: "accumulating",
      reason: "awaiting-correlation",
      snapshotDomainConnections: 2,
      correlatedConnections: 0,
    });

    recent.push(logObservation("cdn.service.example", Date.parse(c2.start)));
    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS);
    await vi.waitFor(() => expect(fetchConnections).toHaveBeenCalledTimes(3));
    expect(scheduler.health()).toMatchObject({
      status: "healthy",
      reason: "correlated",
      snapshotDomainConnections: 2,
      correlatedConnections: 1,
    });
    scheduler.stop();
  });

  it("marks unresolved snapshot evidence degraded only after the correlation window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const c1 = connection("c1", "2026-08-03T12:00:00.000Z");
    const c2 = connection("c2", "2026-08-03T12:00:05.000Z", "cdn.service.example");
    const fetchConnections = vi
      .fn<(signal: AbortSignal) => Promise<MihomoConnection[]>>()
      .mockResolvedValueOnce([c1])
      .mockResolvedValue([c1, c2]);
    const scheduler = new DomainIntelligenceScheduler({ fetchConnections, observer: sink() });

    scheduler.start();
    await scheduler.pulseOnce();
    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS);
    expect(scheduler.health()).toMatchObject({
      status: "accumulating",
      reason: "awaiting-correlation",
    });

    await vi.advanceTimersByTimeAsync(OBSERVATION_RECONCILIATION_WINDOW_MS);
    expect(scheduler.health()).toMatchObject({
      status: "degraded",
      reason: "parser-drift",
      correlatedConnections: 0,
    });
    scheduler.stop();
  });

  it("clears a transient snapshot error after a successful pulse with no new IDs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const fetchConnections = vi
      .fn<(signal: AbortSignal) => Promise<MihomoConnection[]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("mihomo unavailable"))
      .mockResolvedValue([]);
    const scheduler = new DomainIntelligenceScheduler({ fetchConnections, observer: sink() });

    scheduler.start();
    await scheduler.pulseOnce();
    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS);
    expect(scheduler.health()).toMatchObject({ status: "degraded", reason: "snapshot-error" });

    await vi.advanceTimersByTimeAsync(DOMAIN_SNAPSHOT_INTERVAL_MS);
    expect(scheduler.health()).toMatchObject({
      status: "accumulating",
      reason: "awaiting-domain-traffic",
    });
    scheduler.stop();
  });

  it("coalesces ambiguous snapshot fingerprints before persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const scheduled: Array<() => void> = [];
    const persistObservation = vi.fn<(observation: DomainObservation) => void>();
    const observer = new DomainIntelligenceObserver({
      persistObservation,
      schedule: (work) => scheduled.push(work),
    });
    observer.start();
    const scheduler = new DomainIntelligenceScheduler({
      fetchConnections: async () => [
        connection("c1", "2026-08-03T12:00:00.000Z"),
        connection("c2", "2026-08-03T12:00:00.000Z"),
      ],
      observer,
    });

    scheduler.start();
    await scheduler.pulseOnce();
    while (scheduled.length > 0) scheduled.shift()?.();

    expect(persistObservation).toHaveBeenCalledTimes(1);
    scheduler.stop();
    observer.stop();
  });
});
