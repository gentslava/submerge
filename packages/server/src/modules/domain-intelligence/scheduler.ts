import { randomInt, randomUUID } from "node:crypto";
import type { MihomoConnection } from "../../clients/mihomo.js";
import type { Db } from "../../db/client.js";
import type { DomainValidationRunErrorCategory } from "../../db/schema.js";
import type { CandidateDecision } from "./decision.js";
import {
  canReconcileObservations,
  type DomainObservation,
  OBSERVATION_RECONCILIATION_WINDOW_MS,
  observationFromConnection,
} from "./observer.js";
import type { DirectProbeResult, ProxyProbeResult } from "./probe.js";
import {
  claimDomainValidationRun,
  completeDomainValidationRun,
  type DueDomainCandidate,
  domainValidationCircuitState,
  failDomainValidationRun,
  listDueDomainCandidates,
  pruneDomainIntelligence,
  recoverExpiredDomainValidationRuns,
} from "./service.js";

export const DOMAIN_SNAPSHOT_INTERVAL_MS = 5_000;
const PENDING_CORRELATION_CAPACITY = 2_048;

export interface SnapshotObservationSink {
  observeConnection(connection: MihomoConnection, snapshotAt: number): DomainObservation | null;
  recentLogObservations(since: number): readonly DomainObservation[];
}

export type DomainObserverHealthStatus = "inactive" | "accumulating" | "healthy" | "degraded";
export type DomainObserverHealthReason =
  | "disabled"
  | "awaiting-domain-traffic"
  | "awaiting-correlation"
  | "correlated"
  | "parser-drift"
  | "snapshot-error";

export interface DomainObserverHealth {
  status: DomainObserverHealthStatus;
  reason: DomainObserverHealthReason;
  snapshotDomainConnections: number;
  correlatedConnections: number;
  updatedAt: number;
}

interface DomainIntelligenceSchedulerDeps {
  fetchConnections: (signal: AbortSignal) => Promise<MihomoConnection[]>;
  observer: SnapshotObservationSink;
  now?: () => number;
  intervalMs?: number;
  onHealth?: (health: DomainObserverHealth) => void;
}

interface ActivePulse {
  generation: number;
  promise: Promise<void>;
}

interface PendingCorrelation {
  observation: DomainObservation;
  firstSeenAt: number;
}

export class DomainIntelligenceScheduler {
  private readonly fetchConnections: DomainIntelligenceSchedulerDeps["fetchConnections"];
  private readonly observer: SnapshotObservationSink;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly onHealth?: DomainIntelligenceSchedulerDeps["onHealth"];
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private activePulse: ActivePulse | null = null;
  private previousConnectionIds = new Set<string>();
  private readonly pendingCorrelations = new Map<string, PendingCorrelation>();
  private lastSuccessfulPulseAt: number | null = null;
  private hasCorrelatedEvidence = false;
  private parserDriftActive = false;
  private currentHealth: DomainObserverHealth;

