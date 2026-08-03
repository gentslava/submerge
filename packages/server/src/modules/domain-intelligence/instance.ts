import type { MihomoConnection, MihomoLogFrame } from "../../clients/mihomo.js";
import type { Db } from "../../db/client.js";
import {
  type DomainObservation,
  observationFromConnection,
  observationFromLogFrame,
} from "./observer.js";
import { recordObservation } from "./service.js";

interface DomainIntelligenceRuntimePart {
  start: () => void;
  stop: () => void | Promise<void>;
}

export function reconcileDomainIntelligenceRuntime(
  enabled: boolean,
  ...parts: readonly DomainIntelligenceRuntimePart[]
): Promise<void> {
  if (enabled) {
    for (const part of parts) part.start();
    return Promise.resolve();
  }
  const stops = [...parts].reverse().map((part) => part.stop());
  return Promise.all(stops).then(() => undefined);
}

interface DomainValidationRuntimePart extends DomainIntelligenceRuntimePart {
  wake: () => void;
}

export class DomainIntelligenceRuntimeLifecycle {
  private shuttingDown = false;
  private state: "initial" | "stopping" | "failed" | "disabled" | "enabled" = "initial";

  constructor(
    private readonly collectionParts: readonly DomainIntelligenceRuntimePart[],
    private readonly validationPart: DomainValidationRuntimePart,
  ) {}

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.shuttingDown) {
      if (this.state === "stopping" || this.state === "failed") {
        throw new Error("domain validation cleanup is incomplete");
      }
      this.state = "enabled";
      for (const part of this.collectionParts) part.start();
      this.validationPart.start();
      this.validationPart.wake();
      return;
    }

    if (this.state === "disabled" && !this.shuttingDown) {
      this.validationPart.start();
      return;
    }
    this.state = "stopping";

    const collectionStops = [...this.collectionParts].reverse().map((part) => part.stop());
    const validationStop = this.validationPart.stop();
    try {
      await Promise.all([...collectionStops, validationStop]);
    } catch (error) {
      this.state = "failed";
      throw error;
    }
    this.state = "disabled";
    if (!this.shuttingDown) this.validationPart.start();
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }
}

interface DomainIntelligenceObserverDeps {
  persistObservation: (observation: DomainObservation) => void;
  schedule?: (work: () => void) => void;
  onError?: (error: unknown) => void;
  capacity?: number;
}

export const DOMAIN_OBSERVATION_QUEUE_CAPACITY = 1_024;
const RECENT_LOG_OBSERVATION_CAPACITY = 2_048;

export class DomainIntelligenceObserver {
  private readonly persistObservation: DomainIntelligenceObserverDeps["persistObservation"];
  private readonly schedule: NonNullable<DomainIntelligenceObserverDeps["schedule"]>;
  private readonly onError?: DomainIntelligenceObserverDeps["onError"];
  private readonly capacity: number;
  private readonly pending = new Map<string, DomainObservation>();
  private readonly recentLogObservationsByFingerprint = new Map<string, DomainObservation>();
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
    this.recentLogObservationsByFingerprint.clear();
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
    if (!this.recentLogObservationsByFingerprint.has(observation.fingerprint)) {
      this.recentLogObservationsByFingerprint.set(observation.fingerprint, observation);
      if (this.recentLogObservationsByFingerprint.size > RECENT_LOG_OBSERVATION_CAPACITY) {
        const oldest = this.recentLogObservationsByFingerprint.keys().next().value;
        if (oldest !== undefined) this.recentLogObservationsByFingerprint.delete(oldest);
      }
    }
    this.enqueue(observation);
  }

  observeConnection(connection: MihomoConnection, snapshotAt: number): DomainObservation | null {
    if (!this.running) return null;
    let observation: DomainObservation | null;
    try {
      observation = observationFromConnection(connection, snapshotAt);
    } catch (error) {
      this.reportFailure(error);
      return null;
    }
    if (!observation) return null;
    this.enqueue(observation);
    return observation;
  }

  recentLogObservations(since: number): DomainObservation[] {
    if (!Number.isSafeInteger(since) || since < 0) return [];
    return [...this.recentLogObservationsByFingerprint.values()].filter(
      (observation) => observation.observedAt >= since,
    );
  }

  private enqueue(observation: DomainObservation): void {
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
