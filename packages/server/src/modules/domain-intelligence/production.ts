import { dirname } from "node:path";
import { getConnections, prepareForcedRouteProof } from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import type { Db } from "../../db/client.js";
import {
  DOMAIN_VALIDATION_LISTENER_NAME,
  DOMAIN_VALIDATION_USERNAME,
  type ProxyChannelConfigInput,
} from "../nodes/multiConfig.js";
import { collectActiveRoutingInputs, readDomainValidationProxyPassword } from "../nodes/service.js";
import {
  coverageModelFromActiveChannels,
  evaluateDomainCoverage,
  materializeActiveRuleProviderSnapshot,
} from "./coverage.js";
import { DomainValidationExecutor } from "./executor.js";
import type { DomainObservation } from "./observer.js";
import { probeDirectHttps, probeProxyHttps } from "./probe.js";
import {
  countDomainObservationsInWindow,
  getDomainIntelligenceSettingsView,
  listDomainCandidateValidationEvidence,
  queueDomainCandidate,
  type RecordObservationResult,
  recordObservation,
} from "./service.js";

export function persistObservationAndQueueCandidate(
  db: Db,
  observation: DomainObservation,
  wakeValidation: () => void,
  now: () => number = Date.now,
): RecordObservationResult {
  const recorded = recordObservation(db, observation);
  const view = getDomainIntelligenceSettingsView(db);
  if (
    view.configurationState !== "ready" ||
    !view.settings.enabled ||
    view.settings.defaultRuleScope === null
  ) {
    return recorded;
  }
  const candidateAt = Math.max(observation.observedAt, now());
  const connectionCount = countDomainObservationsInWindow(db, {
    fqdn: observation.fqdn,
    since: Math.max(0, candidateAt - view.settings.validationWindowHours * 60 * 60 * 1_000),
    until: candidateAt,
  });
  if (connectionCount < view.settings.minimumConnectionCount) return recorded;
  const queued = queueDomainCandidate(db, {
    fqdn: observation.fqdn,
    filterPolicy: {
      excludedTlds: view.settings.excludedTlds,
      neverAddDomains: view.settings.neverAddDomains,
      neverAddSuffixes: view.settings.neverAddSuffixes,
      nonWidenableSuffixes: view.settings.nonWidenableSuffixes,
      telemetryPatterns: view.settings.telemetryPatterns,
    },
    preferredScope: view.settings.defaultRuleScope,
    now: candidateAt,
  });
  if (queued.status === "queued" || queued.status === "updated") wakeValidation();
  return recorded;
}

function currentValidationTarget(db: Db): {
  target: ProxyChannelConfigInput;
  password: string;
} {
  const view = getDomainIntelligenceSettingsView(db);
  if (view.configurationState !== "ready" || !view.settings.enabled) {
    throw new Error("domain validation runtime is not enabled");
  }
  const { inputs } = collectActiveRoutingInputs(db);
  const target = inputs.find(
    (input): input is ProxyChannelConfigInput =>
      input.target === "proxy" && input.id === view.settings.customTargetChannelId,
  );
  const password = readDomainValidationProxyPassword(db);
  if (!target || (target.race ?? target.proxies).length === 0 || !password) {
    throw new Error("domain validation route is unavailable");
  }
  return { target, password };
}

export function createProductionDomainValidationExecutor(
  db: Db,
  observationHealthy: () => boolean,
): DomainValidationExecutor {
  return new DomainValidationExecutor({
    readSettings: () => getDomainIntelligenceSettingsView(db),
    readCoverage: (fqdn) => {
      const { inputs } = collectActiveRoutingInputs(db);
      const providers = materializeActiveRuleProviderSnapshot(
        inputs,
        dirname(env.MIHOMO_CONFIG_PATH),
      ).providers;
      return evaluateDomainCoverage(fqdn, coverageModelFromActiveChannels(inputs, providers));
    },
    createCoverageSnapshot: () => {
      const { inputs } = collectActiveRoutingInputs(db);
      const routingSignature = JSON.stringify(inputs);
      const snapshot = materializeActiveRuleProviderSnapshot(
        inputs,
        dirname(env.MIHOMO_CONFIG_PATH),
      );
      const model = coverageModelFromActiveChannels(inputs, snapshot.providers);
      return {
        readCoverage: (fqdn: string) => evaluateDomainCoverage(fqdn, model),
        isCurrent: () =>
          snapshot.isCurrent() &&
          JSON.stringify(collectActiveRoutingInputs(db).inputs) === routingSignature,
      };
    },
    readObservationCount: (input) => countDomainObservationsInWindow(db, input),
    readAttempts: (input) => listDomainCandidateValidationEvidence(db, input),
    observationHealthy,
    preflightPair: () => {
      currentValidationTarget(db);
    },
    probeDirect: (fqdn, request) => probeDirectHttps(fqdn, request),
    probeProxy: (fqdn, request) => {
      const { target, password } = currentValidationTarget(db);
      return probeProxyHttps(fqdn, {
        ...request,
        proxy: {
          endpoint: env.DOMAIN_VALIDATION_PROXY_ENDPOINT,
          username: DOMAIN_VALIDATION_USERNAME,
          password,
        },
        prepareRouteProof: (signal) =>
          prepareForcedRouteProof(
            {
              inboundName: DOMAIN_VALIDATION_LISTENER_NAME,
              inboundUser: DOMAIN_VALIDATION_USERNAME,
              inboundPort: env.DOMAIN_VALIDATION_PORT,
              targetGroupName: target.groupName,
            },
            { ...(signal ? { signal } : {}), fetchConnections: getConnections },
          ),
      });
    },
  });
}