  constructor(deps: DomainIntelligenceSchedulerDeps) {
    const intervalMs = deps.intervalMs ?? DOMAIN_SNAPSHOT_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new RangeError("domain snapshot interval must be a positive integer");
    }
    this.fetchConnections = deps.fetchConnections;
    this.observer = deps.observer;
    this.now = deps.now ?? Date.now;
    this.intervalMs = intervalMs;
    this.onHealth = deps.onHealth;
    this.currentHealth = {
      status: "inactive",
      reason: "disabled",
      snapshotDomainConnections: 0,
      correlatedConnections: 0,
      updatedAt: this.now(),
    };
  }

  start(): void {
    if (this.controller) return;
    this.generation += 1;
    this.controller = new AbortController();
    this.previousConnectionIds.clear();
    this.pendingCorrelations.clear();
    this.lastSuccessfulPulseAt = null;
    this.hasCorrelatedEvidence = false;
    this.parserDriftActive = false;
    this.setHealth({
      status: "accumulating",
      reason: "awaiting-domain-traffic",
      snapshotDomainConnections: 0,
      correlatedConnections: 0,
      updatedAt: this.now(),
    });
    void this.tick(this.controller, this.generation);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
    this.previousConnectionIds.clear();
    this.pendingCorrelations.clear();
    this.lastSuccessfulPulseAt = null;
    this.hasCorrelatedEvidence = false;
    this.parserDriftActive = false;
    this.setHealth({
      status: "inactive",
      reason: "disabled",
      snapshotDomainConnections: 0,
      correlatedConnections: 0,
      updatedAt: this.now(),
    });
  }

  pulseOnce(): Promise<void> {
    const controller = this.controller;
    if (!controller) return Promise.resolve();
    return this.runPulse(controller, this.generation);
  }

  health(): DomainObserverHealth {
    return { ...this.currentHealth };
  }

  private async tick(controller: AbortController, generation: number): Promise<void> {
    await this.runPulse(controller, generation);
    if (this.controller !== controller || this.generation !== generation) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick(controller, generation);
    }, this.intervalMs);
  }

  private runPulse(controller: AbortController, generation: number): Promise<void> {
    const active = this.activePulse;
    if (active) {
      if (active.generation === generation) return active.promise;
      return active.promise.then(() => {
        if (this.controller !== controller || this.generation !== generation) return;
        return this.runPulse(controller, generation);
      });
    }

    const promise = this.performPulse(controller, generation).finally(() => {
      if (this.activePulse?.promise === promise) this.activePulse = null;
    });
    this.activePulse = { generation, promise };
    return promise;
  }

  private async performPulse(controller: AbortController, generation: number): Promise<void> {
    try {
      const connections = await this.fetchConnections(controller.signal);
      if (this.controller !== controller || this.generation !== generation) return;
      const snapshotAt = this.now();
      const valid = connections.flatMap((connection) => {
        const observation = observationFromConnection(connection, snapshotAt);
        return observation ? [{ connection, observation }] : [];
      });
      const newValid = valid.filter(
        ({ connection }) =>
          this.lastSuccessfulPulseAt === null || !this.previousConnectionIds.has(connection.id),
      );
      for (const { connection } of newValid) {
        this.observer.observeConnection(connection, snapshotAt);
      }

      const previousPulseAt = this.lastSuccessfulPulseAt;
      this.previousConnectionIds = new Set(valid.map(({ connection }) => connection.id));
      this.lastSuccessfulPulseAt = snapshotAt;
      if (previousPulseAt === null) {
        this.setHealth({
          status: "accumulating",
          reason: valid.length > 0 ? "awaiting-correlation" : "awaiting-domain-traffic",
          snapshotDomainConnections: valid.length,
          correlatedConnections: 0,
          updatedAt: snapshotAt,
        });
        return;
      }

      for (const { observation } of newValid) {
        if (this.pendingCorrelations.has(observation.fingerprint)) continue;
        if (this.pendingCorrelations.size >= PENDING_CORRELATION_CAPACITY) {
          this.parserDriftActive = true;
          break;
        }
        this.pendingCorrelations.set(observation.fingerprint, {
          observation,
          firstSeenAt: snapshotAt,
        });
      }

      const earliestPendingStart = Math.min(
        ...[...this.pendingCorrelations.values()].map(({ observation }) => observation.observedAt),
        snapshotAt,
      );
      const availableLogs = [
        ...this.observer.recentLogObservations(
          Math.max(0, earliestPendingStart - OBSERVATION_RECONCILIATION_WINDOW_MS),
        ),
      ];
      let correlatedConnections = 0;
      for (const [fingerprint, pending] of this.pendingCorrelations) {
        const matchIndex = availableLogs.findIndex((log) =>
          canReconcileObservations(log, pending.observation),
        );
        if (matchIndex < 0) continue;
        correlatedConnections += 1;
        this.pendingCorrelations.delete(fingerprint);
        availableLogs.splice(matchIndex, 1);
      }

      let expiredConnections = 0;
      for (const [fingerprint, pending] of this.pendingCorrelations) {
        if (snapshotAt - pending.firstSeenAt < OBSERVATION_RECONCILIATION_WINDOW_MS) continue;
        expiredConnections += 1;
        this.pendingCorrelations.delete(fingerprint);
      }
      if (expiredConnections > 0) this.parserDriftActive = true;
      if (correlatedConnections > 0) {
        this.hasCorrelatedEvidence = true;
        this.parserDriftActive = false;
      }

      const status: DomainObserverHealthStatus = this.parserDriftActive
        ? "degraded"
        : this.hasCorrelatedEvidence
          ? "healthy"
          : "accumulating";
      const reason: DomainObserverHealthReason = this.parserDriftActive
        ? "parser-drift"
        : this.hasCorrelatedEvidence
          ? "correlated"
          : this.pendingCorrelations.size > 0 || valid.length > 0
            ? "awaiting-correlation"
            : "awaiting-domain-traffic";
      this.setHealth({
        status,
        reason,
        snapshotDomainConnections: valid.length,
        correlatedConnections,
        updatedAt: snapshotAt,
      });
    } catch {
      if (
        this.controller !== controller ||
        this.generation !== generation ||
        controller.signal.aborted
      )
        return;
      this.setHealth({
        status: "degraded",
        reason: "snapshot-error",
        snapshotDomainConnections: 0,
        correlatedConnections: 0,
        updatedAt: this.now(),
      });
    }
  }

  private setHealth(health: DomainObserverHealth): void {
    this.currentHealth = health;
    try {
      this.onHealth?.({ ...health });
    } catch {
      // Health reporting is best-effort and cannot stop the snapshot pulse.
    }
  }
}

