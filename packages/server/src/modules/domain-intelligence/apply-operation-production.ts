import { dirname } from "node:path";
import { domainIntelligenceDeploymentCapabilitySchema } from "@submerge/shared";
import type { ApplyResult } from "../nodes/service.js";
import { DomainRuleOperationDeferredError } from "./apply-errors.js";
import type {
  DomainRuleActivationOutcome,
  DomainRuleApplyOperationDependencies,
} from "./apply-operation.js";
import {
  attestLocalDomainRuleOperationState,
  commitPreparedDomainRuleMutation,
  materializeCommittedLocalDomainRuleStore,
  prepareLocalRuleRepositoryDirectories,
} from "./publisher.js";

type DomainRuleOperation = Parameters<DomainRuleApplyOperationDependencies["preflightPrepared"]>[0];

export interface ProductionDomainRuleApplyController {
  activateCommittedRules: () => Promise<ApplyResult>;
  readCapability: () => unknown;
}

export interface ProductionDomainRuleApplyOperationInput {
  controller: ProductionDomainRuleApplyController;
  databasePath: string;
  mihomoConfigPath: string;
  preflightPrepared: (operation: DomainRuleOperation, signal?: AbortSignal) => Promise<void>;
}

export interface ProductionDomainRuleApplyOperationAdapters {
  prepareRepositoryDirectories: typeof prepareLocalRuleRepositoryDirectories;
  attestOperation: typeof attestLocalDomainRuleOperationState;
  commitPrepared: typeof commitPreparedDomainRuleMutation;
  materializeCommitted: typeof materializeCommittedLocalDomainRuleStore;
}

const productionAdapters: ProductionDomainRuleApplyOperationAdapters = {
  prepareRepositoryDirectories: prepareLocalRuleRepositoryDirectories,
  attestOperation: attestLocalDomainRuleOperationState,
  commitPrepared: commitPreparedDomainRuleMutation,
  materializeCommitted: materializeCommittedLocalDomainRuleStore,
};

function readApplyCapability(controller: ProductionDomainRuleApplyController) {
  const capability = domainIntelligenceDeploymentCapabilitySchema.safeParse(
    controller.readCapability(),
  );
  if (!capability.success || capability.data.mode !== "apply") {
    throw new Error("domain-rule apply deployment mode unavailable");
  }
  return capability.data;
}

function assertApplyMode(controller: ProductionDomainRuleApplyController): void {
  readApplyCapability(controller);
}

function assertApplyReady(controller: ProductionDomainRuleApplyController): void {
  const capability = readApplyCapability(controller);
  if (!capability.apply.available) {
    throw new DomainRuleOperationDeferredError("domain-rule apply capability unavailable");
  }
}

function activationFailureFromCapability(
  controller: ProductionDomainRuleApplyController,
): DomainRuleActivationOutcome {
  const capability = domainIntelligenceDeploymentCapabilitySchema.safeParse(
    controller.readCapability(),
  );
  if (!capability.success || capability.data.mode !== "apply") {
    return { outcome: "failed", errorCategory: "infrastructure-failure" };
  }
  if (capability.data.apply.available) return { outcome: "succeeded" };
  if (capability.data.apply.reason === "target-channel-unavailable") {
    return { outcome: "failed", errorCategory: "route-proof-failure" };
  }
  if (capability.data.apply.reason === "provider-inactive") {
    return { outcome: "failed", errorCategory: "provider-proof-failure" };
  }
  return { outcome: "failed", errorCategory: "infrastructure-failure" };
}

export function createProductionDomainRuleApplyOperationDependencies(
  input: ProductionDomainRuleApplyOperationInput,
  adapters: ProductionDomainRuleApplyOperationAdapters = productionAdapters,
): DomainRuleApplyOperationDependencies {
  const repositoryPaths = () => adapters.prepareRepositoryDirectories(dirname(input.databasePath));

  return {
    assertExecutionAllowed: (signal) => {
      signal?.throwIfAborted();
      assertApplyMode(input.controller);
    },
    preflightPrepared: async (operation, signal) => {
      signal?.throwIfAborted();
      assertApplyReady(input.controller);
      await input.preflightPrepared(operation, signal);
      signal?.throwIfAborted();
      assertApplyReady(input.controller);
    },
    attestOperation: (operation) => {
      assertApplyMode(input.controller);
      return adapters.attestOperation({
        ...operation,
        ...repositoryPaths(),
      });
    },
    commitPrepared: (operation) => {
      assertApplyMode(input.controller);
      return adapters.commitPrepared({
        ...operation,
        ...repositoryPaths(),
      });
    },
    materializeCommitted: async (operation) => {
      assertApplyMode(input.controller);
      await adapters.materializeCommitted({
        ...operation,
        ...repositoryPaths(),
        mihomoConfigPath: input.mihomoConfigPath,
      });
    },
    activateCommitted: async (_operation, signal) => {
      signal?.throwIfAborted();
      assertApplyMode(input.controller);
      let result: ApplyResult;
      try {
        result = await input.controller.activateCommittedRules();
        signal?.throwIfAborted();
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        return { outcome: "failed", errorCategory: "infrastructure-failure" };
      }
      if (!result.applied || !result.activationVerified) {
        return { outcome: "failed", errorCategory: "config-reload-failure" };
      }
      return activationFailureFromCapability(input.controller);
    },
  };
}
