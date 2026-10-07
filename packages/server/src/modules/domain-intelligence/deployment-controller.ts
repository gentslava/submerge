import type {
  DomainIntelligenceApplyUnavailableReason,
  DomainIntelligenceDeploymentCapability,
} from "@submerge/shared";
import type { ManagedDomainRulesProviderInput } from "../nodes/multiConfig.js";
import type { ApplyResult } from "../nodes/service.js";
import {
  DomainRuleActivationError,
  type ManagedDomainRuleActivationInput,
  type ManagedDomainRuleActivationProof,
} from "./activation.js";
import { DomainRuleDeploymentProvisioner, DomainRuleProvisioningError } from "./provisioning.js";

type ManagedActivationFailureReason = "provider-inactive" | "target-channel-unavailable";
type CapabilityFailureReason = Exclude<
  DomainIntelligenceApplyUnavailableReason,
  "deployment-report-only"
>;

interface CoordinatedApplyResult extends ApplyResult {
  managedActivationFailureReason?: ManagedActivationFailureReason;
  managedActivationProof?: ManagedDomainRuleActivationProof;
}

export interface DomainRuleDeploymentControllerDeps {
  applyConfigDirect: (input: {
    force: true;
    managedDomainRules?: ManagedDomainRulesProviderInput;
  }) => Promise<ApplyResult>;
  provisionStore: (signal?: AbortSignal) => Promise<{ ruleCount: number }>;
  inspectStore: (signal?: AbortSignal) => Promise<{ ruleCount: number } | null>;
  storePreviouslyInitialized: () => boolean;
  resolveTargetGroupName: () => string | null;
  runConfigApply: (apply: () => Promise<CoordinatedApplyResult>) => Promise<CoordinatedApplyResult>;
  verifyActivation: (
    input: ManagedDomainRuleActivationInput,
  ) => Promise<ManagedDomainRuleActivationProof>;
}

type CoordinatedApply = (
  managedDomainRules?: ManagedDomainRulesProviderInput,
) => Promise<ApplyResult>;

function publicApplyResult(result: CoordinatedApplyResult): ApplyResult {
  return {
    nodes: result.nodes,
    applied: result.applied,
    activationVerified: result.activationVerified,
  };
}

function supersededApplyResult(): ApplyResult {
  return { nodes: 0, applied: false, activationVerified: false };
}

