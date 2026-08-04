import { dirname } from "node:path";
import type { Env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import type { ProxyChannelConfigInput } from "../nodes/multiConfig.js";
import { collectActiveRoutingInputs } from "../nodes/service.js";
import { verifyManagedDomainRuleActivation } from "./activation.js";
import {
  DomainRuleDeploymentController,
  type DomainRuleDeploymentControllerDeps,
} from "./deployment-controller.js";
import { DomainRuleMaterializationError } from "./materialization.js";
import { DomainRuleProvisioningError } from "./provisioning.js";
import {
  type ProvisionLocalDomainRuleStoreInput,
  prepareLocalRuleRepositoryDirectories,
  provisionLocalDomainRuleStore,
} from "./publisher.js";
import { getDomainIntelligenceSettingsView } from "./service.js";

export interface ProductionDomainRuleDeploymentInput {
  applyConfigDirect: DomainRuleDeploymentControllerDeps["applyConfigDirect"];
  databasePath: string;
  db: Db;
  mihomoConfigPath: string;
  mode: Env["DOMAIN_RULES_MODE"];
  runConfigApply: DomainRuleDeploymentControllerDeps["runConfigApply"];
}

export interface ProductionDomainRuleDeploymentDeps {
  prepareRepositoryDirectories: typeof prepareLocalRuleRepositoryDirectories;
  provisionStore: (input: ProvisionLocalDomainRuleStoreInput) => Promise<unknown>;
  resolveTargetGroupName: (db: Db) => string | null;
  verifyActivation: DomainRuleDeploymentControllerDeps["verifyActivation"];
}

const productionDeps: ProductionDomainRuleDeploymentDeps = {
  prepareRepositoryDirectories: prepareLocalRuleRepositoryDirectories,
  provisionStore: provisionLocalDomainRuleStore,
  resolveTargetGroupName: resolveManagedDomainRuleTargetGroupName,
  verifyActivation: verifyManagedDomainRuleActivation,
};

function classifyLocalStoreFailure(error: unknown): unknown {
  if (
    error instanceof DomainRuleMaterializationError ||
    error instanceof DomainRuleProvisioningError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return error;
  }
  if (!(error instanceof Error)) return error;
  if (error.message.startsWith("unsafe ")) {
    return new DomainRuleProvisioningError("local-store-unsafe");
  }
  if (
    error.message.includes("repository is busy") ||
    error.message.includes("unexpected local Git state") ||
    error.message.includes("interrupted") ||
    error.message.includes("changed concurrently") ||
    error.message.includes("changed during materialization")
  ) {
    return new DomainRuleProvisioningError("local-store-reconciliation-required");
  }
  return error;
}

export function resolveManagedDomainRuleTargetGroupName(db: Db): string | null {
  const targetChannelId = getDomainIntelligenceSettingsView(db).settings.customTargetChannelId;
  const target = collectActiveRoutingInputs(db).inputs.find(
    (input): input is ProxyChannelConfigInput =>
      input.target === "proxy" && input.id === targetChannelId,
  );
  return target && (target.race ?? target.proxies).length > 0 ? target.groupName : null;
}

export function createProductionDomainRuleDeploymentController(
  input: ProductionDomainRuleDeploymentInput,
  deps: ProductionDomainRuleDeploymentDeps = productionDeps,
): DomainRuleDeploymentController {
  return new DomainRuleDeploymentController(input.mode, {
    applyConfigDirect: input.applyConfigDirect,
    provisionStore: async (signal) => {
      try {
        const paths = deps.prepareRepositoryDirectories(dirname(input.databasePath));
        await deps.provisionStore({
          ...paths,
          mihomoConfigPath: input.mihomoConfigPath,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw classifyLocalStoreFailure(error);
      }
    },
    resolveTargetGroupName: () => deps.resolveTargetGroupName(input.db),
    runConfigApply: input.runConfigApply,
    verifyActivation: deps.verifyActivation,
  });
}