export const DOMAIN_VALIDATION_PULSE_MS = 60_000;
export const DOMAIN_VALIDATION_COOLDOWN_MS = 2 * 60 * 60 * 1_000;
export const DOMAIN_VALIDATION_MAX_CANDIDATES_PER_RUN = 20;
export const DOMAIN_VALIDATION_MAX_CONCURRENCY = 2;
export const DOMAIN_VALIDATION_WORK_TIMEOUT_MS = 2 * 60_000;
export const DOMAIN_VALIDATION_CIRCUIT_FAILURE_THRESHOLD = 3;
export const DOMAIN_VALIDATION_CIRCUIT_OPEN_MS = 15 * 60_000;
const DOMAIN_VALIDATION_LEASE_MS = 10 * 60_000;
const DOMAIN_VALIDATION_MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000;
const DOMAIN_VALIDATION_MAX_JITTER_MS = 5 * 60_000;
const DOMAIN_VALIDATION_RATE_WINDOW_MS = 60_000;
const DOMAIN_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DOMAIN_OPERATIONAL_RETENTION_MS = 14 * DOMAIN_RETENTION_INTERVAL_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;

export type DomainValidationExecutorFailureCategory = Extract<
  DomainValidationRunErrorCategory,
  | "coverage-failure"
  | "direct-probe-failure"
  | "proxy-probe-failure"
  | "decision-failure"
  | "infrastructure-failure"
>;

export class DomainValidationSchedulerError extends Error {
  readonly category: DomainValidationExecutorFailureCategory;

  constructor(category: DomainValidationExecutorFailureCategory) {
    super("domain validation operation failed");
    this.name = "DomainValidationSchedulerError";
    this.category = category;
  }
}

export interface DomainValidationExecution {
  attempts: readonly [
    { attemptedAt: number; result: DirectProbeResult },
    { attemptedAt: number; result: ProxyProbeResult },
  ];
  decision: {
    evaluatedAt: number;
    value: CandidateDecision;
    selectedScope: "exact" | "site";
    proposedRule: string;
  };
}

export interface DomainValidationSchedulerDeps {
  db: Db;
  isEnabled: () => boolean;
  execute: (
    candidate: DueDomainCandidate,
    signal: AbortSignal,
  ) => Promise<DomainValidationExecution>;
  now?: () => number;
  pulseMs?: number;
  maximumCandidatesPerRun?: number;
  maxConcurrency?: number;
  workTimeoutMs?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
  jitterMs?: () => number;
  idFactory?: (kind: "lease" | "run" | "direct" | "proxy" | "decision") => string;
  onError?: (error: unknown) => void;
}

