import { domainIntelligenceDeploymentCapabilitySchema } from "@submerge/shared";
import type { Db } from "../../db/client.js";
import { listUnfinishedDomainRuleOperations } from "./apply-journal.js";
import {
  type DomainRuleApplyOperationDependencies,
  executeDomainRuleOperation,
} from "./apply-operation.js";
import { DomainRuleApplyWorker } from "./apply-worker.js";

export interface ProductionDomainRuleApplyWorkerController {
  readCapability: () => unknown;
}

export interface ProductionDomainRuleApplyWorkerInput {
  controller: ProductionDomainRuleApplyWorkerController;
  db: Db;
  operationDependencies: DomainRuleApplyOperationDependencies;
  onError: (error: unknown, operationId: string | null) => void;
  onReady?: () => void;
}

export interface ProductionDomainRuleApplyWorkerAdapters {
  listUnfinished: typeof listUnfinishedDomainRuleOperations;
  executeOperation: typeof executeDomainRuleOperation;
}

const productionAdapters: ProductionDomainRuleApplyWorkerAdapters = {
  listUnfinished: listUnfinishedDomainRuleOperations,
  executeOperation: executeDomainRuleOperation,
};

export function createProductionDomainRuleApplyWorker(
  input: ProductionDomainRuleApplyWorkerInput,
  adapters: ProductionDomainRuleApplyWorkerAdapters = productionAdapters,
): DomainRuleApplyWorker {
  return new DomainRuleApplyWorker({
    isEnabled: () => {
      const capability = domainIntelligenceDeploymentCapabilitySchema.safeParse(
        input.controller.readCapability(),
      );
      return capability.success && capability.data.mode === "apply";
    },
    listUnfinished: () => adapters.listUnfinished(input.db),
    execute: (operationId, signal) =>
      adapters.executeOperation(input.db, operationId, input.operationDependencies, { signal }),
    onError: input.onError,
    ...(input.onReady ? { onReady: input.onReady } : {}),
  });
}
