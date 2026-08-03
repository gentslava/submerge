import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import {
  domainCandidates,
  domainDailyStats,
  domainDecisions,
  domainObservations,
  domainValidationAttempts,
  domainValidationRuns,
} from "../../db/schema.js";
import {
  type DomainObservation,
  fingerprintObservation,
  type ObservationSource,
} from "./observer.js";
import {
  type CompleteDomainValidationRunInput,
  completeDomainValidationRun,
  failDomainValidationRun,
  getDomainDecision,
  leaseDomainCandidate,
  listDomainValidationAttempts,
  pruneDomainIntelligence,
  queueDomainCandidate,
  recordObservation,
  startDomainValidationRun,
} from "./service.js";

const FILTER_POLICY = {
  excludedTlds: ["ru", "su", "xn--p1ai"],
  neverAddDomains: [],
  neverAddSuffixes: ["telemetry.example"],
  nonWidenableSuffixes: ["vercel.app"],
  telemetryPatterns: [],
} as const;

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

function migratedDb(): Db {
  const db = createDb(":memory:");
  migrate(db, { migrationsFolder });
  return db;
}

function observation(
  observedAt: number,
  source: ObservationSource = "mihomo-log",
  fqdn = "api.service.example",
): DomainObservation {
  return {
    fqdn,
    observedAt,
    transport: "tcp",
    source,
    fingerprint: fingerprintObservation(fqdn, "tcp", observedAt),
  };
}

function observeAndQueue(db: Db, fqdn: string, observedAt: number): void {
  recordObservation(db, observation(observedAt, "mihomo-log", fqdn));
  expect(
    queueDomainCandidate(db, {
      fqdn,
      filterPolicy: FILTER_POLICY,
      preferredScope: "site",
      now: observedAt,
    }),
  ).toMatchObject({ status: "queued", fqdn });
}

function insertCandidate(
  db: Db,
  fqdn: string,
  updatedAt: number,
  lease: { id: string; until: number } | null = null,
): void {
  db.insert(domainCandidates)
    .values({
      fqdn,
      registrableSite: "service.example",
      selectedScope: "exact",
      proposedRule: fqdn,
      status: "queued",
      firstSeenAt: updatedAt,
      lastSeenAt: updatedAt,
      nextValidationAt: updatedAt,
      lastValidationAt: null,
      failureStreak: 0,
      leaseId: lease?.id ?? null,
      leaseUntil: lease?.until ?? null,
      leaseGeneration: lease ? 1 : 0,
      updatedAt,
    })
    .run();
}

function completionInput(
  runId: string,
  lease: { leaseId: string; leaseGeneration: number },
  startedAt: number,
): CompleteDomainValidationRunInput {
  const finishedAt = startedAt + 2_000;
  return {
    runId,
    leaseId: lease.leaseId,
    leaseGeneration: lease.leaseGeneration,
    finishedAt,
    nextValidationAt: finishedAt + 2 * 60 * 60 * 1_000,
    failureStreak: 0,
    attempts: [
      {
        id: `${runId}_direct`,
        attemptedAt: startedAt,
        result: {
          direction: "direct",
          category: "connect_timeout",
          transportSuccess: false,
          httpStatus: null,
          resolvedAddress: "1.1.1.1",
          availableAddressCount: 1,
          connectDurationMs: 1_000,
          tlsDurationMs: null,
          totalDurationMs: 1_001,
          redirectCount: 0,
          finalOrigin: "https://api.service.example",
        },
      },
      {
        id: `${runId}_proxy`,
        attemptedAt: startedAt + 1_000,
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
          finalOrigin: "https://api.service.example",
        },
      },
    ],
    decision: {
      id: `${runId}_decision`,
      evaluatedAt: finishedAt,
      value: {
        status: "pending",
        confidence: "low",
        reasons: ["insufficient-direct-failures"],
        windowStart: finishedAt - 24 * 60 * 60 * 1_000,
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
      selectedScope: "site",
      proposedRule: "+.service.example",
    },
  };
}

function leaseAndStart(
  db: Db,
  fqdn: string,
  runId: string,
  startedAt: number,
): { leaseId: string; leaseGeneration: number } {
  const leaseId = `${runId}_lease`;
  const lease = leaseDomainCandidate(db, {
    fqdn,
    leaseId,
    now: startedAt,
    leaseUntil: startedAt + 60_000,
  });
  expect(lease).not.toBeNull();
  if (!lease) throw new Error("missing lease fixture");
  startDomainValidationRun(db, {
    id: runId,
    fqdn,
    leaseId,
    leaseGeneration: lease.leaseGeneration,
    startedAt,
  });
  return { leaseId, leaseGeneration: lease.leaseGeneration };
}

