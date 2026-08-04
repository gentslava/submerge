import { getConnections, openLogStream } from "../../clients/mihomo.js";
import { registerDomainRulesDeploymentCapabilitySource } from "../../config/domain-rules.js";
import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { log, operationalLog } from "../../log.js";
import { DomainRuleDeploymentLifecycle } from "../domain-intelligence/deployment-lifecycle.js";
import { createProductionDomainRuleDeploymentController } from "../domain-intelligence/deployment-production.js";
import {
  DomainIntelligenceObserver,
  DomainIntelligenceRuntimeLifecycle,
} from "../domain-intelligence/instance.js";
import {
  createProductionDomainValidationExecutor,
  persistObservationAndQueueCandidate,
} from "../domain-intelligence/production.js";
import { DomainIntelligenceRuntimeCoordinator } from "../domain-intelligence/runtime.js";
import {
  DomainIntelligenceScheduler,
  DomainValidationScheduler,
  DomainValidationSchedulerError,
} from "../domain-intelligence/scheduler.js";
import { getDomainIntelligenceSettingsView } from "../domain-intelligence/service.js";
import { hasDomainValidationRoute, registerConfigApplyOwner } from "../nodes/service.js";
import { LogHub } from "./hub.js";

let wakeDomainValidation = (): void => undefined;
let domainIntelligenceRuntimeEnabled = false;

export const domainIntelligenceObserver = new DomainIntelligenceObserver({
  persistObservation: (observation) => {
    persistObservationAndQueueCandidate(db, observation, wakeDomainValidation);
  },
  onError: (err) => {
    log.warn({ err }, "domain observation persistence failed");
  },
});
export const domainIntelligenceScheduler = new DomainIntelligenceScheduler({
  fetchConnections: getConnections,
  observer: domainIntelligenceObserver,
});
const domainValidationExecutor = createProductionDomainValidationExecutor(
  db,
  () => domainIntelligenceScheduler.health().status === "healthy",
);
export const domainValidationScheduler = new DomainValidationScheduler({
  db,
  isEnabled: () => {
    const view = getDomainIntelligenceSettingsView(db);
    return (
      domainIntelligenceRuntimeEnabled &&
      view.configurationState === "ready" &&
      view.settings.enabled
    );
  },
  getLimits: () => {
    const view = getDomainIntelligenceSettingsView(db);
    return view.configurationState === "ready"
      ? {
          maximumCandidatesPerRun: view.settings.maximumCandidatesPerRun,
          maxConcurrency: view.settings.maxConcurrency,
        }
      : { maximumCandidatesPerRun: 1, maxConcurrency: 1 };
  },
  execute: (candidate, signal) => domainValidationExecutor.execute(candidate, signal),
  onError: (error) =>
    operationalLog(
      "domain-validation-scheduler-failed",
      {
        category:
          error instanceof DomainValidationSchedulerError
            ? error.category
            : "infrastructure-failure",
      },
      error,
    ),
});
wakeDomainValidation = () => domainValidationScheduler.wake();
const domainIntelligenceRuntimeLifecycle = new DomainIntelligenceRuntimeLifecycle(
  [domainIntelligenceObserver, domainIntelligenceScheduler],
  domainValidationScheduler,
);

export function setDomainIntelligenceRuntimeEnabled(enabled: boolean): Promise<void> {
  domainIntelligenceRuntimeEnabled = enabled;
  return domainIntelligenceRuntimeLifecycle.setEnabled(enabled);
}

const deploymentOwnership = registerConfigApplyOwner({ db }, (applyConfigDirect) => {
  let deploymentController: ReturnType<typeof createProductionDomainRuleDeploymentController>;
  const runtimeCoordinator = new DomainIntelligenceRuntimeCoordinator({
    readSettings: () => getDomainIntelligenceSettingsView(db),
    applyCurrentConfig: () => deploymentController.applyCurrentConfig(),
    canEnableRuntime: () => hasDomainValidationRoute(db),
    setRuntimeEnabled: setDomainIntelligenceRuntimeEnabled,
    onError: (error) => operationalLog("domain-validation-config-write-failed", {}, error),
  });
  deploymentController = createProductionDomainRuleDeploymentController({
    applyConfigDirect,
    databasePath: env.DB_PATH,
    db,
    mihomoConfigPath: env.MIHOMO_CONFIG_PATH,
    mode: env.DOMAIN_RULES_MODE,
    runConfigApply: (apply) => runtimeCoordinator.runConfigApply(apply),
  });
  return {
    coordinator: (apply) => deploymentController.coordinateConfigApply(apply),
    owner: { deploymentController, runtimeCoordinator },
  };
});
export const domainIntelligenceRuntimeCoordinator = deploymentOwnership.owner.runtimeCoordinator;
const domainRuleDeploymentController = deploymentOwnership.owner.deploymentController;
registerDomainRulesDeploymentCapabilitySource(domainRuleDeploymentController.capabilitySource);
const domainRuleDeploymentLifecycle = new DomainRuleDeploymentLifecycle(
  domainRuleDeploymentController,
);

export function reconcileDomainRuleDeployment() {
  return domainRuleDeploymentLifecycle.reconcile();
}

export function recoverDomainRuleDeploymentIfNeeded() {
  return domainRuleDeploymentLifecycle.recoverIfNeeded();
}

export function shutdownDomainIntelligenceRuntime(): Promise<void> {
  domainIntelligenceRuntimeLifecycle.beginShutdown();
  return Promise.allSettled([
    domainRuleDeploymentLifecycle.stop(),
    domainIntelligenceRuntimeCoordinator.stop(),
  ]).then(() => undefined);
}

export const logHub = new LogHub({
  openLogStream,
  onMihomoFrame: (frame, observedAt) =>
    domainIntelligenceObserver.observeLogFrame(frame, observedAt),
  onMihomoFrameError: (err) => {
    log.warn({ err }, "domain observation hook failed");
  },
});
