import type { DomainIntelligenceDeploymentCapability } from "@submerge/shared";
import type { ApplyResult } from "../nodes/service.js";

interface DomainRuleDeploymentLifecycleController {
  readCapability: () => DomainIntelligenceDeploymentCapability;
  reconcile: (signal?: AbortSignal) => Promise<ApplyResult>;
}

export class DomainRuleDeploymentLifecycle {
  private readonly abortController = new AbortController();
  private generation = 0;
  private recoveryNeeded = false;
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly controller: DomainRuleDeploymentLifecycleController) {}

  reconcile(): Promise<ApplyResult> {
    if (this.stopped) {
      const error = new Error("domain-rule deployment lifecycle is stopped");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    const generation = ++this.generation;
    this.recoveryNeeded = false;
    const operation = this.controller.reconcile(this.abortController.signal).then(
      (result) => {
        if (!this.stopped && generation === this.generation) {
          this.recoveryNeeded = this.requiresRecovery(result);
        }
        return result;
      },
      (error: unknown) => {
        if (!this.stopped && generation === this.generation) this.recoveryNeeded = true;
        throw error;
      },
    );
    this.track(operation);
    return operation;
  }

  async recoverIfNeeded(): Promise<ApplyResult | undefined> {
    while (true) {
      const pending = this.tail;
      await pending;
      if (pending === this.tail) break;
    }
    if (this.stopped || !this.recoveryNeeded) return undefined;
    return this.reconcile();
  }

  stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.generation += 1;
      this.recoveryNeeded = false;
      this.abortController.abort();
    }
    return this.tail.catch(() => undefined);
  }

  private requiresRecovery(result: ApplyResult): boolean {
    if (!result.applied || !result.activationVerified) return true;
    const capability = this.controller.readCapability();
    return capability.mode === "apply" && !capability.apply.available;
  }

  private track(operation: Promise<unknown>): void {
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
  }
}
