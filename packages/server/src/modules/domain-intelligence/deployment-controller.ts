import type { DomainIntelligenceDeploymentCapability } from "@submerge/shared";
import type { ManagedDomainRulesProviderInput } from "../nodes/multiConfig.js";
import type { ApplyResult } from "../nodes/service.js";
import {
  DomainRuleActivationError,
  type ManagedDomainRuleActivationInput,
  type ManagedDomainRuleActivationProof,
} from "./activation.js";
import { DomainRuleDeploymentProvisioner, DomainRuleProvisioningError } from "./provisioning.js";

type ManagedActivationFailureReason = "provider-inactive" | "target-channel-unavailable";

interface CoordinatedApplyResult extends ApplyResult {
  managedActivationFailureReason?: ManagedActivationFailureReason;
  managedActivationProof?: ManagedDomainRuleActivationProof;
}

export interface DomainRuleDeploymentControllerDeps {
  applyConfigDirect: (input: {
    force: true;
    managedDomainRules?: ManagedDomainRulesProviderInput;
  }) => Promise<ApplyResult>;
  provisionStore: (signal?: AbortSignal) => Promise<void>;
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
  private activeCoordinatedTransition: { epoch: number } | null = null;
  private reconciliationTransitionActive = false;
  private storeProvisioned = false;
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
        await this.deps.provisionStore(signal);
        signal?.throwIfAborted();
        this.storeProvisioned = true;
      },
      forceApplyAndVerifyManagedProvider: ({ signal }) =>
        this.forceApplyAndVerifyManagedProvider(signal),
    });
  }

  readCapability(): DomainIntelligenceDeploymentCapability {
    return this.capabilitySource.readCapability();
  }

  async reconcile(signal?: AbortSignal): Promise<ApplyResult> {
    signal?.throwIfAborted();
    const generation = ++this.reconciliationGeneration;
    if (this.mode === "apply") this.capabilitySource.revoke("local-store-unavailable");
    const operation = this.reconciliationTail.then(
      () => this.reconcileNow(generation, signal),
      () => this.reconcileNow(generation, signal),
    );
    this.reconciliationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async reconcileNow(generation: number, signal?: AbortSignal): Promise<ApplyResult> {
    signal?.throwIfAborted();
    if (generation !== this.reconciliationGeneration) return supersededApplyResult();
    const coordinated = await this.deps.runConfigApply(async () => {
      signal?.throwIfAborted();
      if (generation !== this.reconciliationGeneration) return supersededApplyResult();
      if (this.mode === "apply") {
        this.provisioningApplyResult = null;
        this.reconciliationTransitionActive = true;
        try {
          await this.capabilitySource.reconcile(signal);
        } finally {
          this.reconciliationTransitionActive = false;
        }
        signal?.throwIfAborted();
        if (generation !== this.reconciliationGeneration) return supersededApplyResult();
        if (this.provisioningApplyResult) return this.provisioningApplyResult;
      }
      return this.applyManagedConfig(
        (managedDomainRules) => this.applyConfigDirect(managedDomainRules),
        false,
        signal,
      );
    });
    signal?.throwIfAborted();
    const result = publicApplyResult(coordinated);
    return generation === this.reconciliationGeneration ? result : supersededApplyResult();
  }

  async coordinateConfigApply(apply: CoordinatedApply): Promise<ApplyResult> {
    const transition = { epoch: this.capabilitySource.reserveCapabilityEpoch() };
    try {
      const result = await this.deps.runConfigApply(async () => {
        this.activeCoordinatedTransition = transition;
        return this.applyManagedConfig(apply, true, undefined, transition.epoch);
      });
      return publicApplyResult(result);
    } catch (error) {
      if (this.mode === "apply") {
        this.revokeCapabilityIfCurrent(transition.epoch, "provider-inactive");
      }
      throw error;
    } finally {
      if (this.activeCoordinatedTransition === transition) {
        this.activeCoordinatedTransition = null;
      }
    }
  }

  async applyCurrentConfig(): Promise<ApplyResult> {
    const capabilityEpoch =
      this.activeCoordinatedTransition?.epoch ?? this.capabilitySource.reserveCapabilityEpoch();
    try {
      return publicApplyResult(
        await this.applyManagedConfig(
          (managedDomainRules) => this.applyConfigDirect(managedDomainRules),
          true,
          undefined,
          capabilityEpoch,
        ),
      );
    } catch (error) {
      if (this.mode === "apply") {
        this.revokeCapabilityIfCurrent(capabilityEpoch, "provider-inactive");
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
  ): Promise<CoordinatedApplyResult> {
    signal?.throwIfAborted();
    if (this.mode === "report" || !this.storeProvisioned) {
      const result = await apply();
      signal?.throwIfAborted();
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
      if (publishCapability) {
        this.revokeCapabilityIfCurrent(capabilityEpoch, "provider-inactive");
      }
      return { ...result, managedActivationFailureReason: "provider-inactive" };
    }

    try {
      const proof = await this.deps.verifyActivation({ signal, targetGroupName });
      signal?.throwIfAborted();
      if (publishCapability) {
        this.publishCapabilityIfCurrent(capabilityEpoch, proof);
      }
      return { ...result, managedActivationProof: proof };
    } catch {
      signal?.throwIfAborted();
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

  private revokeCapabilityIfCurrent(epoch: number, reason: ManagedActivationFailureReason): void {
    if (this.capabilitySource.revokeIfCurrent(epoch, reason)) {
      this.advanceActiveTransition(epoch);
    }
  }

  private publishCapabilityIfCurrent(epoch: number, proof: ManagedDomainRuleActivationProof): void {
    if (this.capabilitySource.publishActivationProof(epoch, proof)) {
      this.advanceActiveTransition(epoch);
    }
  }
}
