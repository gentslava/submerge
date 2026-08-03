import { getConnections, openLogStream } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { log, operationalLog } from "../../log.js";
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
} from "../domain-intelligence/scheduler.js";
import { getDomainIntelligenceSettingsView } from "../domain-intelligence/service.js";
import {
  applyConfig,
  hasDomainValidationRoute,
  registerConfigApplyCoordinator,
} from "../nodes/service.js";
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
  onError: (error) => operationalLog("domain-validation-scheduler-failed", {}, error),
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

export const domainIntelligenceRuntimeCoordinator = new DomainIntelligenceRuntimeCoordinator({
  readSettings: () => getDomainIntelligenceSettingsView(db),
  applyCurrentConfig: () =>
    applyConfig(db, undefined, undefined, {
      force: true,
      skipRuntimeReconciliation: true,
    }),
  canEnableRuntime: () => hasDomainValidationRoute(db),
  setRuntimeEnabled: setDomainIntelligenceRuntimeEnabled,
  onError: (error) => operationalLog("domain-validation-config-write-failed", {}, error),
});
registerConfigApplyCoordinator((apply) =>
  domainIntelligenceRuntimeCoordinator.runConfigApply(apply),
);

export function shutdownDomainIntelligenceRuntime(): Promise<void> {
  domainIntelligenceRuntimeLifecycle.beginShutdown();
  return domainIntelligenceRuntimeCoordinator.stop();
}

export const logHub = new LogHub({
  openLogStream,
  onMihomoFrame: (frame, observedAt) =>
    domainIntelligenceObserver.observeLogFrame(frame, observedAt),
  onMihomoFrameError: (err) => {
    log.warn({ err }, "domain observation hook failed");
  },
});