interface ActiveValidationRun {
  generation: number | null;
  promise: Promise<void>;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside the supported range`);
  }
  return value;
}

function safeFutureTimestamp(now: number, delayMs: number): number {
  return Math.min(MAX_DATE_MS, now + delayMs);
}

function failureBackoffMs(failureStreak: number): number {
  const exponent = Math.min(Math.max(0, failureStreak - 1), 16);
  return Math.min(DOMAIN_VALIDATION_MAX_BACKOFF_MS, DOMAIN_VALIDATION_COOLDOWN_MS * 2 ** exponent);
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export class DomainValidationScheduler {
  private readonly db: Db;
  private readonly isEnabled: () => boolean;
  private readonly executeValidation: DomainValidationSchedulerDeps["execute"];
  private readonly now: () => number;
  private readonly pulseMs: number;
  private readonly maximumCandidatesPerRun: number;
  private readonly maxConcurrency: number;
  private readonly workTimeoutMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly idFactory: NonNullable<DomainValidationSchedulerDeps["idFactory"]>;
  private readonly jitterMs: () => number;
  private readonly onError: DomainValidationSchedulerDeps["onError"];
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: ActiveValidationRun | null = null;
  private manualController: AbortController | null = null;
  private generation = 0;
  private lastRetentionAt: number | null = null;
  private failureReported = false;
  private wakeRequested = false;
  private wakeDrain: Promise<void> | null = null;

  constructor(deps: DomainValidationSchedulerDeps) {
    this.db = deps.db;
    this.isEnabled = deps.isEnabled;
    this.executeValidation = deps.execute;
    this.now = deps.now ?? Date.now;
    this.pulseMs = boundedInteger(
      deps.pulseMs ?? DOMAIN_VALIDATION_PULSE_MS,
      1,
      DOMAIN_RETENTION_INTERVAL_MS,
      "domain validation pulse",
    );
    this.maximumCandidatesPerRun = boundedInteger(
      deps.maximumCandidatesPerRun ?? DOMAIN_VALIDATION_MAX_CANDIDATES_PER_RUN,
      1,
      DOMAIN_VALIDATION_MAX_CANDIDATES_PER_RUN,
      "domain validation run capacity",
    );
    this.maxConcurrency = boundedInteger(
      deps.maxConcurrency ??
        Math.min(DOMAIN_VALIDATION_MAX_CONCURRENCY, this.maximumCandidatesPerRun),
      1,
      this.maximumCandidatesPerRun,
      "domain validation concurrency",
    );
    this.workTimeoutMs = boundedInteger(
      deps.workTimeoutMs ?? DOMAIN_VALIDATION_WORK_TIMEOUT_MS,
      1,
      DOMAIN_VALIDATION_LEASE_MS - 1,
      "domain validation timeout",
    );
    this.circuitFailureThreshold = boundedInteger(
      deps.circuitFailureThreshold ?? DOMAIN_VALIDATION_CIRCUIT_FAILURE_THRESHOLD,
      1,
      100,
      "domain validation circuit threshold",
    );
    this.circuitOpenMs = boundedInteger(
      deps.circuitOpenMs ?? DOMAIN_VALIDATION_CIRCUIT_OPEN_MS,
      1,
      DOMAIN_RETENTION_INTERVAL_MS,
      "domain validation circuit duration",
    );
    this.idFactory = deps.idFactory ?? ((kind) => `${kind}_${randomUUID()}`);
    this.jitterMs = deps.jitterMs ?? (() => randomInt(0, DOMAIN_VALIDATION_MAX_JITTER_MS + 1));
    this.onError = deps.onError;
  }

  runOnce(): Promise<void> {
    const scheduledController = this.controller;
    if (scheduledController) return this.run(this.generation, scheduledController);
    const existingManualController = this.manualController;
    if (existingManualController) return this.run(null, existingManualController);
    const controller = new AbortController();
    this.manualController = controller;
    const promise = this.run(null, controller).finally(() => {
      if (this.manualController === controller) this.manualController = null;
    });
    return promise;
  }

  start(): void {
    if (this.controller) return;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.wakeRequested = false;
    void this.run(generation, controller).catch(() => this.reportFailure());
    this.scheduleNext(controller, generation);
  }

  wake(): void {
    const controller = this.controller;
    if (!controller) return;
    this.wakeRequested = true;
    if (this.wakeDrain) return;
    const generation = this.generation;
    const drain = this.drainWakes(controller, generation).finally(() => {
      if (this.wakeDrain === drain) this.wakeDrain = null;
    });
    this.wakeDrain = drain;
    void drain;
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    const manualController = this.manualController;
    if (!controller && !manualController) return;
    this.controller = null;
    this.manualController = null;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wakeRequested = false;
    controller?.abort(new Error("domain validation scheduler stopped"));
    manualController?.abort(new Error("domain validation scheduler stopped"));
    const active = this.activeRun?.promise ?? null;
    await Promise.all([active?.catch(() => undefined), this.wakeDrain?.catch(() => undefined)]);
  }

  private async drainWakes(controller: AbortController, generation: number): Promise<void> {
    while (
      this.wakeRequested &&
      this.controller === controller &&
      this.generation === generation &&
      !controller.signal.aborted
    ) {
      const active = this.activeRun;
      if (active) await active.promise.catch(() => undefined);
      if (
        this.controller !== controller ||
        this.generation !== generation ||
        controller.signal.aborted
      ) {
        return;
      }
      if (!this.wakeRequested) return;
      this.wakeRequested = false;
      await this.run(generation, controller).catch(() => this.reportFailure());
    }
  }

  private scheduleNext(controller: AbortController, generation: number): void {
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.run(generation, controller).catch(() => this.reportFailure());
      if (this.controller === controller && this.generation === generation) {
        this.scheduleNext(controller, generation);
      }
    }, this.pulseMs);
  }

  private run(generation: number | null, controller: AbortController): Promise<void> {
    const active = this.activeRun;
    if (active) {
      if (generation === null || active.generation === generation) return active.promise;
      const afterActive = () => {
        if (
          this.controller !== controller ||
          generation === null ||
          this.generation !== generation
        ) {
          return Promise.resolve();
        }
        return this.run(generation, controller);
      };
      return active.promise.then(afterActive, afterActive);
    }

    const promise = this.executeRun(controller.signal).finally(() => {
      if (this.activeRun?.promise === promise) this.activeRun = null;
    });
    this.activeRun = { generation, promise };
    return promise;
  }

  private async executeRun(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const now = this.now();
    recoverExpiredDomainValidationRuns(this.db, { now, limit: 1_000 });
    if (
      now >= DOMAIN_OPERATIONAL_RETENTION_MS &&
      (this.lastRetentionAt === null || now - this.lastRetentionAt >= DOMAIN_RETENTION_INTERVAL_MS)
    ) {
      pruneDomainIntelligence(this.db, now);
      this.lastRetentionAt = now;
    }
    if (!this.isEnabled()) return;
    if (this.circuitState(now).open) return;
    const due = listDueDomainCandidates(this.db, {
      now,
      limit: this.maximumCandidatesPerRun,
    });
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        if (!this.isEnabled()) return;
        if (this.circuitState(this.now()).open) return;
        const candidate = due[cursor];
        cursor += 1;
        if (!candidate) return;
        if (this.circuitState(this.now()).open) return;
        const outcome = await this.validateCandidate(candidate, signal);
        if (outcome === "rate-limited") return;
      }
    };
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(this.maxConcurrency, due.length) }, () => worker()),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      throw new Error("domain validation scheduler worker failed");
    }
  }

  private circuitState(now: number) {
    return domainValidationCircuitState(this.db, {
      now,
      failureThreshold: this.circuitFailureThreshold,
      openMs: this.circuitOpenMs,
    });
  }

  private nextDelay(baseMs: number): number {
    let jitter: number;
    try {
      jitter = this.jitterMs();
    } catch {
      jitter = DOMAIN_VALIDATION_MAX_JITTER_MS;
    }
    const safeJitter =
      Number.isSafeInteger(jitter) && jitter >= 0 && jitter <= DOMAIN_VALIDATION_MAX_JITTER_MS
        ? jitter
        : DOMAIN_VALIDATION_MAX_JITTER_MS;
    return Math.min(DOMAIN_VALIDATION_MAX_BACKOFF_MS, baseMs + safeJitter);
  }

  private async validateCandidate(
    candidate: DueDomainCandidate,
    schedulerSignal: AbortSignal,
  ): Promise<"completed" | "rate-limited" | "unavailable"> {
    const startedAt = this.now();
    const leaseId = this.idFactory("lease");
    const runId = this.idFactory("run");
    const claim = claimDomainValidationRun(this.db, {
      runId,
      fqdn: candidate.fqdn,
      leaseId,
      now: startedAt,
      leaseUntil: safeFutureTimestamp(startedAt, DOMAIN_VALIDATION_LEASE_MS),
      rateWindowMs: DOMAIN_VALIDATION_RATE_WINDOW_MS,
      maximumStarts: this.maximumCandidatesPerRun,
    });
    if (claim.status !== "claimed") return claim.status;

    const workController = new AbortController();
    const forwardAbort = () => workController.abort(schedulerSignal.reason);
    schedulerSignal.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(
      () => workController.abort(new Error("domain validation timed out")),
      this.workTimeoutMs,
    );
    try {
      const execution = await Promise.race([
        this.executeValidation(candidate, workController.signal),
        abortPromise(workController.signal),
      ]);
      if (schedulerSignal.aborted) throw schedulerSignal.reason;
      if (workController.signal.aborted) {
        throw new DomainValidationSchedulerError("infrastructure-failure");
      }
      const finishedAt = this.now();
      completeDomainValidationRun(this.db, {
        runId,
        leaseId,
        leaseGeneration: claim.leaseGeneration,
        finishedAt,
        nextValidationAt: safeFutureTimestamp(
          finishedAt,
          this.nextDelay(DOMAIN_VALIDATION_COOLDOWN_MS),
        ),
        failureStreak: 0,
        attempts: [
          { id: this.idFactory("direct"), ...execution.attempts[0] },
          { id: this.idFactory("proxy"), ...execution.attempts[1] },
        ],
        decision: {
          id: this.idFactory("decision"),
          ...execution.decision,
        },
      });
      this.failureReported = false;
    } catch (error) {
      const shutdown = schedulerSignal.aborted;
      const category: DomainValidationRunErrorCategory = shutdown
        ? "shutdown"
        : error instanceof DomainValidationSchedulerError
          ? error.category
          : "infrastructure-failure";
      const finishedAt = Math.max(startedAt, this.now());
      const failureStreak = shutdown
        ? candidate.failureStreak
        : Math.min(1_000_000, candidate.failureStreak + 1);
      try {
        failDomainValidationRun(this.db, {
          runId,
          leaseId,
          leaseGeneration: claim.leaseGeneration,
          finishedAt,
          status: shutdown ? "cancelled" : "failed",
          errorCategory: category,
          nextValidationAt: safeFutureTimestamp(
            finishedAt,
            this.nextDelay(failureBackoffMs(failureStreak || 1)),
          ),
          failureStreak,
        });
      } catch {
        if (!shutdown) this.reportFailure();
        return "completed";
      }
      if (!shutdown) this.reportFailure();
    } finally {
      clearTimeout(timeout);
      schedulerSignal.removeEventListener("abort", forwardAbort);
    }
    return "completed";
  }

  private reportFailure(): void {
    if (this.failureReported) return;
    this.failureReported = true;
    try {
      this.onError?.(new Error("domain validation scheduler failed"));
    } catch {
      // Reporting must not escape into a scheduler pulse or reveal the source error.
    }
  }
}
