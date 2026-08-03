import type { MihomoConnection } from "../../clients/mihomo.js";
import {
  canReconcileObservations,
  type DomainObservation,
  OBSERVATION_RECONCILIATION_WINDOW_MS,
  observationFromConnection,
} from "./observer.js";

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
