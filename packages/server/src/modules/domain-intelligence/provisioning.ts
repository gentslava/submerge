import {
  type DomainIntelligenceApplyUnavailableReason,
  type DomainIntelligenceDeploymentCapability,
  domainIntelligenceDeploymentCapabilitySchema,
} from "@submerge/shared";
import { deriveDomainRulesDeploymentCapability } from "../../config/domain-rules.js";
import type { Env } from "../../config/env.js";
import type { ManagedDomainRuleActivationProof } from "./activation.js";
import { DomainRuleStoreError } from "./rule-store.js";

type DomainRuleStoreFailureReason = Extract<
  DomainIntelligenceApplyUnavailableReason,
  `local-store-${string}`
>;
type DomainRuleProvisioningFailureReason = Exclude<
  DomainIntelligenceApplyUnavailableReason,
  "deployment-report-only"
>;

export class DomainRuleProvisioningError extends Error {
  override readonly name = "DomainRuleProvisioningError";

  constructor(readonly reason: DomainRuleProvisioningFailureReason) {
    super("domain-rule provisioning failed");
  }
}

export interface DomainRuleDeploymentProvisionerDeps {
  /**
   * Resolve the current target, force-apply the managed provider, and verify
   * its live route inside one process-wide config-coordinator operation.
   */
  forceApplyAndVerifyManagedProvider: (input: {
    signal?: AbortSignal | undefined;
  }) => Promise<ManagedDomainRuleActivationProof>;
  provisionStore: (signal?: AbortSignal) => Promise<void>;
}

const READY_CAPABILITY: DomainIntelligenceDeploymentCapability =
  domainIntelligenceDeploymentCapabilitySchema.parse({
    mode: "apply",
    apply: {
      available: true,
      store: "local-file",
      path: "custom.txt",
      providerName: "submerge-custom",
      providerPath: "./domain-rules/custom.txt",
    },
  });

function unavailableCapability(
  reason: Exclude<DomainIntelligenceApplyUnavailableReason, "deployment-report-only">,
): DomainIntelligenceDeploymentCapability {
  return domainIntelligenceDeploymentCapabilitySchema.parse({
    mode: "apply",
    apply: { available: false, reason },
  });
}

function storeFailureReason(error: unknown): DomainRuleStoreFailureReason {
  if (error instanceof DomainRuleStoreError) return error.reason;
  if (error instanceof DomainRuleProvisioningError) {
    switch (error.reason) {
      case "local-store-unavailable":
      case "local-store-unsafe":
      case "local-store-migration-required":
      case "local-store-reconciliation-required":
        return error.reason;
    }
  }
  return "local-store-unavailable";
}

function activationFailureReason(
  error: unknown,
): "provider-inactive" | "target-channel-unavailable" {
  return error instanceof DomainRuleProvisioningError &&
    error.reason === "target-channel-unavailable"
    ? error.reason
    : "provider-inactive";
}

function isValidActivationProof(proof: unknown): proof is ManagedDomainRuleActivationProof {
  return (
    typeof proof === "object" &&
    proof !== null &&
    "providerRuleCount" in proof &&
    typeof proof.providerRuleCount === "number" &&
    Number.isSafeInteger(proof.providerRuleCount) &&
    proof.providerRuleCount >= 0
  );
}

export class DomainRuleDeploymentProvisioner {
  private capability: DomainIntelligenceDeploymentCapability;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly mode: Env["DOMAIN_RULES_MODE"],
    private readonly deps: DomainRuleDeploymentProvisionerDeps,
  ) {
    this.capability = deriveDomainRulesDeploymentCapability(mode);
  }

  readCapability(): DomainIntelligenceDeploymentCapability {
    return domainIntelligenceDeploymentCapabilitySchema.parse(this.capability);
  }

  captureCapabilityEpoch(): number {
    return this.generation;
  }

  reserveCapabilityEpoch(): number {
    if (this.mode === "apply") this.generation += 1;
    return this.generation;
  }

  revoke(reason: DomainRuleProvisioningFailureReason): void {
    if (this.mode === "report") return;
    this.generation += 1;
    this.capability = unavailableCapability(reason);
  }

  revokeIfCurrent(epoch: number, reason: DomainRuleProvisioningFailureReason): boolean {
    if (this.mode === "report" || epoch !== this.generation) return false;
    this.generation += 1;
    this.capability = unavailableCapability(reason);
    return true;
  }

  publishActivationProof(epoch: number, proof: ManagedDomainRuleActivationProof): boolean {
    if (this.mode === "report" || epoch !== this.generation) return false;
    this.generation += 1;
    const valid = isValidActivationProof(proof);
    this.capability = valid ? READY_CAPABILITY : unavailableCapability("provider-inactive");
    return valid;
  }

  reconcile(signal?: AbortSignal): Promise<DomainIntelligenceDeploymentCapability> {
    if (this.mode === "report") return Promise.resolve(this.readCapability());
    const generation = ++this.generation;
    this.capability = unavailableCapability("local-store-unavailable");
    const operation = this.tail.then(
      () => this.executeReconciliation(generation, signal),
      () => this.executeReconciliation(generation, signal),
    );
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async executeReconciliation(
    generation: number,
    signal?: AbortSignal,
  ): Promise<DomainIntelligenceDeploymentCapability> {
    signal?.throwIfAborted();
    if (generation !== this.generation) return this.readCapability();

    try {
      await this.deps.provisionStore(signal);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (generation !== this.generation) return this.readCapability();
      this.capability = unavailableCapability(storeFailureReason(error));
      return this.readCapability();
    }
    if (generation !== this.generation) return this.readCapability();

    let proof: ManagedDomainRuleActivationProof;
    try {
      proof = await this.deps.forceApplyAndVerifyManagedProvider({ signal });
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (generation !== this.generation) return this.readCapability();
      this.capability = unavailableCapability(activationFailureReason(error));
      return this.readCapability();
    }
    if (generation !== this.generation) return this.readCapability();
    if (!isValidActivationProof(proof)) {
      this.capability = unavailableCapability("provider-inactive");
      return this.readCapability();
    }

    this.capability = READY_CAPABILITY;
    return this.readCapability();
  }
}
