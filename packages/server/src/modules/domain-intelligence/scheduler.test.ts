import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MihomoConnection, MihomoLogFrame } from "../../clients/mihomo.js";
import { createDb, type Db } from "../../db/client.js";
import {
  domainCandidates,
  domainDailyStats,
  domainDecisions,
  domainObservations,
  domainValidationAttempts,
  domainValidationRuns,
} from "../../db/schema.js";
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
  type DomainValidationExecution,
  DomainValidationScheduler,
  DomainValidationSchedulerError,
  type SnapshotObservationSink,
} from "./scheduler.js";

const migrationsFolder = new URL("../../../drizzle", import.meta.url).pathname;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function migratedDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  return db;
}

function insertDueCandidate(db: Db, fqdn: string, now: number): void {
  db.insert(domainCandidates)
    .values({
      fqdn,
      registrableSite: "service.example",
      selectedScope: "exact",
      proposedRule: fqdn,
      status: "queued",
      firstSeenAt: now,
      lastSeenAt: now,
      nextValidationAt: now,
      lastValidationAt: null,
      failureStreak: 0,
      leaseId: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .run();
}

function validationExecution(fqdn: string, now: number): DomainValidationExecution {
  return {
    attempts: [
      {
        attemptedAt: now,
        result: {
          direction: "direct",
          category: "connect_timeout",
          transportSuccess: false,
          httpStatus: null,
          resolvedAddress: "1.1.1.1",
          availableAddressCount: 1,
          connectDurationMs: 1_000,
          tlsDurationMs: null,
          totalDurationMs: 1_000,
          redirectCount: 0,
          finalOrigin: `https://${fqdn}`,
        },
      },
      {
        attemptedAt: now,
        result: {
          direction: "proxy",
          category: "http_response",
          transportSuccess: true,
          httpStatus: 403,
          resolvedAddress: "1.1.1.1",
          availableAddressCount: 1,
          connectDurationMs: 20,
          tlsDurationMs: 30,
          totalDurationMs: 60,
          redirectCount: 0,
          finalOrigin: `https://${fqdn}`,
        },
      },
    ],
    decision: {
      evaluatedAt: now,
      value: {
        status: "pending",
        confidence: "low",
        reasons: ["insufficient-direct-failures"],
        windowStart: now - 24 * HOUR_MS,
        evidence: {
          directQualifyingFailures: 1,
          directSpacedFailures: 1,
          directAddressDiversityRequired: false,
          directAddressDiversitySatisfied: true,
          proxyHttpSuccesses: 1,
          proxyTransportFailures: 0,
          proxyUncertainFailures: 0,
        },
      },
      selectedScope: "exact",
      proposedRule: fqdn,
    },
  };
}

function sequentialIds(): (kind: string) => string {
  let next = 0;
  return (kind) => `${kind}_${++next}`;
}

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
      inboundName: "",
      inboundUser: "",
      inboundPort: "",
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

describe("DomainValidationScheduler", () => {
  it("persists a coverage-blocked decision without fabricating probe attempts", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "api.service.example", now);
    const execute = vi.fn(
      async (): Promise<DomainValidationExecution> => ({
        attempts: [],
        decision: {
          evaluatedAt: now,
          value: {
            status: "blocked",
            confidence: "none",
            reasons: ["already-covered"],
            windowStart: now - 24 * HOUR_MS,
            evidence: {
              directQualifyingFailures: 0,
              directSpacedFailures: 0,
              directAddressDiversityRequired: false,
              directAddressDiversitySatisfied: true,
              proxyHttpSuccesses: 0,
              proxyTransportFailures: 0,
              proxyUncertainFailures: 0,
            },
          },
          selectedScope: "exact",
          proposedRule: "api.service.example",
        },
      }),
    );
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      jitterMs: () => 0,
      idFactory: sequentialIds(),
    });

    await scheduler.runOnce();

    expect(db.select().from(domainValidationAttempts).all()).toEqual([]);
    expect(db.select().from(domainDecisions).get()).toMatchObject({
      status: "blocked",
      reasons: ["already-covered"],
    });
    expect(db.select().from(domainCandidates).get()).toMatchObject({ status: "blocked" });
  });

  it("caps overdue restart work, joins overlapping runs, and respects concurrency", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    for (const fqdn of [
      "e.service.example",
      "c.service.example",
      "a.service.example",
      "d.service.example",
      "b.service.example",
    ]) {
      insertDueCandidate(db, fqdn, now);
    }

    const calls: string[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const execute = vi.fn(async (candidate: { fqdn: string }) => {
      calls.push(candidate.fqdn);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return validationExecution(candidate.fqdn, now);
    });
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maximumCandidatesPerRun: 3,
      maxConcurrency: 2,
      jitterMs: () => 30_000,
      idFactory: sequentialIds(),
    });

    const first = scheduler.runOnce();
    const overlapping = scheduler.runOnce();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    for (const release of releases.splice(0)) release();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    for (const release of releases.splice(0)) release();
    await Promise.all([first, overlapping]);

    expect(calls).toEqual(["a.service.example", "b.service.example", "c.service.example"]);
    expect(maximumActive).toBe(2);
    expect(db.select().from(domainValidationRuns).all()).toHaveLength(3);
    expect(db.select().from(domainValidationAttempts).all()).toHaveLength(6);
    expect(db.select().from(domainDecisions).all()).toHaveLength(3);
    expect(
      db
        .select()
        .from(domainCandidates)
        .all()
        .filter((candidate) => candidate.status === "pending"),
    ).toHaveLength(3);
    expect(
      db
        .select()
        .from(domainCandidates)
        .all()
        .filter((candidate) => candidate.nextValidationAt === now + 2 * HOUR_MS + 30_000),
    ).toHaveLength(3);
  });

  it("persists exponential backoff and opens a circuit across scheduler restarts", async () => {
    const db = migratedDb();
    const initialNow = Date.parse("2026-08-03T12:00:00.000Z");
    let now = initialNow;
    for (const fqdn of [
      "d.service.example",
      "a.service.example",
      "c.service.example",
      "b.service.example",
    ]) {
      insertDueCandidate(db, fqdn, now);
    }
    const calls: string[] = [];
    const execute = vi.fn(async (candidate: { fqdn: string }) => {
      calls.push(candidate.fqdn);
      throw new DomainValidationSchedulerError("infrastructure-failure");
    });
    const ids = sequentialIds();
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maxConcurrency: 1,
      circuitFailureThreshold: 3,
      circuitOpenMs: 15 * 60_000,
      jitterMs: () => 0,
      idFactory: ids,
    });

    await scheduler.runOnce();
    expect(calls).toEqual(["a.service.example", "b.service.example", "c.service.example"]);
    expect(db.select().from(domainValidationRuns).all()).toMatchObject([
      { status: "failed", errorCategory: "infrastructure-failure" },
      { status: "failed", errorCategory: "infrastructure-failure" },
      { status: "failed", errorCategory: "infrastructure-failure" },
    ]);
    expect(
      db
        .select()
        .from(domainCandidates)
        .all()
        .filter((candidate) => candidate.failureStreak === 1),
    ).toHaveLength(3);

    now = initialNow + 14 * 60_000;
    const restarted = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maxConcurrency: 1,
      circuitFailureThreshold: 3,
      circuitOpenMs: 15 * 60_000,
      jitterMs: () => 0,
      idFactory: ids,
    });
    await restarted.runOnce();
    expect(calls).toHaveLength(3);

    now = initialNow + 15 * 60_000;
    await restarted.runOnce();
    expect(calls.at(-1)).toBe("d.service.example");

    const failed = db
      .select()
      .from(domainCandidates)
      .all()
      .find((candidate) => candidate.fqdn === "d.service.example");
    expect(failed).toMatchObject({
      failureStreak: 1,
      nextValidationAt: now + 2 * HOUR_MS,
    });

    now = failed?.nextValidationAt ?? 0;
    const retry = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maxConcurrency: 1,
      circuitFailureThreshold: 10,
      jitterMs: () => 0,
      idFactory: ids,
    });
    await retry.runOnce();
    expect(
      db
        .select()
        .from(domainCandidates)
        .all()
        .find((candidate) => candidate.fqdn === "d.service.example"),
    ).toMatchObject({
      failureStreak: 2,
      nextValidationAt: now + 4 * HOUR_MS,
    });
  });

  it("reports the safe executor failure category without exposing the source error", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "api.service.example", now);
    const onError = vi.fn();
    const sourceError = Object.assign(new DomainValidationSchedulerError("proxy-probe-failure"), {
      cause: new Error("https://private.example/path?token=private-token"),
      fqdn: "private.example",
      secret: "private-secret",
    });
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute: async () => {
        throw sourceError;
      },
      now: () => now,
      maxConcurrency: 1,
      jitterMs: () => 0,
      onError,
      idFactory: sequentialIds(),
    });

    await scheduler.runOnce();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DomainValidationSchedulerError",
        message: "domain validation operation failed",
        category: "proxy-probe-failure",
      }),
    );
    const reported = onError.mock.calls[0]?.[0];
    expect(reported).not.toBe(sourceError);
    const serialized = JSON.stringify({
      ...(reported instanceof Error
        ? { name: reported.name, message: reported.message, stack: reported.stack }
        : {}),
      error: reported,
    });
    for (const privateValue of ["private.example", "private-token", "private-secret"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(db.select().from(domainValidationRuns).get()).toMatchObject({
      status: "failed",
      errorCategory: "proxy-probe-failure",
    });
  });

  it("suppresses repeated failures until a successful validation resets reporting", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    for (const fqdn of [
      "a.service.example",
      "b.service.example",
      "c.service.example",
      "d.service.example",
    ]) {
      insertDueCandidate(db, fqdn, now);
    }
    let call = 0;
    const onError = vi.fn();
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute: async (candidate) => {
        call += 1;
        if (call <= 2) throw new DomainValidationSchedulerError("proxy-probe-failure");
        if (call === 4) throw new DomainValidationSchedulerError("direct-probe-failure");
        return validationExecution(candidate.fqdn, now);
      },
      now: () => now,
      maxConcurrency: 1,
      circuitFailureThreshold: 100,
      jitterMs: () => 0,
      onError,
      idFactory: sequentialIds(),
    });

    await scheduler.runOnce();

    expect(onError).toHaveBeenCalledTimes(2);
    expect(
      onError.mock.calls.map(([error]) => (error as DomainValidationSchedulerError).category),
    ).toEqual(["proxy-probe-failure", "direct-probe-failure"]);
  });

  it("aborts bounded work on shutdown and starts no additional due candidate", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    for (const fqdn of ["a.service.example", "b.service.example", "c.service.example"]) {
      insertDueCandidate(db, fqdn, now);
    }
    const signals: AbortSignal[] = [];
    const onError = vi.fn();
    const execute = vi.fn((_candidate: { fqdn: string }, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<DomainValidationExecution>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maxConcurrency: 2,
      onError,
      idFactory: sequentialIds(),
    });

    scheduler.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await scheduler.stop();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(db.select().from(domainValidationRuns).all()).toMatchObject([
      { status: "cancelled", errorCategory: "shutdown" },
      { status: "cancelled", errorCategory: "shutdown" },
    ]);
    expect(
      db
        .select()
        .from(domainCandidates)
        .all()
        .filter((candidate) => candidate.status === "queued"),
    ).toHaveLength(1);
  });

  it("does not finish stop until an aborted executor completes delayed cleanup", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "api.service.example", now);
    const cleanup = deferred<void>();
    const execute = vi.fn(
      (_candidate: { fqdn: string }, signal: AbortSignal) =>
        new Promise<DomainValidationExecution>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              void cleanup.promise.then(() => reject(signal.reason));
            },
            { once: true },
          );
        }),
    );
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      cleanupTimeoutMs: 1_000,
      idFactory: sequentialIds(),
    });
    scheduler.start();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await vi.waitFor(() =>
      expect(db.select().from(domainValidationRuns).get()).toMatchObject({
        status: "cancelled",
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);

    cleanup.resolve();
    await expect(stopping).resolves.toBeUndefined();
    expect(db.select().from(domainValidationRuns).get()).toMatchObject({
      status: "cancelled",
      errorCategory: "shutdown",
    });
  });

  it("keeps sibling workers owned until every worker settles", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "a.service.example", now);
    insertDueCandidate(db, "b.service.example", now);
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const execute = vi.fn((candidate: { fqdn: string }, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<DomainValidationExecution>((resolve, reject) => {
        release = () => resolve(validationExecution(candidate.fqdn, now));
        currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true });
      });
    });
    let lease = 0;
    let evidence = 0;
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maxConcurrency: 2,
      idFactory: (kind) => {
        if (kind === "lease") return `lease_${++lease}`;
        if (kind === "run") return "duplicate_run";
        return `${kind}_${++evidence}`;
      },
    });

    let settled = false;
    let runError: unknown;
    const running = scheduler.runOnce().then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        runError = error;
      },
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const settledBeforeStop = settled;

    const stopping = scheduler.stop();
    release?.();
    await Promise.all([running, stopping]);
    await vi.waitFor(() =>
      expect(db.select().from(domainValidationRuns).get()?.status).not.toBe("running"),
    );

    expect(settledBeforeStop).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(runError).toBeInstanceOf(Error);
    expect(db.select().from(domainValidationRuns).all()).toMatchObject([
      { status: "cancelled", errorCategory: "shutdown" },
    ]);
    expect(db.select().from(domainValidationAttempts).all()).toEqual([]);
    expect(db.select().from(domainDecisions).all()).toEqual([]);
  });

  it("makes a started runOnce owned by stop and waits until its cancellation is persisted", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const execute = vi.fn((candidate: { fqdn: string }, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<DomainValidationExecution>((resolve, reject) => {
        release = () => resolve(validationExecution(candidate.fqdn, now));
        currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true });
      });
    });
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maxConcurrency: 1,
      idFactory: sequentialIds(),
    });
    scheduler.start();
    await scheduler.runOnce();
    insertDueCandidate(db, "api.service.example", now);
    const running = scheduler.runOnce();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    const stopping = scheduler.stop();
    release?.();
    await Promise.all([running, stopping]);

    expect(signal?.aborted).toBe(true);
    expect(db.select().from(domainValidationRuns).get()).toMatchObject({
      status: "cancelled",
      errorCategory: "shutdown",
    });
  });

  it("owns runOnce across start followed by stop", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "api.service.example", now);
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const execute = vi.fn((candidate: { fqdn: string }, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return new Promise<DomainValidationExecution>((resolve, reject) => {
        release = () => resolve(validationExecution(candidate.fqdn, now));
        currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true });
      });
    });
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      maxConcurrency: 1,
      idFactory: sequentialIds(),
    });

    const running = scheduler.runOnce();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    scheduler.start();
    const stopping = scheduler.stop();
    release?.();
    await Promise.all([running, stopping]);

    expect(signal?.aborted).toBe(true);
    expect(db.select().from(domainValidationRuns).get()).toMatchObject({ status: "cancelled" });
  });

  it("times out an uncooperative executor and persists only a safe failure category", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const db = migratedDb();
    insertDueCandidate(db, "api.service.example", Date.now());
    let signal: AbortSignal | undefined;
    const onError = vi.fn();
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute: (_candidate, currentSignal) => {
        signal = currentSignal;
        return new Promise<DomainValidationExecution>(() => undefined);
      },
      now: Date.now,
      workTimeoutMs: 100,
      cleanupTimeoutMs: 50,
      onError,
      idFactory: sequentialIds(),
    });

    const running = scheduler.runOnce();
    const result = expect(running).rejects.toThrow(/cleanup/i);
    await vi.advanceTimersByTimeAsync(150);
    await result;

    expect(signal?.aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(db.select().from(domainValidationRuns).get()).toMatchObject({
      status: "failed",
      errorCategory: "infrastructure-failure",
    });
    expect(db.select().from(domainValidationAttempts).all()).toEqual([]);
    expect(db.select().from(domainDecisions).all()).toEqual([]);
  });

  it("latches scheduled validation closed after an executor misses cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const db = migratedDb();
    insertDueCandidate(db, "a.service.example", Date.now());
    insertDueCandidate(db, "b.service.example", Date.now());
    const execute = vi.fn(() => new Promise<DomainValidationExecution>(() => undefined));
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: Date.now,
      pulseMs: DAY_MS,
      workTimeoutMs: 10,
      cleanupTimeoutMs: 5,
      maxConcurrency: 1,
      circuitFailureThreshold: 100,
      idFactory: sequentialIds(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(15);
    expect(execute).toHaveBeenCalledTimes(1);

    scheduler.wake();
    scheduler.start();
    const staleAt = Date.now() - 15 * DAY_MS;
    insertDueCandidate(db, "stale.service.example", staleAt);
    db.insert(domainObservations)
      .values({
        fingerprint: "a".repeat(64),
        fqdn: "stale.service.example",
        observedAt: staleAt,
        lastSeenAt: staleAt,
        transport: "tcp",
        source: "mihomo-log",
        count: 1,
      })
      .run();
    db.insert(domainDailyStats)
      .values({
        day: new Date(staleAt).toISOString().slice(0, 10),
        fqdn: "stale.service.example",
        connectionCount: 1,
        firstSeenAt: staleAt,
        lastSeenAt: staleAt,
      })
      .run();

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      db
        .select()
        .from(domainCandidates)
        .where(eq(domainCandidates.fqdn, "stale.service.example"))
        .all(),
    ).toEqual([]);
    expect(db.select().from(domainObservations).all()).toEqual([]);
    expect(db.select().from(domainDailyStats).all()).toEqual([]);
    await expect(scheduler.runOnce()).rejects.toThrow(/cleanup/i);

    const stopping = expect(scheduler.stop()).rejects.toThrow(/cleanup/i);
    await vi.advanceTimersByTimeAsync(5);
    await stopping;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a validation result resolved by the timeout abort handler", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
    const db = migratedDb();
    insertDueCandidate(db, "api.service.example", Date.now());
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute: (candidate, signal) =>
        new Promise<DomainValidationExecution>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(validationExecution(candidate.fqdn, Date.now())),
            { once: true },
          );
        }),
      now: Date.now,
      workTimeoutMs: 100,
      idFactory: sequentialIds(),
    });

    const running = scheduler.runOnce();
    await vi.advanceTimersByTimeAsync(100);
    await running;

    expect(db.select().from(domainValidationRuns).get()).toMatchObject({
      status: "failed",
      errorCategory: "infrastructure-failure",
    });
    expect(db.select().from(domainValidationAttempts).all()).toEqual([]);
    expect(db.select().from(domainDecisions).all()).toEqual([]);
  });

  it("stays inert while disabled and wakes immediately after an eligible enqueue", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "disabled.service.example", now);
    let enabled = false;
    const execute = vi.fn(async (candidate: { fqdn: string }) =>
      validationExecution(candidate.fqdn, now),
    );
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => enabled,
      execute,
      now: () => now,
      idFactory: sequentialIds(),
    });

    await scheduler.runOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(db.select().from(domainValidationRuns).all()).toEqual([]);

    scheduler.start();
    await scheduler.runOnce();
    enabled = true;
    scheduler.wake();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await scheduler.stop();
  });

  it("rechecks the enable gate before leasing the next candidate", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "a.service.example", now);
    insertDueCandidate(db, "b.service.example", now);
    let enabled = true;
    const first = deferred<void>();
    const execute = vi.fn(async (candidate: { fqdn: string }) => {
      if (candidate.fqdn === "a.service.example") await first.promise;
      return validationExecution(candidate.fqdn, now);
    });
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => enabled,
      execute,
      now: () => now,
      maxConcurrency: 1,
      jitterMs: () => 0,
      idFactory: sequentialIds(),
    });

    const running = scheduler.runOnce();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    enabled = false;
    first.resolve();
    await running;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.select().from(domainValidationRuns).all()).toHaveLength(1);
    expect(
      db
        .select()
        .from(domainCandidates)
        .all()
        .find((candidate) => candidate.fqdn === "b.service.example"),
    ).toMatchObject({ status: "queued", leaseId: null });
  });

  it("runs one trailing wake when a candidate is enqueued during an active pulse", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-03T12:00:00.000Z");
    insertDueCandidate(db, "first.service.example", now);
    const first = deferred<void>();
    const calls: string[] = [];
    const execute = vi.fn(async (candidate: { fqdn: string }) => {
      calls.push(candidate.fqdn);
      if (calls.length === 1) await first.promise;
      return validationExecution(candidate.fqdn, now);
    });
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      pulseMs: 60_000,
      maxConcurrency: 1,
      idFactory: sequentialIds(),
    });

    scheduler.start();
    await vi.waitFor(() => expect(calls).toEqual(["first.service.example"]));
    insertDueCandidate(db, "second.service.example", now);
    scheduler.wake();
    scheduler.wake();
    first.resolve();
    await vi.waitFor(() =>
      expect(calls).toEqual(["first.service.example", "second.service.example"]),
    );
    await scheduler.stop();
  });

  it("enforces the candidate cap across scheduler instances in one rolling minute", async () => {
    const db = migratedDb();
    let now = Date.parse("2026-08-03T12:00:00.000Z");
    for (let index = 0; index < 40; index += 1) {
      insertDueCandidate(db, `c${String(index).padStart(2, "0")}.service.example`, now);
    }
    const execute = vi.fn(async (candidate: { fqdn: string }) =>
      validationExecution(candidate.fqdn, now),
    );
    const ids = sequentialIds();
    const first = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      jitterMs: () => 0,
      idFactory: ids,
    });
    const restarted = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      now: () => now,
      jitterMs: () => 0,
      idFactory: ids,
    });

    await first.runOnce();
    await restarted.runOnce();
    expect(execute).toHaveBeenCalledTimes(20);

    now += 60_000;
    await restarted.runOnce();
    expect(execute).toHaveBeenCalledTimes(40);
  });

  it("reads validated run and concurrency limits for every scheduler run", async () => {
    const db = migratedDb();
    let now = Date.parse("2026-08-03T12:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      insertDueCandidate(db, `dynamic${index}.service.example`, now);
    }
    let limits = { maximumCandidatesPerRun: 2, maxConcurrency: 1 };
    const execute = vi.fn(async (candidate: { fqdn: string }) =>
      validationExecution(candidate.fqdn, now),
    );
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => true,
      execute,
      getLimits: () => limits,
      now: () => now,
      jitterMs: () => 0,
      idFactory: sequentialIds(),
    });

    await scheduler.runOnce();
    expect(execute).toHaveBeenCalledTimes(2);

    now += 60_001;
    limits = { maximumCandidatesPerRun: 4, maxConcurrency: 2 };
    await scheduler.runOnce();
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("runs operational retention at most once per day per process", async () => {
    const db = migratedDb();
    let now = Date.parse("2026-08-20T00:00:00.000Z");
    const cutoff = now - 14 * 24 * HOUR_MS;
    insertDueCandidate(db, "old.service.example", cutoff - 1);
    db.update(domainCandidates).set({ nextValidationAt: 8_640_000_000_000_000 }).run();
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => false,
      execute: vi.fn(),
      now: () => now,
      idFactory: sequentialIds(),
    });

    await scheduler.runOnce();
    expect(db.select().from(domainCandidates).all()).toEqual([]);

    insertDueCandidate(db, "second-old.service.example", cutoff - 1);
    db.update(domainCandidates).set({ nextValidationAt: 8_640_000_000_000_000 }).run();
    await scheduler.runOnce();
    expect(db.select().from(domainCandidates).all()).toHaveLength(1);

    now += 24 * HOUR_MS;
    await scheduler.runOnce();
    expect(db.select().from(domainCandidates).all()).toEqual([]);
  });

  it("recovers an expired crash run before disabled retention", async () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const cutoff = now - 14 * 24 * HOUR_MS;
    insertDueCandidate(db, "crashed.service.example", cutoff - 2);
    db.update(domainCandidates)
      .set({
        status: "pending",
        nextValidationAt: 8_640_000_000_000_000,
        leaseId: "expired_lease",
        leaseUntil: cutoff - 1,
        leaseGeneration: 1,
      })
      .run();
    db.insert(domainValidationRuns)
      .values({
        id: "crashed_run",
        leaseId: "expired_lease",
        leaseGeneration: 1,
        fqdn: "crashed.service.example",
        startedAt: cutoff - 2,
        finishedAt: null,
        status: "running",
        errorCategory: null,
      })
      .run();
    const scheduler = new DomainValidationScheduler({
      db,
      isEnabled: () => false,
      execute: vi.fn(),
      now: () => now,
      idFactory: sequentialIds(),
    });

    await scheduler.runOnce();

    expect(db.select().from(domainValidationRuns).all()).toEqual([]);
    expect(db.select().from(domainCandidates).all()).toEqual([]);
  });
});
