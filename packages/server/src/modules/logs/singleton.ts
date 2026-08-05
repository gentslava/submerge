import { getConnections, openLogStream } from "../../clients/mihomo.js";
import { registerDomainRulesDeploymentCapabilitySource } from "../../config/domain-rules.js";
import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { log, operationalLog } from "../../log.js";
import { createProductionDomainRuleApplyOperationDependencies } from "../domain-intelligence/apply-operation-production.js";
import { createProductionDomainRulePreparedPreflight } from "../domain-intelligence/apply-preflight.js";
import { createProductionDomainRuleApplyWorker } from "../domain-intelligence/apply-worker-production.js";
import { DomainRuleDeploymentLifecycle } from "../domain-intelligence/deployment-lifecycle.js";
import { createProductionDomainRuleDeploymentController } from "../domain-intelligence/deployment-production.js";
import {
  DomainIntelligenceObserver,
  DomainIntelligenceRuntimeLifecycle,
} from "../domain-intelligence/instance.js";
import {
  createProductionDomainValidationExecutor,
  persistObservationAndQueueCandidate,
  readProductionDomainCoverage,
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
let wakeDomainRuleApplyRecovery = (): void => undefined;
let domainRuleApplyReady = (): boolean => env.DOMAIN_RULES_MODE === "report";
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
  onHealth: (health) => {
    if (health.status === "healthy") wakeDomainRuleApplyRecovery();
  },
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
      domainRuleApplyReady() &&
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
const domainRuleApplyOperationDependencies = createProductionDomainRuleApplyOperationDependencies({
  controller: domainRuleDeploymentController,
  databasePath: env.DB_PATH,
  mihomoConfigPath: env.MIHOMO_CONFIG_PATH,
  preflightPrepared: createProductionDomainRulePreparedPreflight({
    db,
    observationHealthy: () => domainIntelligenceScheduler.health().status === "healthy",
    readCoverage: (fqdn) => readProductionDomainCoverage(db, fqdn),
  }),
});
const domainRuleApplyWorker = createProductionDomainRuleApplyWorker({
  controller: domainRuleDeploymentController,
  db,
  operationDependencies: domainRuleApplyOperationDependencies,
  onError: (error, operationId) =>
    operationalLog("domain-rule-apply-worker-failed", { operationId }, error),
  onReady: () => domainValidationScheduler.wake(),
});
domainRuleApplyReady = () =>
  env.DOMAIN_RULES_MODE === "report" || domainRuleApplyWorker.health().accepting;
wakeDomainRuleApplyRecovery = () => {
  domainRuleApplyWorker.wake();
};

export function reconcileDomainRuleDeployment() {
  return domainRuleApplyWorker.serializeMutation(() => domainRuleDeploymentLifecycle.reconcile());
}

export function recoverDomainRuleDeploymentIfNeeded() {
  return domainRuleApplyWorker.serializeMutation(() =>
    domainRuleDeploymentLifecycle.recoverIfNeeded(),
  );
}

export function startDomainRuleApplyWorker(): Promise<void> {
  return domainRuleApplyWorker.start();
}

export function wakeDomainRuleApplyWorker(): boolean {
  return domainRuleApplyWorker.wake();
}

export function serializeDomainRuleAuthorizationMutation<T>(
  mutation: () => T | Promise<T>,
): Promise<T> {
  return domainRuleApplyWorker.serializeMutation(mutation);
}

export function shutdownDomainIntelligenceRuntime(): Promise<void> {
  domainIntelligenceRuntimeLifecycle.beginShutdown();
  return Promise.allSettled([
    domainRuleApplyWorker.stop(),
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
