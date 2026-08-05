import { DomainRuleOperationDeferredError } from "./apply-errors.js";
import type {
  DomainRuleApplyOperationResult,
  ExecuteDomainRuleOperationOptions,
} from "./apply-operation.js";

interface UnfinishedDomainRuleOperation {
  id: string;
}

export interface DomainRuleApplyWorkerDependencies {
  isEnabled: () => boolean;
  listUnfinished: () => readonly UnfinishedDomainRuleOperation[];
  execute: (
    operationId: string,
    signal: AbortSignal,
    options?: ExecuteDomainRuleOperationOptions,
  ) => Promise<DomainRuleApplyOperationResult>;
  onError: (error: unknown, operationId: string | null) => void;
  onReady?: () => void;
}

export type DomainRuleApplyWorkerHealth = {
  status:
    | "disabled"
    | "recovering"
    | "ready"
    | "recovery-required"
    | "failed"
    | "stopping"
    | "stopped";
  accepting: boolean;
};

type WorkerState = DomainRuleApplyWorkerHealth["status"];

/**
 * Owns the process-wide domain-rule mutation lock. Startup reconciliation and
 * newly submitted work share one tail, while wake() always crosses a timer
 * boundary so a validation caller can release its lease before config reload.
 */
export class DomainRuleApplyWorker {
  private readonly abortController = new AbortController();
  private startup: Promise<void> | null = null;
  private state: WorkerState = "disabled";
  private tail: Promise<void> = Promise.resolve();
  private drainScheduled = false;
  private wakeRequested = false;
  private admissionEpoch = 0;

  constructor(private readonly dependencies: DomainRuleApplyWorkerDependencies) {}

  start(): Promise<void> {
    if (this.startup) return this.startup;
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(this.stoppedError());
    }
    if (!this.dependencies.isEnabled()) {
      this.state = "disabled";
      this.startup = Promise.resolve();
      return this.startup;
    }

    this.state = "recovering";
    const recovery = this.enqueueExclusive(async () => {
      await this.executeSnapshot();
    });
    this.startup = recovery.then(
      () => {
        if (this.state === "recovering" && !this.drainScheduled && !this.wakeRequested) {
          this.becomeReady();
        }
      },
      (error: unknown) => {
        this.fail(error, null);
        throw error;
      },
    );
    return this.startup;
  }

  health(): DomainRuleApplyWorkerHealth {
    const disabled = this.state === "ready" && !this.dependencies.isEnabled();
    const status = disabled ? "disabled" : this.state;
    return { status, accepting: status === "ready" };
  }

  /** Coalesced durable-queue wake; intentionally never executes inline. */
  wake(): boolean {
    if (!this.canWake()) return false;
    this.wakeRequested = true;
    this.state = "recovering";
    // Reserve a tail slot synchronously so a later submit cannot overtake the
    // durable wake. The slot itself waits for a timer boundary before reading
    // SQLite, allowing the validation caller to release its lease first.
    this.scheduleDrain();
    return true;
  }

  /**
   * Prepare and execute one mutation under the same global lock. Preparation
   * failures remain local; once an operation exists, execution failures fence
   * the worker until restart/reconciliation.
   */
  submit(
    prepare: (signal: AbortSignal) => string | Promise<string>,
  ): Promise<DomainRuleApplyOperationResult> {
    if (!this.isAccepting()) return Promise.reject(this.notAcceptingError());
    const admittedAt = this.admissionEpoch;
    return this.enqueueExclusive(async (signal) => {
      signal.throwIfAborted();
      if (!this.dependencies.isEnabled() || admittedAt !== this.admissionEpoch) {
        throw this.notAcceptingError();
      }
      const operationId = await prepare(signal);
      signal.throwIfAborted();
      const result = await this.executeOne(operationId, signal);
      signal.throwIfAborted();
      if (result.phase === "partial") this.requireRecovery();
      return result;
    });
  }

  /** Serialize deployment and authorization mutations with local publication. */
  serializeMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.reject(this.stoppedError());
    }
    return this.enqueueSerialized(async () => mutation());
  }

  async whenIdle(): Promise<void> {
    while (true) {
      const pending = this.tail;
      await pending;
      if (pending === this.tail) return;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.wakeRequested = false;
    this.abortController.abort();
    await this.startup?.catch(() => undefined);
    await this.tail;
    this.state = "stopped";
  }

  private async executeSnapshot(): Promise<boolean> {
    const operations = this.dependencies.listUnfinished();
    for (const operation of operations) {
      this.abortController.signal.throwIfAborted();
      let result: DomainRuleApplyOperationResult;
      try {
        result = await this.executeOne(operation.id, this.abortController.signal);
      } catch (error) {
        if (error instanceof DomainRuleOperationDeferredError) {
          return false;
        }
        throw error;
      }
      this.abortController.signal.throwIfAborted();
      if (result.phase === "partial") {
        this.requireRecovery();
        return false;
      }
    }
    return true;
  }

  private async executeOne(
    operationId: string,
    signal: AbortSignal,
  ): Promise<DomainRuleApplyOperationResult> {
    try {
      return await this.dependencies.execute(operationId, signal);
    } catch (error) {
      if (error instanceof DomainRuleOperationDeferredError) {
        this.requireRecovery();
        throw error;
      }
      this.fail(error, operationId);
      throw error;
    }
  }

  private enqueueExclusive<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.enqueueSerialized(() => task(this.abortController.signal));
  }

  private enqueueSerialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isAccepting(): boolean {
    return this.state === "ready" && this.dependencies.isEnabled();
  }

  private canWake(): boolean {
    return (
      (this.state === "ready" ||
        this.state === "recovering" ||
        this.state === "recovery-required") &&
      this.dependencies.isEnabled()
    );
  }

  private requireRecovery(): void {
    this.admissionEpoch += 1;
    this.state = "recovery-required";
  }

  private becomeReady(): void {
    this.state = "ready";
    try {
      this.dependencies.onReady?.();
    } catch {
      // Readiness notification is advisory and cannot poison durable recovery.
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    this.state = "recovering";
    const pass = this.enqueueExclusive(async (signal) => {
      await this.waitForTimerBoundary(signal);
      while (this.wakeRequested) {
        signal.throwIfAborted();
        if (!this.dependencies.isEnabled()) {
          this.state = "disabled";
          return;
        }
        this.wakeRequested = false;
        const recovered = await this.executeSnapshot();
        if (!recovered) return;
        if (this.wakeRequested) await this.waitForTimerBoundary(signal);
      }
      if (this.state === "recovering") this.becomeReady();
    });
    void pass.then(
      () => {
        this.drainScheduled = false;
        if (this.wakeRequested && this.canWake()) this.scheduleDrain();
      },
      (error: unknown) => {
        this.drainScheduled = false;
        this.fail(error, null);
      },
    );
  }

  private waitForTimerBoundary(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 0);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private fail(error: unknown, operationId: string | null): void {
    if (this.state === "failed" || this.state === "stopping" || this.state === "stopped") return;
    this.state = "failed";
    this.wakeRequested = false;
    this.abortController.abort();
    this.dependencies.onError(error, operationId);
  }

  private notAcceptingError(): Error {
    return new Error("domain-rule apply worker is not accepting work");
  }

  private stoppedError(): Error {
    const error = new Error("domain-rule apply worker is stopped");
    error.name = "AbortError";
    return error;
  }
}