export class DomainRuleDeploymentController {
  readonly capabilitySource: DomainRuleDeploymentProvisioner;
  private activeCoordinatedTransition: { epoch: number; activationEpoch: number } | null = null;
  private activationEpoch = 0;
  private reconciliationActivationEpoch: number | null = null;
  private reconciliationTransitionActive = false;
  private storeProvisioned = false;
  private expectedProviderRuleCount: number | undefined;
  private managedProviderActive = false;
  private provisioningApplyResult: ApplyResult | null = null;
  private reconciliationGeneration = 0;
  private reconciliationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly mode: "apply" | "report",
    private readonly deps: DomainRuleDeploymentControllerDeps,
  ) {
    this.capabilitySource = new DomainRuleDeploymentProvisioner(mode, {
      provisionStore: async (signal) => {
        this.storeProvisioned = false;
        this.expectedProviderRuleCount = undefined;
        const state = await this.deps.provisionStore(signal);
        signal?.throwIfAborted();
        this.storeProvisioned = true;
        this.expectedProviderRuleCount = state.ruleCount;
      },
      forceApplyAndVerifyManagedProvider: ({ signal }) =>
        this.forceApplyAndVerifyManagedProvider(signal),
    });
  }

  readCapability(): DomainIntelligenceDeploymentCapability {
    return this.capabilitySource.readCapability();
  }

  isManagedProviderActive(): boolean {
    return this.managedProviderActive;
  }

  requiresManagedProviderRecovery(): boolean {
    return this.storeProvisioned && !this.managedProviderActive;
  }

  invalidateManagedProviderActivation(): void {
    this.activationEpoch += 1;
    this.managedProviderActive = false;
    if (this.mode !== "apply") return;
    this.capabilitySource.revoke("provider-inactive");
  }

  async reconcile(signal?: AbortSignal): Promise<ApplyResult> {
    signal?.throwIfAborted();
    const generation = ++this.reconciliationGeneration;
    const activationEpoch = ++this.activationEpoch;
    // A proof belongs to one exact store/config snapshot. Revoke it before any
    // re-attestation so failed or queued reconciliation cannot expose changed
    // canonical content as though mihomo had already loaded it.
    this.managedProviderActive = false;
    if (this.mode === "apply") this.capabilitySource.revoke("local-store-unavailable");
    const operation = this.reconciliationTail.then(
      () => this.reconcileNow(generation, activationEpoch, signal),
      () => this.reconcileNow(generation, activationEpoch, signal),
    );
    this.reconciliationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reconcileNow(
    generation: number,
    activationEpoch: number,
    signal?: AbortSignal,
  ): Promise<ApplyResult> {
    signal?.throwIfAborted();
    if (generation !== this.reconciliationGeneration || activationEpoch !== this.activationEpoch) {
      return supersededApplyResult();
    }
    this.markManagedProviderInactiveIfCurrent(activationEpoch);
    const coordinated = await this.deps.runConfigApply(async () => {
      signal?.throwIfAborted();
      if (
        generation !== this.reconciliationGeneration ||
        activationEpoch !== this.activationEpoch
      ) {
        return supersededApplyResult();
      }
      if (this.mode === "report") {
        const state = await this.deps.inspectStore(signal);
        signal?.throwIfAborted();
        this.storeProvisioned = state !== null;
        this.expectedProviderRuleCount = state?.ruleCount;
      }
      if (this.mode === "apply") {
        this.provisioningApplyResult = null;
        this.reconciliationTransitionActive = true;
        this.reconciliationActivationEpoch = activationEpoch;
        try {
          await this.capabilitySource.reconcile(signal);
        } finally {
          this.reconciliationTransitionActive = false;
          this.reconciliationActivationEpoch = null;
        }
        signal?.throwIfAborted();
        if (generation !== this.reconciliationGeneration) return supersededApplyResult();
        if (this.provisioningApplyResult) return this.provisioningApplyResult;
      }
      if (!this.storeProvisioned && this.deps.storePreviouslyInitialized()) {
        if (this.mode === "report") {
          throw new DomainRuleProvisioningError("local-store-migration-required");
        }
        const apply = this.capabilitySource.readCapability().apply;
        const reason =
          !apply.available && apply.reason !== "deployment-report-only"
            ? apply.reason
            : "local-store-unavailable";
        throw new DomainRuleProvisioningError(reason);
      }
      return this.applyManagedConfig(
        (managedDomainRules) => this.applyConfigDirect(managedDomainRules),
        false,
        signal,
        this.capabilitySource.captureCapabilityEpoch(),
        undefined,
        activationEpoch,
      );
    });
    signal?.throwIfAborted();
    const result = publicApplyResult(coordinated);
    return generation === this.reconciliationGeneration ? result : supersededApplyResult();
  }

  async coordinateConfigApply(
    apply: CoordinatedApply,
    expectedProviderRuleCount?: number,
  ): Promise<ApplyResult> {
    this.managedProviderActive = false;
    const transition = {
      epoch: this.capabilitySource.reserveCapabilityEpoch(),
      activationEpoch: ++this.activationEpoch,
    };
    try {
      const result = await this.deps.runConfigApply(async () => {
        this.activeCoordinatedTransition = transition;
        return this.applyManagedConfig(
          apply,
          true,
          undefined,
          transition.epoch,
          expectedProviderRuleCount ?? this.expectedProviderRuleCount,
          transition.activationEpoch,
        );
      });
      return publicApplyResult(result);
    } catch (error) {
      if (this.mode === "apply") {
        this.revokeCapabilityIfCurrent(
          transition.epoch,
          error instanceof DomainRuleProvisioningError ? error.reason : "provider-inactive",
        );
      }
      throw error;
    } finally {
      if (this.activeCoordinatedTransition === transition) {
        this.activeCoordinatedTransition = null;
      }
    }
  }

  activateCommittedRules(expectedProviderRuleCount: number): Promise<ApplyResult> {
    this.expectedProviderRuleCount = expectedProviderRuleCount;
    return this.coordinateConfigApply(
      (managedDomainRules) => this.applyConfigDirect(managedDomainRules),
      expectedProviderRuleCount,
    );
  }

  async applyCurrentConfig(): Promise<ApplyResult> {
    this.managedProviderActive = false;
    const capabilityEpoch =
      this.activeCoordinatedTransition?.epoch ?? this.capabilitySource.reserveCapabilityEpoch();
    const activationEpoch =
      this.activeCoordinatedTransition?.activationEpoch ?? ++this.activationEpoch;
    try {
      return publicApplyResult(
        await this.applyManagedConfig(
          (managedDomainRules) => this.applyConfigDirect(managedDomainRules),
          true,
          undefined,
          capabilityEpoch,
          this.expectedProviderRuleCount,
          activationEpoch,
        ),
      );
    } catch (error) {
      if (this.mode === "apply") {
        this.revokeCapabilityIfCurrent(
          capabilityEpoch,
          error instanceof DomainRuleProvisioningError ? error.reason : "provider-inactive",
        );
      }
      throw error;
    }
  }

  private async forceApplyAndVerifyManagedProvider(
    signal?: AbortSignal,
  ): Promise<ManagedDomainRuleActivationProof> {
    if (!this.reconciliationTransitionActive) {
      throw new DomainRuleProvisioningError("provider-inactive");
    }
    const result = await this.applyManagedConfig(
      (managedDomainRules) => this.applyConfigDirect(managedDomainRules),
      false,
      signal,
      this.capabilitySource.captureCapabilityEpoch(),
      this.expectedProviderRuleCount,
      this.reconciliationActivationEpoch ?? this.activationEpoch,
    );
    this.provisioningApplyResult = publicApplyResult(result);
    if (result.managedActivationFailureReason === "target-channel-unavailable") {
      throw new DomainRuleProvisioningError(result.managedActivationFailureReason);
    }
    if (!result.managedActivationProof) throw new DomainRuleActivationError();
    return result.managedActivationProof;
  }

  private applyConfigDirect(
    managedDomainRules?: ManagedDomainRulesProviderInput,
  ): Promise<ApplyResult> {
    return this.deps.applyConfigDirect({
      force: true,
      ...(managedDomainRules === undefined ? {} : { managedDomainRules }),
    });
  }

  private async applyManagedConfig(
    apply: CoordinatedApply,
    publishCapability: boolean,
    signal?: AbortSignal,
    capabilityEpoch: number = this.capabilitySource.captureCapabilityEpoch(),
    expectedProviderRuleCount?: number,
    activationEpoch: number = this.activationEpoch,
  ): Promise<CoordinatedApplyResult> {
    signal?.throwIfAborted();
    if (!this.storeProvisioned) {
      if (this.deps.storePreviouslyInitialized()) {
        throw new DomainRuleProvisioningError(this.currentStoreFailureReason());
      }
      const result = await apply();
      signal?.throwIfAborted();
      if (result.applied) this.markManagedProviderInactiveIfCurrent(activationEpoch);
      return result;
    }

    let targetGroupName: string | null;
    try {
      targetGroupName = this.deps.resolveTargetGroupName();
    } catch {
      targetGroupName = null;
    }
    signal?.throwIfAborted();
    if (targetGroupName === null) {
      const result = await apply();
      signal?.throwIfAborted();
      if (result.applied) this.markManagedProviderInactiveIfCurrent(activationEpoch);
      if (publishCapability) {
        this.revokeCapabilityIfCurrent(capabilityEpoch, "target-channel-unavailable");
      }
      return { ...result, managedActivationFailureReason: "target-channel-unavailable" };
    }

    // Capability gates future mutations, not existing routing. Keep injecting the
    // already-provisioned provider while unavailable so committed custom rules stay
    // effective and a later live proof can restore readiness without data loss.
    const result = await apply({ targetGroupName });
    signal?.throwIfAborted();
    if (!result.applied) {
      this.markManagedProviderInactiveIfCurrent(activationEpoch);
      if (publishCapability) {
        this.revokeCapabilityIfCurrent(capabilityEpoch, "provider-inactive");
      }
      return { ...result, managedActivationFailureReason: "provider-inactive" };
    }

    try {
      const proof = await this.deps.verifyActivation({ signal, targetGroupName });
      signal?.throwIfAborted();
      if (
        expectedProviderRuleCount !== undefined &&
        proof.providerRuleCount !== expectedProviderRuleCount
      ) {
        throw new DomainRuleActivationError();
      }
      const proofIsCurrent =
        activationEpoch === this.activationEpoch &&
        (this.mode === "report" ||
          (publishCapability
            ? this.publishCapabilityIfCurrent(capabilityEpoch, proof)
            : capabilityEpoch === this.capabilitySource.captureCapabilityEpoch()));
      if (proofIsCurrent) this.managedProviderActive = true;
      return { ...result, managedActivationProof: proof };
    } catch {
      signal?.throwIfAborted();
      this.markManagedProviderInactiveIfCurrent(activationEpoch);
      if (publishCapability) {
        this.revokeCapabilityIfCurrent(capabilityEpoch, "provider-inactive");
      }
      return { ...result, managedActivationFailureReason: "provider-inactive" };
    }
  }

  private advanceActiveTransition(epoch: number): void {
    if (this.activeCoordinatedTransition?.epoch === epoch) {
      this.activeCoordinatedTransition.epoch = this.capabilitySource.captureCapabilityEpoch();
    }
  }

  private markManagedProviderInactiveIfCurrent(activationEpoch: number): void {
    if (activationEpoch === this.activationEpoch) this.managedProviderActive = false;
  }

  private currentStoreFailureReason(): CapabilityFailureReason {
    const apply = this.capabilitySource.readCapability().apply;
    if (!apply.available) {
      switch (apply.reason) {
        case "local-store-unavailable":
        case "local-store-unsafe":
        case "local-store-migration-required":
        case "local-store-reconciliation-required":
          return apply.reason;
      }
    }
    return "local-store-unavailable";
  }

  private revokeCapabilityIfCurrent(epoch: number, reason: CapabilityFailureReason): boolean {
    if (this.capabilitySource.revokeIfCurrent(epoch, reason)) {
      this.advanceActiveTransition(epoch);
      return true;
    }
    return false;
  }

  private publishCapabilityIfCurrent(
    epoch: number,
    proof: ManagedDomainRuleActivationProof,
  ): boolean {
    if (this.capabilitySource.publishActivationProof(epoch, proof)) {
      this.advanceActiveTransition(epoch);
      return true;
    }
    return false;
  }
}
