import type { MihomoLogFrame } from "../../clients/mihomo.js";
import type { Db } from "../../db/client.js";
import { type DomainObservation, observationFromLogFrame } from "./observer.js";
import { recordObservation } from "./service.js";

interface DomainIntelligenceObserverDeps {
  persistObservation: (observation: DomainObservation) => void;
  schedule?: (work: () => void) => void;
  onError?: (error: unknown) => void;
  capacity?: number;
}

export const DOMAIN_OBSERVATION_QUEUE_CAPACITY = 1_024;

export class DomainIntelligenceObserver {
  private readonly persistObservation: DomainIntelligenceObserverDeps["persistObservation"];
  private readonly schedule: NonNullable<DomainIntelligenceObserverDeps["schedule"]>;
  private readonly onError?: DomainIntelligenceObserverDeps["onError"];
  private readonly capacity: number;
  private readonly pending = new Map<string, DomainObservation>();
  private running = false;
  private generation = 0;
  private drainScheduled = false;
  private failureStreak = false;

  constructor(deps: DomainIntelligenceObserverDeps) {
    const capacity = deps.capacity ?? DOMAIN_OBSERVATION_QUEUE_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("domain observation queue capacity must be a positive integer");
    }
    this.persistObservation = deps.persistObservation;
    this.schedule = deps.schedule ?? ((work) => void setImmediate(work));
    this.onError = deps.onError;
    this.capacity = capacity;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
  }

  stop(): void {
    if (!this.running && this.pending.size === 0) return;
    this.running = false;
    this.generation += 1;
    this.pending.clear();
    this.drainScheduled = false;
    this.failureStreak = false;
  }

  observeLogFrame(frame: MihomoLogFrame, observedAt: number): void {
    if (!this.running) return;

    let observation: DomainObservation | null;
    try {
      observation = observationFromLogFrame(frame, observedAt);
    } catch (error) {
      this.reportFailure(error);
      return;
    }
    if (!observation) return;

    if (this.pending.has(observation.fingerprint)) {
      this.ensureDrain();
      return;
    }
    if (this.pending.size >= this.capacity) {
      this.ensureDrain();
      this.reportFailure(new Error("domain observation queue capacity exceeded"));
      return;
    }
    this.pending.set(observation.fingerprint, observation);
    this.ensureDrain();
  }

  private ensureDrain(): void {
    if (!this.running || this.drainScheduled || this.pending.size === 0) return;
    this.drainScheduled = true;
    this.scheduleDrain(this.generation);
  }

  private scheduleDrain(generation: number): void {
    try {
      this.schedule(() => this.drainOne(generation));
    } catch (error) {
      if (this.generation === generation) this.drainScheduled = false;
      this.reportFailure(error);
    }
  }

  private drainOne(generation: number): void {
    if (!this.running || this.generation !== generation) return;
    const next = this.pending.entries().next();
    if (next.done) {
      this.drainScheduled = false;
      return;
    }

    const [fingerprint, observation] = next.value;
    this.pending.delete(fingerprint);
    try {
      this.persistObservation(observation);
      this.failureStreak = false;
    } catch (error) {
      this.reportFailure(error);
    }

    if (!this.running || this.generation !== generation) return;
    if (this.pending.size === 0) {
      this.drainScheduled = false;
      return;
    }
    this.scheduleDrain(generation);
  }

  private reportFailure(error: unknown): void {
    if (this.failureStreak) return;
    this.failureStreak = true;
    try {
      this.onError?.(error);
    } catch {
      // Error reporting must not escape into the Mihomo log pump.
    }
  }
}

export function createDomainIntelligenceObserver(
  db: Db,
  onError?: (error: unknown) => void,
): DomainIntelligenceObserver {
  return new DomainIntelligenceObserver({
    persistObservation: (observation) => {
      recordObservation(db, observation);
    },
    ...(onError ? { onError } : {}),
  });
}