describe("domain observation persistence", () => {
  it("stores one privacy-bounded observation and UTC daily aggregate", () => {
    const db = migratedDb();
    const observedAt = Date.parse("2026-08-03T23:59:59.000Z");

    expect(recordObservation(db, observation(observedAt))).toEqual({
      status: "inserted",
      dailyCount: 1,
    });
    expect(db.select().from(domainObservations).all()).toEqual([
      {
        fingerprint: fingerprintObservation("api.service.example", "tcp", observedAt),
        fqdn: "api.service.example",
        observedAt,
        lastSeenAt: observedAt,
        transport: "tcp",
        source: "mihomo-log",
        count: 1,
      },
    ]);
    expect(db.select().from(domainDailyStats).orderBy(domainDailyStats.day).all()).toEqual([
      {
        day: "2026-08-03",
        fqdn: "api.service.example",
        connectionCount: 1,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      },
    ]);
    expect(db.select().from(domainCandidates).all()).toEqual([]);
  });

  it("reconciles an exact source-independent fingerprint without incrementing count", () => {
    const db = migratedDb();
    const first = observation(10_000, "mihomo-log");
    const duplicate = observation(20_000, "connection-snapshot");
    expect(first.fingerprint).toBe(duplicate.fingerprint);

    expect(recordObservation(db, first).status).toBe("inserted");
    expect(recordObservation(db, duplicate)).toEqual({ status: "duplicate", dailyCount: 1 });

    expect(db.select().from(domainObservations).all()).toMatchObject([
      { observedAt: 10_000, lastSeenAt: 20_000, source: "mihomo-log", count: 1 },
    ]);
    expect(db.select().from(domainDailyStats).all()).toMatchObject([
      { connectionCount: 1, firstSeenAt: 10_000, lastSeenAt: 20_000 },
    ]);
    expect(db.select().from(domainCandidates).all()).toEqual([]);
  });

  it("reconciles cross-source observations across an adjacent bucket boundary", () => {
    const db = migratedDb();
    const first = observation(29_999, "connection-snapshot");
    const adjacent = observation(30_001, "mihomo-log");
    expect(first.fingerprint).not.toBe(adjacent.fingerprint);

    recordObservation(db, first);
    expect(recordObservation(db, adjacent)).toEqual({ status: "reconciled", dailyCount: 1 });

    expect(db.select().from(domainObservations).all()).toHaveLength(1);
    expect(db.select().from(domainDailyStats).get()?.connectionCount).toBe(1);
  });

  it("counts distinct same-source observations on opposite sides of a bucket boundary", () => {
    const db = migratedDb();
    recordObservation(db, observation(29_999));
    expect(recordObservation(db, observation(30_001))).toEqual({
      status: "inserted",
      dailyCount: 2,
    });

    expect(db.select().from(domainObservations).all()).toHaveLength(2);
    expect(db.select().from(domainDailyStats).get()?.connectionCount).toBe(2);
  });

  it("keeps UTC days and FQDNs as independent aggregates", () => {
    const db = migratedDb();
    recordObservation(db, observation(Date.parse("2026-08-03T23:59:59.999Z")));
    recordObservation(db, observation(Date.parse("2026-08-04T00:00:00.001Z")));
    recordObservation(
      db,
      observation(Date.parse("2026-08-04T01:00:00.000Z"), "mihomo-log", "other.example"),
    );

    expect(db.select().from(domainDailyStats).all()).toMatchObject([
      { day: "2026-08-03", fqdn: "api.service.example", connectionCount: 1 },
      { day: "2026-08-04", fqdn: "api.service.example", connectionCount: 1 },
      { day: "2026-08-04", fqdn: "other.example", connectionCount: 1 },
    ]);
  });

  it("chooses the same canonical UTC day regardless of cross-source ingest order", () => {
    const log = observation(Date.parse("2026-08-04T00:00:00.001Z"), "mihomo-log");
    const snapshot = observation(Date.parse("2026-08-03T23:59:59.999Z"), "connection-snapshot");
    const capture = (ordered: DomainObservation[]) => {
      const db = migratedDb();
      for (const item of ordered) recordObservation(db, item);
      return {
        observations: db.select().from(domainObservations).all(),
        daily: db.select().from(domainDailyStats).all(),
      };
    };

    const logFirst = capture([log, snapshot]);
    const snapshotFirst = capture([snapshot, log]);

    expect(logFirst).toEqual(snapshotFirst);
    expect(logFirst).toEqual({
      observations: [
        {
          fingerprint: snapshot.fingerprint,
          fqdn: snapshot.fqdn,
          observedAt: snapshot.observedAt,
          lastSeenAt: log.observedAt,
          transport: "tcp",
          source: "connection-snapshot",
          count: 1,
        },
      ],
      daily: [
        {
          day: "2026-08-03",
          fqdn: snapshot.fqdn,
          connectionCount: 1,
          firstSeenAt: snapshot.observedAt,
          lastSeenAt: log.observedAt,
        },
      ],
    });
  });

  it("rebuilds the old aggregate when canonical reconciliation crosses UTC midnight", () => {
    const db = migratedDb();
    const anotherConnection = observation(Date.parse("2026-08-04T01:00:00.000Z"));
    const log = observation(Date.parse("2026-08-04T00:00:00.001Z"), "mihomo-log");
    const snapshot = observation(Date.parse("2026-08-03T23:59:59.999Z"), "connection-snapshot");

    recordObservation(db, anotherConnection);
    recordObservation(db, log);
    recordObservation(db, snapshot);

    expect(db.select().from(domainDailyStats).orderBy(domainDailyStats.day).all()).toEqual([
      {
        day: "2026-08-03",
        fqdn: snapshot.fqdn,
        connectionCount: 1,
        firstSeenAt: snapshot.observedAt,
        lastSeenAt: log.observedAt,
      },
      {
        day: "2026-08-04",
        fqdn: anotherConnection.fqdn,
        connectionCount: 1,
        firstSeenAt: anotherConnection.observedAt,
        lastSeenAt: anotherConnection.observedAt,
      },
    ]);
  });

  it("rolls back the observation when the daily aggregate write aborts", () => {
    const db = migratedDb();
    db.$client.exec(`
      CREATE TRIGGER abort_domain_daily_insert
      BEFORE INSERT ON domain_daily_stats
      BEGIN
        SELECT RAISE(ABORT, 'forced daily failure');
      END;
    `);

    expect(() => recordObservation(db, observation(10_000))).toThrow(/forced daily failure/i);
    expect(db.select().from(domainObservations).all()).toEqual([]);
    expect(db.select().from(domainDailyStats).all()).toEqual([]);
    expect(db.select().from(domainCandidates).all()).toEqual([]);
  });

  it("rejects an observation whose fingerprint does not match its normalized facts", () => {
    const db = migratedDb();
    expect(() =>
      recordObservation(db, { ...observation(10_000), fingerprint: "tampered" }),
    ).toThrow(/fingerprint/i);
    expect(db.select().from(domainObservations).all()).toEqual([]);
  });

  it("defines no columns for client identity or connection payload", () => {
    const db = migratedDb();
    const columns = db.$client
      .prepare("PRAGMA table_info(domain_observations)")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(columns).toEqual([
      "fingerprint",
      "fqdn",
      "observed_at",
      "last_seen_at",
      "transport",
      "source",
      "count",
    ]);
  });

  it("queues only a currently eligible domain without postponing existing due work", () => {
    const db = migratedDb();
    recordObservation(db, observation(10_000));

    expect(
      queueDomainCandidate(db, {
        fqdn: "api.service.example",
        filterPolicy: FILTER_POLICY,
        preferredScope: "site",
        now: 20_000,
      }),
    ).toEqual({ status: "queued", fqdn: "api.service.example" });
    recordObservation(db, observation(30_000));
    expect(
      queueDomainCandidate(db, {
        fqdn: "api.service.example",
        filterPolicy: FILTER_POLICY,
        preferredScope: "site",
        now: 40_000,
      }),
    ).toEqual({ status: "updated", fqdn: "api.service.example" });

    expect(db.select().from(domainCandidates).get()).toMatchObject({
      fqdn: "api.service.example",
      registrableSite: "service.example",
      selectedScope: "site",
      proposedRule: "+.service.example",
      firstSeenAt: 10_000,
      lastSeenAt: 30_000,
      nextValidationAt: 20_000,
      updatedAt: 40_000,
    });
  });

  it("never creates a candidate for a current never-add match", () => {
    const db = migratedDb();
    recordObservation(db, observation(10_000, "mihomo-log", "pixel.telemetry.example"));

    expect(
      queueDomainCandidate(db, {
        fqdn: "pixel.telemetry.example",
        filterPolicy: FILTER_POLICY,
        preferredScope: "site",
        now: 20_000,
      }),
    ).toEqual({ status: "excluded", reason: "never-add-suffix" });
    expect(db.select().from(domainCandidates).all()).toEqual([]);
  });

  it("forces an existing site candidate to exact when current policy forbids widening", () => {
    const db = migratedDb();
    recordObservation(db, observation(10_000));
    queueDomainCandidate(db, {
      fqdn: "api.service.example",
      filterPolicy: FILTER_POLICY,
      preferredScope: "site",
      now: 20_000,
    });

    expect(
      queueDomainCandidate(db, {
        fqdn: "api.service.example",
        filterPolicy: {
          ...FILTER_POLICY,
          nonWidenableSuffixes: [...FILTER_POLICY.nonWidenableSuffixes, "service.example"],
        },
        preferredScope: "site",
        now: 30_000,
      }),
    ).toEqual({ status: "updated", fqdn: "api.service.example" });
    expect(db.select().from(domainCandidates).get()).toMatchObject({
      status: "queued",
      selectedScope: "exact",
      proposedRule: "api.service.example",
      exclusionReason: null,
      nextValidationAt: 30_000,
    });
  });

  it("deactivates an existing candidate that becomes Never-add and requeues it after removal", () => {
    const db = migratedDb();
    recordObservation(db, observation(10_000));
    queueDomainCandidate(db, {
      fqdn: "api.service.example",
      filterPolicy: FILTER_POLICY,
      preferredScope: "site",
      now: 20_000,
    });

    expect(
      queueDomainCandidate(db, {
        fqdn: "api.service.example",
        filterPolicy: {
          ...FILTER_POLICY,
          neverAddDomains: ["api.service.example"],
        },
        preferredScope: "site",
        now: 30_000,
      }),
    ).toEqual({ status: "excluded", reason: "never-add-domain" });
    expect(db.select().from(domainCandidates).get()).toMatchObject({
      status: "excluded",
      selectedScope: null,
      proposedRule: null,
      exclusionReason: "never-add-domain",
      nextValidationAt: 8_640_000_000_000_000,
    });

    expect(
      queueDomainCandidate(db, {
        fqdn: "api.service.example",
        filterPolicy: FILTER_POLICY,
        preferredScope: "site",
        now: 40_000,
      }),
    ).toEqual({ status: "updated", fqdn: "api.service.example" });
    expect(db.select().from(domainCandidates).get()).toMatchObject({
      status: "queued",
      selectedScope: "site",
      proposedRule: "+.service.example",
      exclusionReason: null,
      nextValidationAt: 40_000,
    });
  });

  it("persists and strictly reads one sanitized completed A/B decision", () => {
    const db = migratedDb();
    const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
    const finishedAt = startedAt + 2_000;
    observeAndQueue(db, "api.service.example", startedAt);
    const leaseId = leaseAndStart(db, "api.service.example", "run_1", startedAt);
    completeDomainValidationRun(db, completionInput("run_1", leaseId, startedAt));

    expect(listDomainValidationAttempts(db, "run_1")).toHaveLength(2);
    expect(getDomainDecision(db, "run_1_decision")).toMatchObject({
      id: "run_1_decision",
      status: "pending",
      confidence: "low",
      reasons: ["insufficient-direct-failures"],
    });
    expect(() =>
      db.$client
        .prepare("UPDATE domain_validation_attempts SET transport_success = 2 WHERE id = ?")
        .run("run_1_direct"),
    ).toThrow(/check constraint/i);
    expect(() =>
      db.$client
        .prepare(
          "UPDATE domain_validation_runs SET status = 'failed', error_category = 'raw secret', finished_at = ? WHERE id = ?",
        )
        .run(finishedAt, "run_1"),
    ).toThrow(/check constraint/i);
  });

  it("fences expired, foreign, and renewed validation leases", () => {
    const db = migratedDb();
    const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
    observeAndQueue(db, "api.service.example", startedAt);
    const oldLease = leaseDomainCandidate(db, {
      fqdn: "api.service.example",
      leaseId: "old_lease",
      now: startedAt,
      leaseUntil: startedAt + 100,
    });
    expect(oldLease).toMatchObject({ leaseId: "old_lease", leaseGeneration: 1 });
    if (!oldLease) throw new Error("missing old lease fixture");
    expect(
      leaseDomainCandidate(db, {
        fqdn: "api.service.example",
        leaseId: "foreign_lease",
        now: startedAt + 1,
        leaseUntil: startedAt + 101,
      }),
    ).toBeNull();
    startDomainValidationRun(db, {
      id: "old_run",
      fqdn: "api.service.example",
      leaseId: "old_lease",
      leaseGeneration: oldLease.leaseGeneration,
      startedAt,
    });

    const renewedAt = startedAt + 101;
    const newLease = leaseDomainCandidate(db, {
      fqdn: "api.service.example",
      leaseId: "old_lease",
      now: renewedAt,
      leaseUntil: renewedAt + 60_000,
    });
    expect(newLease).toMatchObject({ leaseId: "old_lease", leaseGeneration: 2 });
    if (!newLease) throw new Error("missing renewed lease fixture");
    startDomainValidationRun(db, {
      id: "new_run",
      fqdn: "api.service.example",
      leaseId: "old_lease",
      leaseGeneration: newLease.leaseGeneration,
      startedAt: renewedAt,
    });

    expect(() =>
      completeDomainValidationRun(db, completionInput("old_run", oldLease, startedAt)),
    ).toThrow(/running|lease/i);
    expect(() =>
      failDomainValidationRun(db, {
        runId: "old_run",
        leaseId: "old_lease",
        leaseGeneration: oldLease.leaseGeneration,
        finishedAt: renewedAt + 1,
        status: "failed",
        errorCategory: "lease-lost",
        nextValidationAt: renewedAt + 2,
        failureStreak: 1,
      }),
    ).toThrow(/running|lease/i);
    expect(() =>
      failDomainValidationRun(db, {
        runId: "new_run",
        leaseId: "foreign_lease",
        leaseGeneration: newLease.leaseGeneration,
        finishedAt: renewedAt + 1,
        status: "failed",
        errorCategory: "lease-lost",
        nextValidationAt: renewedAt + 2,
        failureStreak: 1,
      }),
    ).toThrow(/lease/i);

    failDomainValidationRun(db, {
      runId: "new_run",
      leaseId: "old_lease",
      leaseGeneration: newLease.leaseGeneration,
      finishedAt: renewedAt + 1,
      status: "failed",
      errorCategory: "infrastructure-failure",
      nextValidationAt: renewedAt + 2,
      failureStreak: 1,
    });
    expect(db.select().from(domainValidationRuns).all()).toMatchObject([
      { id: "old_run", status: "cancelled", errorCategory: "lease-lost" },
      { id: "new_run", status: "failed", errorCategory: "infrastructure-failure" },
    ]);
    expect(db.select().from(domainCandidates).get()).toMatchObject({
      leaseId: null,
      leaseUntil: null,
    });
  });

  it("rejects stale queue, lease, and start lifecycle timestamps", () => {
    const db = migratedDb();
    const observedAt = Date.parse("2026-08-03T12:00:00.000Z");
    observeAndQueue(db, "api.service.example", observedAt);
    expect(
      queueDomainCandidate(db, {
        fqdn: "api.service.example",
        filterPolicy: FILTER_POLICY,
        preferredScope: "site",
        now: observedAt + 100,
      }),
    ).toMatchObject({ status: "updated" });

    expect(
      leaseDomainCandidate(db, {
        fqdn: "api.service.example",
        leaseId: "stale_claim",
        now: observedAt + 50,
        leaseUntil: observedAt + 60_050,
      }),
    ).toBeNull();
    expect(db.select().from(domainCandidates).get()).toMatchObject({
      updatedAt: observedAt + 100,
      leaseId: null,
    });

    const lease = leaseDomainCandidate(db, {
      fqdn: "api.service.example",
      leaseId: "current_claim",
      now: observedAt + 200,
      leaseUntil: observedAt + 60_200,
    });
    expect(lease).toMatchObject({ leaseGeneration: 1 });
    if (!lease) throw new Error("missing lifecycle lease fixture");
    expect(() =>
      startDomainValidationRun(db, {
        id: "predated_run",
        fqdn: "api.service.example",
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        startedAt: observedAt + 150,
      }),
    ).toThrow(/lease|timestamp|lifecycle/i);
    expect(db.select().from(domainValidationRuns).all()).toEqual([]);

    startDomainValidationRun(db, {
      id: "current_run",
      fqdn: "api.service.example",
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      startedAt: observedAt + 200,
    });
    expect(() =>
      queueDomainCandidate(db, {
        fqdn: "api.service.example",
        filterPolicy: { ...FILTER_POLICY, neverAddDomains: ["api.service.example"] },
        preferredScope: "site",
        now: observedAt + 199,
      }),
    ).toThrow(/timestamp|lifecycle/i);
    expect(db.select().from(domainCandidates).get()).toMatchObject({
      status: "pending",
      leaseId: lease.leaseId,
      updatedAt: observedAt + 200,
    });
    expect(db.select().from(domainValidationRuns).get()).toMatchObject({
      id: "current_run",
      status: "running",
    });
  });

  it("rejects completion and failure before the latest candidate update", () => {
    const db = migratedDb();
    const observedAt = Date.parse("2026-08-03T12:00:00.000Z");
    observeAndQueue(db, "api.service.example", observedAt);
    const lease = leaseAndStart(db, "api.service.example", "chronology_run", observedAt + 100);
    queueDomainCandidate(db, {
      fqdn: "api.service.example",
      filterPolicy: FILTER_POLICY,
      preferredScope: "site",
      now: observedAt + 500,
    });

    const completion = completionInput("chronology_run", lease, observedAt + 100);
    completion.finishedAt = observedAt + 200;
    completion.nextValidationAt = observedAt + 300;
    const proxyAttempt = completion.attempts[1];
    if (!proxyAttempt) throw new Error("missing chronology proxy fixture");
    completion.attempts[1] = {
      ...proxyAttempt,
      attemptedAt: observedAt + 101,
    };
    completion.decision.evaluatedAt = observedAt + 200;
    completion.decision.value.windowStart = observedAt + 200 - 24 * 60 * 60 * 1_000;
    expect(() => completeDomainValidationRun(db, completion)).toThrow(/lease|timestamp|lifecycle/i);
    expect(() =>
      failDomainValidationRun(db, {
        runId: "chronology_run",
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        finishedAt: observedAt + 200,
        status: "failed",
        errorCategory: "infrastructure-failure",
        nextValidationAt: observedAt + 300,
        failureStreak: 1,
      }),
    ).toThrow(/timestamp|lifecycle/i);
    expect(db.select().from(domainCandidates).get()).toMatchObject({
      status: "pending",
      leaseId: lease.leaseId,
      updatedAt: observedAt + 500,
    });
    expect(db.select().from(domainValidationAttempts).all()).toEqual([]);
    expect(db.select().from(domainDecisions).all()).toEqual([]);
    expect(db.select().from(domainValidationRuns).get()).toMatchObject({ status: "running" });
  });

  it("rejects raw errors, unsafe final URLs, and drifted decision JSON", () => {
    const db = migratedDb();
    const startedAt = Date.parse("2026-08-03T12:00:00.000Z");
    observeAndQueue(db, "api.service.example", startedAt);
    const lease = leaseAndStart(db, "api.service.example", "run_unsafe", startedAt);

    expect(() =>
      failDomainValidationRun(db, {
        runId: "run_unsafe",
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        finishedAt: startedAt + 1,
        status: "failed",
        errorCategory: "password=raw-secret" as never,
        nextValidationAt: startedAt + 2,
        failureStreak: 1,
      }),
    ).toThrow();

    const completion: CompleteDomainValidationRunInput = {
      runId: "run_unsafe",
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      finishedAt: startedAt + 1_000,
      nextValidationAt: startedAt + 2_000,
      failureStreak: 1,
      attempts: [
        {
          id: "unsafe_direct",
          attemptedAt: startedAt,
          result: {
            direction: "direct",
            category: "dns_failure",
            transportSuccess: false,
            httpStatus: null,
            resolvedAddress: null,
            availableAddressCount: 0,
            connectDurationMs: null,
            tlsDurationMs: null,
            totalDurationMs: 1,
            redirectCount: 0,
            finalOrigin: "https://api.service.example",
          },
        },
        {
          id: "unsafe_proxy",
          attemptedAt: startedAt + 1,
          result: {
            direction: "proxy",
            category: "infrastructure_error",
            transportSuccess: false,
            httpStatus: null,
            resolvedAddress: null,
            availableAddressCount: 0,
            connectDurationMs: null,
            tlsDurationMs: null,
            totalDurationMs: 1,
            redirectCount: 0,
            finalOrigin: "https://api.service.example",
          },
        },
      ],
      decision: {
        id: "unsafe_decision",
        evaluatedAt: startedAt + 1_000,
        value: {
          status: "blocked",
          confidence: "none",
          reasons: ["invalid-evidence"],
          windowStart: null,
          evidence: {
            directQualifyingFailures: 0,
            directSpacedFailures: 0,
            directAddressDiversityRequired: false,
            directAddressDiversitySatisfied: false,
            proxyHttpSuccesses: 0,
            proxyTransportFailures: 0,
            proxyUncertainFailures: 0,
          },
        },
        selectedScope: "site",
        proposedRule: "+.service.example",
      },
    };
    const unsafeOrigin = structuredClone(completion);
    const directAttempt = unsafeOrigin.attempts.find(
      (attempt) => attempt.result.direction === "direct",
    );
    if (!directAttempt) throw new Error("missing direct attempt fixture");
    directAttempt.result.finalOrigin = "https://user:secret@api.service.example/path?token=secret";
    expect(() => completeDomainValidationRun(db, unsafeOrigin)).toThrow(/origin/i);

    const unknownReason = structuredClone(completion);
    unknownReason.decision.value.reasons = ["unknown-secret-reason"] as never;
    expect(() => completeDomainValidationRun(db, unknownReason)).toThrow();

    const missingPinnedAddress = structuredClone(completion);
    const missingAddressAttempt = missingPinnedAddress.attempts.find(
      (attempt) => attempt.result.direction === "direct",
    );
    if (!missingAddressAttempt) throw new Error("missing direct attempt fixture");
    missingAddressAttempt.result.category = "connect_timeout";
    missingAddressAttempt.result.resolvedAddress = null;
    missingAddressAttempt.result.availableAddressCount = 0;
    expect(() => completeDomainValidationRun(db, missingPinnedAddress)).toThrow(/address/i);

    const impossibleConfirmed = structuredClone(completion);
    impossibleConfirmed.decision.value = {
      ...impossibleConfirmed.decision.value,
      status: "confirmed",
      confidence: "high",
      reasons: ["insufficient-direct-failures"],
    } as never;
    expect(() => completeDomainValidationRun(db, impossibleConfirmed)).toThrow();

    const prematureDecision = structuredClone(completion);
    prematureDecision.decision.evaluatedAt = startedAt;
    expect(() => completeDomainValidationRun(db, prematureDecision)).toThrow(/decision/i);

    const ancientWindow = structuredClone(completion);
    ancientWindow.decision.value.windowStart = 0;
    expect(() => completeDomainValidationRun(db, ancientWindow)).toThrow(/window/i);

    const zeroLengthWindow = structuredClone(completion);
    zeroLengthWindow.decision.value.windowStart = zeroLengthWindow.decision.evaluatedAt;
    expect(() => completeDomainValidationRun(db, zeroLengthWindow)).toThrow(/window/i);
    expect(db.select().from(domainValidationAttempts).all()).toEqual([]);
    expect(db.select().from(domainDecisions).all()).toEqual([]);

    const insertRawDecision = (id: string, reasons: string, evidence: string): void => {
      db.$client
        .prepare(
          "INSERT INTO domain_decisions (id, fqdn, evaluated_at, status, confidence, reasons, window_start, evidence, selected_scope, proposed_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          "api.service.example",
          startedAt,
          "blocked",
          "none",
          reasons,
          null,
          evidence,
          "site",
          "+.service.example",
        );
    };
    const emptyEvidence = JSON.stringify({
      directQualifyingFailures: 0,
      directSpacedFailures: 0,
      directAddressDiversityRequired: false,
      directAddressDiversitySatisfied: false,
      proxyHttpSuccesses: 0,
      proxyTransportFailures: 0,
      proxyUncertainFailures: 0,
    });
    insertRawDecision("corrupt_reason", '["unknown-secret-reason"]', emptyEvidence);
    insertRawDecision(
      "corrupt_evidence",
      '["invalid-evidence"]',
      '{"directQualifyingFailures":"raw secret"}',
    );
    expect(() => getDomainDecision(db, "corrupt_reason")).toThrow();
    expect(() => getDomainDecision(db, "corrupt_evidence")).toThrow();

    db.$client
      .prepare(
        "INSERT INTO domain_decisions (id, fqdn, evaluated_at, status, confidence, reasons, window_start, evidence, selected_scope, proposed_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "impossible_confirmed",
        "api.service.example",
        startedAt,
        "confirmed",
        "high",
        '["invalid-evidence"]',
        null,
        emptyEvidence,
        "exact",
        "api.service.example",
      );
    expect(() => getDomainDecision(db, "impossible_confirmed")).toThrow(/invalid/i);

    insertCandidate(db, "foo.example.co.uk", startedAt);
    db.$client
      .prepare(
        "INSERT INTO domain_decisions (id, fqdn, evaluated_at, status, confidence, reasons, window_start, evidence, selected_scope, proposed_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "unsafe_public_suffix",
        "foo.example.co.uk",
        startedAt,
        "confirmed",
        "high",
        "[]",
        startedAt - 1,
        JSON.stringify({
          directQualifyingFailures: 3,
          directSpacedFailures: 3,
          directAddressDiversityRequired: false,
          directAddressDiversitySatisfied: true,
          proxyHttpSuccesses: 2,
          proxyTransportFailures: 0,
          proxyUncertainFailures: 0,
        }),
        "site",
        "+.co.uk",
      );
    expect(() => getDomainDecision(db, "unsafe_public_suffix")).toThrow(/rule/i);

    db.$client
      .prepare(
        "INSERT INTO domain_decisions (id, fqdn, evaluated_at, status, confidence, reasons, window_start, evidence, selected_scope, proposed_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "ancient_window",
        "api.service.example",
        startedAt,
        "confirmed",
        "high",
        "[]",
        0,
        JSON.stringify({
          directQualifyingFailures: 3,
          directSpacedFailures: 3,
          directAddressDiversityRequired: false,
          directAddressDiversitySatisfied: true,
          proxyHttpSuccesses: 2,
          proxyTransportFailures: 0,
          proxyUncertainFailures: 0,
        }),
        "exact",
        "api.service.example",
      );
    expect(() => getDomainDecision(db, "ancient_window")).toThrow(/window|invalid/i);
  });

  it("prunes each operational table at the strict fourteen-day boundary", () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const cutoff = now - 14 * 24 * 60 * 60 * 1_000;
    recordObservation(db, observation(cutoff - 1, "mihomo-log", "old.service.example"));
    recordObservation(db, observation(cutoff, "mihomo-log", "kept.service.example"));
    insertCandidate(db, "old.service.example", cutoff - 1);
    insertCandidate(db, "kept.service.example", cutoff);

    db.insert(domainValidationRuns)
      .values([
        {
          id: "old-run",
          leaseId: "retention-lease",
          leaseGeneration: 1,
          fqdn: "kept.service.example",
          startedAt: cutoff - 10,
          finishedAt: cutoff - 1,
          status: "completed",
          errorCategory: null,
        },
        {
          id: "kept-run",
          leaseId: "retention-lease",
          leaseGeneration: 1,
          fqdn: "kept.service.example",
          startedAt: cutoff,
          finishedAt: cutoff,
          status: "completed",
          errorCategory: null,
        },
        {
          id: "straddling-run",
          leaseId: "retention-lease",
          leaseGeneration: 1,
          fqdn: "kept.service.example",
          startedAt: cutoff - 10,
          finishedAt: cutoff,
          status: "completed",
          errorCategory: null,
        },
      ])
      .run();
    db.insert(domainValidationAttempts)
      .values([
        {
          id: "old-attempt",
          runId: "old-run",
          direction: "direct",
          attemptedAt: cutoff - 1,
          category: "connect_timeout",
          transportSuccess: false,
          httpStatus: null,
          resolvedAddress: "1.1.1.1",
          availableAddressCount: 1,
          connectDurationMs: null,
          tlsDurationMs: null,
          totalDurationMs: 1,
          redirectCount: 0,
          finalOrigin: "https://kept.service.example",
        },
        {
          id: "kept-attempt",
          runId: "kept-run",
          direction: "direct",
          attemptedAt: cutoff,
          category: "connect_timeout",
          transportSuccess: false,
          httpStatus: null,
          resolvedAddress: "1.1.1.1",
          availableAddressCount: 1,
          connectDurationMs: null,
          tlsDurationMs: null,
          totalDurationMs: 1,
          redirectCount: 0,
          finalOrigin: "https://kept.service.example",
        },
        {
          id: "straddling-old-attempt",
          runId: "straddling-run",
          direction: "direct",
          attemptedAt: cutoff - 1,
          category: "connect_timeout",
          transportSuccess: false,
          httpStatus: null,
          resolvedAddress: "1.1.1.1",
          availableAddressCount: 1,
          connectDurationMs: null,
          tlsDurationMs: null,
          totalDurationMs: 1,
          redirectCount: 0,
          finalOrigin: "https://kept.service.example",
        },
      ])
      .run();
    db.insert(domainDecisions)
      .values([
        {
          id: "old-decision",
          fqdn: "kept.service.example",
          evaluatedAt: cutoff - 1,
          status: "pending",
          confidence: "low",
          reasons: ["insufficient-direct-failures"],
          windowStart: cutoff - 24 * 60 * 60 * 1_000,
          evidence: {
            directQualifyingFailures: 1,
            directSpacedFailures: 1,
            directAddressDiversityRequired: false,
            directAddressDiversitySatisfied: true,
            proxyHttpSuccesses: 0,
            proxyTransportFailures: 0,
            proxyUncertainFailures: 0,
          },
          selectedScope: "exact",
          proposedRule: "kept.service.example",
        },
        {
          id: "kept-decision",
          fqdn: "kept.service.example",
          evaluatedAt: cutoff,
          status: "pending",
          confidence: "low",
          reasons: ["insufficient-direct-failures"],
          windowStart: cutoff - 24 * 60 * 60 * 1_000,
          evidence: {
            directQualifyingFailures: 1,
            directSpacedFailures: 1,
            directAddressDiversityRequired: false,
            directAddressDiversitySatisfied: true,
            proxyHttpSuccesses: 0,
            proxyTransportFailures: 0,
            proxyUncertainFailures: 0,
          },
          selectedScope: "exact",
          proposedRule: "kept.service.example",
        },
      ])
      .run();
    db.$client.exec(
      "CREATE TABLE domain_apply_operations (id TEXT PRIMARY KEY, committed_at INTEGER NOT NULL)",
    );
    db.$client
      .prepare("INSERT INTO domain_apply_operations (id, committed_at) VALUES (?, ?)")
      .run("future-audit", cutoff - 1);

    expect(pruneDomainIntelligence(db, now)).toEqual({
      observations: 1,
      dailyStats: 1,
      candidates: 1,
      validationRuns: 1,
      validationAttempts: 2,
      decisions: 1,
    });
    expect(db.select().from(domainCandidates).all()).toMatchObject([
      { fqdn: "kept.service.example" },
    ]);
    expect(db.select().from(domainValidationRuns).all()).toMatchObject([
      { id: "kept-run" },
      { id: "straddling-run" },
    ]);
    expect(db.select().from(domainValidationAttempts).all()).toMatchObject([
      { id: "kept-attempt" },
    ]);
    expect(db.select().from(domainDecisions).all()).toMatchObject([{ id: "kept-decision" }]);
    expect(db.$client.prepare("SELECT id FROM domain_apply_operations").all()).toEqual([
      { id: "future-audit" },
    ]);
  });

  it("does not prune an active lease or any of its evidence", () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const cutoff = now - 14 * 24 * 60 * 60 * 1_000;
    insertCandidate(db, "leased.service.example", cutoff - 1, {
      id: "active_lease",
      until: now + 1,
    });
    db.insert(domainValidationRuns)
      .values({
        id: "leased-run",
        leaseId: "active_lease",
        leaseGeneration: 1,
        fqdn: "leased.service.example",
        startedAt: cutoff - 2,
        finishedAt: cutoff - 1,
        status: "completed",
        errorCategory: null,
      })
      .run();
    db.insert(domainValidationAttempts)
      .values({
        id: "leased-attempt",
        runId: "leased-run",
        direction: "direct",
        attemptedAt: cutoff - 1,
        category: "connect_timeout",
        transportSuccess: false,
        httpStatus: null,
        resolvedAddress: "1.1.1.1",
        availableAddressCount: 1,
        connectDurationMs: null,
        tlsDurationMs: null,
        totalDurationMs: 1,
        redirectCount: 0,
        finalOrigin: "https://leased.service.example",
      })
      .run();
    db.insert(domainDecisions)
      .values({
        id: "leased-decision",
        fqdn: "leased.service.example",
        evaluatedAt: cutoff - 1,
        status: "pending",
        confidence: "low",
        reasons: ["insufficient-direct-failures"],
        windowStart: cutoff - 24 * 60 * 60 * 1_000,
        evidence: {
          directQualifyingFailures: 1,
          directSpacedFailures: 1,
          directAddressDiversityRequired: false,
          directAddressDiversitySatisfied: true,
          proxyHttpSuccesses: 0,
          proxyTransportFailures: 0,
          proxyUncertainFailures: 0,
        },
        selectedScope: "exact",
        proposedRule: "leased.service.example",
      })
      .run();

    expect(pruneDomainIntelligence(db, now)).toEqual({
      observations: 0,
      dailyStats: 0,
      candidates: 0,
      validationRuns: 0,
      validationAttempts: 0,
      decisions: 0,
    });
    expect(db.select().from(domainCandidates).all()).toHaveLength(1);
    expect(db.select().from(domainValidationRuns).all()).toHaveLength(1);
    expect(db.select().from(domainValidationAttempts).all()).toHaveLength(1);
    expect(db.select().from(domainDecisions).all()).toHaveLength(1);
  });

  it("keeps old candidates with running or boundary-fresh child rows", () => {
    const db = migratedDb();
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const cutoff = now - 14 * 24 * 60 * 60 * 1_000;
    insertCandidate(db, "running.service.example", cutoff - 1);
    insertCandidate(db, "fresh.service.example", cutoff - 1);
    db.insert(domainValidationRuns)
      .values([
        {
          id: "running-run",
          leaseId: "running-lease",
          leaseGeneration: 1,
          fqdn: "running.service.example",
          startedAt: cutoff - 1,
          finishedAt: null,
          status: "running",
          errorCategory: null,
        },
        {
          id: "fresh-run",
          leaseId: "fresh-lease",
          leaseGeneration: 1,
          fqdn: "fresh.service.example",
          startedAt: cutoff,
          finishedAt: cutoff,
          status: "completed",
          errorCategory: null,
        },
        {
          id: "old-run-with-fresh-attempt",
          leaseId: "fresh-lease",
          leaseGeneration: 1,
          fqdn: "fresh.service.example",
          startedAt: cutoff - 2,
          finishedAt: cutoff - 1,
          status: "completed",
          errorCategory: null,
        },
      ])
      .run();
    // Defensive retention: even a row inserted outside the strict service boundary
    // must not cascade-delete a fresh child attempt.
    db.insert(domainValidationAttempts)
      .values({
        id: "fresh-attempt-on-old-run",
        runId: "old-run-with-fresh-attempt",
        direction: "direct",
        attemptedAt: cutoff,
        category: "connect_timeout",
        transportSuccess: false,
        httpStatus: null,
        resolvedAddress: "1.1.1.1",
        availableAddressCount: 1,
        connectDurationMs: null,
        tlsDurationMs: null,
        totalDurationMs: 1,
        redirectCount: 0,
        finalOrigin: "https://fresh.service.example",
      })
      .run();
    db.insert(domainDecisions)
      .values({
        id: "fresh-decision",
        fqdn: "fresh.service.example",
        evaluatedAt: cutoff,
        status: "blocked",
        confidence: "none",
        reasons: ["invalid-policy"],
        windowStart: null,
        evidence: {
          directQualifyingFailures: 0,
          directSpacedFailures: 0,
          directAddressDiversityRequired: false,
          directAddressDiversitySatisfied: false,
          proxyHttpSuccesses: 0,
          proxyTransportFailures: 0,
          proxyUncertainFailures: 0,
        },
        selectedScope: "exact",
        proposedRule: "fresh.service.example",
      })
      .run();

    const result = pruneDomainIntelligence(db, now);
    expect(result.candidates).toBe(0);
    expect(result.validationRuns).toBe(0);
    expect(result.decisions).toBe(0);
    expect(db.select().from(domainCandidates).all()).toHaveLength(2);
    expect(db.select().from(domainValidationRuns).all()).toHaveLength(3);
    expect(db.select().from(domainValidationAttempts).all()).toHaveLength(1);
    expect(db.select().from(domainDecisions).all()).toHaveLength(1);
  });
});
