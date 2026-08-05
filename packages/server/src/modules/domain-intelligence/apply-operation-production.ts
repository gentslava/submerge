import { domainIntelligenceDeploymentCapabilitySchema } from "@submerge/shared";
import type { Db } from "../../db/client.js";
import type { ApplyResult } from "../nodes/service.js";
import { setSetting } from "../settings/service.js";
import { DomainRuleOperationDeferredError } from "./apply-errors.js";
import type {
  DomainRuleActivationOutcome,
  DomainRuleApplyOperationDependencies,
} from "./apply-operation.js";
import {
  attestLocalDomainRuleOperationState,
  attestWrittenLocalDomainRuleStore,
  commitPreparedDomainRuleMutation,
  DOMAIN_RULE_DIRECTORY_PATH,
} from "./rule-store.js";

type DomainRuleOperation = Parameters<DomainRuleApplyOperationDependencies["preflightPrepared"]>[0];

export interface ProductionDomainRuleApplyController {
  activateCommittedRules: (expectedProviderRuleCount: number) => Promise<ApplyResult>;
  invalidateManagedProviderActivation: () => void;
  readCapability: () => unknown;
}

export interface ProductionDomainRuleApplyOperationInput {
  controller: ProductionDomainRuleApplyController;
  db: Db;
  preflightPrepared: (operation: DomainRuleOperation, signal?: AbortSignal) => Promise<void>;
}

export interface ProductionDomainRuleApplyOperationAdapters {
  attestOperation: typeof attestLocalDomainRuleOperationState;
  attestWritten: typeof attestWrittenLocalDomainRuleStore;
  commitPrepared: typeof commitPreparedDomainRuleMutation;
}

const productionAdapters: ProductionDomainRuleApplyOperationAdapters = {
  attestOperation: attestLocalDomainRuleOperationState,
  attestWritten: attestWrittenLocalDomainRuleStore,
  commitPrepared: commitPreparedDomainRuleMutation,
};

const LOCAL_RULE_STORE_MARKER_KEY = "internal.domainRuleStore.v1";

function recordCanonicalDigest(db: Db, contentSha256: string): void {
  setSetting(db, LOCAL_RULE_STORE_MARKER_KEY, `sha256:${contentSha256}`);
}

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
        ruleDirectoryPath: DOMAIN_RULE_DIRECTORY_PATH,
      });
    },
    commitPrepared: async (operation) => {
      assertApplyMode(input.controller);
      input.controller.invalidateManagedProviderActivation();
      const written = await adapters.commitPrepared({
        ...operation,
        ruleDirectoryPath: DOMAIN_RULE_DIRECTORY_PATH,
      });
      recordCanonicalDigest(input.db, written.contentSha256);
      return written;
    },
    attestWritten: async (operation) => {
      assertApplyMode(input.controller);
      try {
        const state = await adapters.attestWritten({
          contentSha256: operation.contentSha256,
          ruleDirectoryPath: DOMAIN_RULE_DIRECTORY_PATH,
          revision: operation.revision,
          ...(operation.signal === undefined ? {} : { signal: operation.signal }),
        });
        recordCanonicalDigest(input.db, state.contentSha256);
      } catch (error) {
        input.controller.invalidateManagedProviderActivation();
        throw error;
      }
    },
    activateCommitted: async (operation, signal) => {
      signal?.throwIfAborted();
      assertApplyMode(input.controller);
      let result: ApplyResult;
      try {
        const attested = await adapters.attestWritten({
          contentSha256: operation.operation.resultingContentSha256 ?? "",
          ruleDirectoryPath: DOMAIN_RULE_DIRECTORY_PATH,
          revision: operation.revision,
          ...(signal === undefined ? {} : { signal }),
        });
        signal?.throwIfAborted();
        result = await input.controller.activateCommittedRules(attested.ruleCount);
        signal?.throwIfAborted();
      } catch (error) {
        input.controller.invalidateManagedProviderActivation();
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
