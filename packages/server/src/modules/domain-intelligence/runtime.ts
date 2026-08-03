import {
  type DomainIntelligenceSettingsMutationResult,
  type DomainIntelligenceSettingsView,
  domainIntelligenceSettingsMutationResultSchema,
} from "@submerge/shared";

interface DomainIntelligenceRuntimeCoordinatorDeps {
  readSettings: () => DomainIntelligenceSettingsView;
  applyCurrentConfig: () => Promise<{ applied: boolean; activationVerified: boolean }>;
  canEnableRuntime?: () => boolean;
  setRuntimeEnabled: (enabled: boolean) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export class DomainIntelligenceRuntimeCoordinator {
  private readonly deps: DomainIntelligenceRuntimeCoordinatorDeps;
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private stopped = false;
  private recoveryNeeded = false;
  private activationVerified = false;

  constructor(deps: DomainIntelligenceRuntimeCoordinatorDeps) {
    this.deps = deps;
  }

  reconcile(): Promise<DomainIntelligenceSettingsMutationResult> {
    const generation = ++this.generation;
    this.recoveryNeeded = false;
    const suspended = this.setRuntimeEnabled(false);
    const operation = this.tail.then(
      () => this.apply(generation, suspended),
      () => this.apply(generation, suspended),
    );
    this.track(operation);
    return operation;
  }

  runConfigApply<T extends { applied: boolean; activationVerified: boolean }>(
    apply: () => Promise<T>,
  ): Promise<T> {
    const generation = ++this.generation;
    this.recoveryNeeded = false;
    const suspended = this.setRuntimeEnabled(false);
    const operation = this.tail.then(
      () => this.applyExternal(generation, suspended, apply),
      () => this.applyExternal(generation, suspended, apply),
    );
    this.track(operation);
    return operation;
  }

  async recoverIfNeeded(): Promise<DomainIntelligenceSettingsMutationResult | undefined> {
    // A first healthy poll can arrive while the boot apply is still pending.
    // Wait for that exact operation before deciding whether availability must
    // trigger a retry. A newer settings mutation either clears the flag or
    // supersedes the retry through the generation fence in reconcile().
    await this.tail;
    if (this.stopped || !this.recoveryNeeded) return undefined;
    return this.reconcile();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.recoveryNeeded = false;
    const suspended = this.setRuntimeEnabled(false);
    const operation = Promise.all([this.tail.catch(() => undefined), suspended]).then(
      () => undefined,
    );
    this.track(operation);
    return operation;
  }

  private track(operation: Promise<unknown>): void {
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
  }

  private setRuntimeEnabled(enabled: boolean): Promise<void> {
    try {
      return Promise.resolve(this.deps.setRuntimeEnabled(enabled));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async apply(
    generation: number,
    suspended: Promise<void>,
  ): Promise<DomainIntelligenceSettingsMutationResult> {
    try {
      await suspended;
    } catch (error) {
      this.deps.onError?.(error);
      return domainIntelligenceSettingsMutationResultSchema.parse({
        view: this.deps.readSettings(),
        applied: false,
      });
    }
    let applied = false;
    if (!this.stopped) {
      try {
        const result = await this.deps.applyCurrentConfig();
        applied = result.applied;
        this.activationVerified = result.applied && result.activationVerified;
      } catch (error) {
        this.activationVerified = false;
        this.deps.onError?.(error);
      }
    }
    const effectiveApplied = await this.finishTransition(generation, applied);
    return domainIntelligenceSettingsMutationResultSchema.parse({
      view: this.deps.readSettings(),
      applied: effectiveApplied,
    });
  }

  private async applyExternal<T extends { applied: boolean; activationVerified: boolean }>(
    generation: number,
    suspended: Promise<void>,
    apply: () => Promise<T>,
  ): Promise<T> {
    await suspended;
    if (this.stopped) throw new Error("domain intelligence runtime is stopped");
    let result: T;
    try {
      result = await apply();
    } catch (error) {
      if (generation === this.generation) {
        const view = this.deps.readSettings();
        this.recoveryNeeded = view.configurationState === "ready" && view.settings.enabled;
      }
      throw error;
    }
    if (!result.applied) {
      this.activationVerified = false;
    } else if (result.activationVerified) {
      this.activationVerified = true;
    } else if (!this.activationVerified) {
      const view = this.deps.readSettings();
      const shouldEnable = view.configurationState === "ready" && view.settings.enabled;
      if (shouldEnable) {
        let forcedApplied = false;
        try {
          const forced = await this.deps.applyCurrentConfig();
          forcedApplied = forced.applied && forced.activationVerified;
        } catch (error) {
          this.deps.onError?.(error);
        }
        this.activationVerified = forcedApplied;
        result = {
          ...result,
          applied: forcedApplied,
          activationVerified: forcedApplied,
        };
      }
    }
    if (result.applied && this.activationVerified && result.activationVerified === false) {
      result = { ...result, activationVerified: true };
    }
    await this.finishTransition(generation, result.applied);
    return result;
  }

  private async finishTransition(generation: number, applied: boolean): Promise<boolean> {
    const view = this.deps.readSettings();
    const isCurrent = !this.stopped && generation === this.generation;
    const shouldEnable = view.configurationState === "ready" && view.settings.enabled;
    let routeReady = true;
    if (isCurrent && applied && shouldEnable && this.deps.canEnableRuntime) {
      try {
        routeReady = this.deps.canEnableRuntime();
      } catch (error) {
        routeReady = false;
        this.deps.onError?.(error);
      }
    }
    let effectiveApplied =
      isCurrent && applied && (!shouldEnable || (routeReady && this.activationVerified));
    if (isCurrent) {
      this.recoveryNeeded = shouldEnable && !effectiveApplied;
      if (effectiveApplied && shouldEnable) {
        try {
          await this.setRuntimeEnabled(true);
        } catch (error) {
          effectiveApplied = false;
          this.recoveryNeeded = true;
          this.deps.onError?.(error);
          await this.setRuntimeEnabled(false).catch((stopError) => this.deps.onError?.(stopError));
        }
      }
    }
    return effectiveApplied;
  }
}
