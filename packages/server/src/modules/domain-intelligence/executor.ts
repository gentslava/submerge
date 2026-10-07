import type {
  DomainIntelligenceReportSettings,
  DomainIntelligenceSettingsView,
} from "@submerge/shared";
import type { CoverageResult } from "./coverage.js";
import { decideCandidate, type ValidationAttempt } from "./decision.js";
import { type DomainFilterPolicy, deriveDomainCandidate } from "./model.js";
import type { DirectProbeResult, ProxyProbeResult } from "./probe.js";
import { type DomainValidationExecution, DomainValidationSchedulerError } from "./scheduler.js";
import type { DueDomainCandidate } from "./service.js";

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export interface ValidationProbeRequest {
  resolverUrls: readonly string[];
  resolverQuorum: number;
  resolverTimeoutMs: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  addressSelectionIndex: number;
  signal: AbortSignal;
}

interface DomainValidationExecutorDeps {
  readSettings: () => DomainIntelligenceSettingsView;
  readCoverage: (fqdn: string) => CoverageResult;
  createCoverageSnapshot?: () => {
    readCoverage: (fqdn: string) => CoverageResult;
    isCurrent: () => boolean;
  };
  readObservationCount: (input: { fqdn: string; since: number; until: number }) => number;
  readAttempts: (input: { fqdn: string; since: number; until: number }) => {
    direct: ValidationAttempt[];
    proxy: ValidationAttempt[];
  };
  observationHealthy: () => boolean;
  preflightPair?: () => void;
  probeDirect: (fqdn: string, request: ValidationProbeRequest) => Promise<DirectProbeResult>;
  probeProxy: (fqdn: string, request: ValidationProbeRequest) => Promise<ProxyProbeResult>;
  now?: () => number;
}

const SYSTEMIC_PROBE_CATEGORIES = new Set([
  "proxy_auth_failure",
  "route_proof_failure",
  "infrastructure_error",
]);

function decisionPolicy(settings: DomainIntelligenceReportSettings) {
  return {
    minimumConnectionCount: settings.minimumConnectionCount,
    directAttemptsRequired: settings.directAttemptsRequired,
    minimumAttemptSpacingMinutes: settings.minimumAttemptSpacingMinutes,
    validationWindowHours: settings.validationWindowHours,
    minimumProxySuccesses: settings.minimumProxySuccesses,
    maximumProxyTransportFailures: settings.maximumProxyTransportFailures,
  };
}

function asEvidence(
  attemptId: string,
  attemptedAt: number,
  result: DirectProbeResult | ProxyProbeResult,
) {
  return {
    attemptId,
    attemptedAt,
    category: result.category,
    transportSuccess: result.transportSuccess,
    httpStatus: result.httpStatus,
    resolvedAddress: result.resolvedAddress,
    availableAddressCount: result.availableAddressCount,
    finalOrigin: result.finalOrigin,
  } satisfies ValidationAttempt;
}

export class DomainValidationExecutor {
  private readonly deps: DomainValidationExecutorDeps;
  private readonly now: () => number;

  constructor(deps: DomainValidationExecutorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async execute(
    candidate: DueDomainCandidate,
    signal: AbortSignal,
  ): Promise<DomainValidationExecution> {
    const view = this.deps.readSettings();
    if (
      view.configurationState !== "ready" ||
      !view.settings.enabled ||
      view.settings.defaultRuleScope === null
    ) {
      throw new DomainValidationSchedulerError("infrastructure-failure");
    }
    const settings = view.settings;
    const filterPolicy: DomainFilterPolicy = {
      excludedTlds: settings.excludedTlds,
      neverAddDomains: settings.neverAddDomains,
      neverAddSuffixes: settings.neverAddSuffixes,
      nonWidenableSuffixes: settings.nonWidenableSuffixes,
      telemetryPatterns: settings.telemetryPatterns,
    };
    const currentCandidate = deriveDomainCandidate(
      candidate.fqdn,
      filterPolicy,
      candidate.selectedScope,
    );
    if (
      !currentCandidate ||
      currentCandidate.excluded ||
      currentCandidate.selectedScope !== candidate.selectedScope ||
      currentCandidate.proposedRule !== candidate.proposedRule
    ) {
      throw new DomainValidationSchedulerError("policy-changed");
    }
    const startedAt = this.now();
    const windowStart = Math.max(0, startedAt - settings.validationWindowHours * HOUR_MS);
    let coverageSnapshot: {
      readCoverage: (fqdn: string) => CoverageResult;
      isCurrent: () => boolean;
    };
    try {
      coverageSnapshot = this.deps.createCoverageSnapshot?.() ?? {
        readCoverage: this.deps.readCoverage,
        isCurrent: () => true,
      };
    } catch {
      throw new DomainValidationSchedulerError("coverage-failure");
    }
    let priorAttempts: { direct: ValidationAttempt[]; proxy: ValidationAttempt[] };
    try {
      priorAttempts = this.deps.readAttempts({
        fqdn: candidate.fqdn,
        since: windowStart,
        until: startedAt,
      });
    } catch {
      throw new DomainValidationSchedulerError("decision-failure");
    }
    let preflightCoverage: CoverageResult;
    let preflightConnectionCount: number;
    try {
      preflightCoverage = coverageSnapshot.readCoverage(candidate.fqdn);
    } catch {
      throw new DomainValidationSchedulerError("coverage-failure");
    }
    try {
      preflightConnectionCount = this.deps.readObservationCount({
        fqdn: candidate.fqdn,
        since: windowStart,
        until: startedAt,
      });
    } catch {
      throw new DomainValidationSchedulerError("decision-failure");
    }

    const evaluate = (
      coverage: CoverageResult,
      attempts: { direct: ValidationAttempt[]; proxy: ValidationAttempt[] },
      connectionCount: number,
      evaluatedAt: number,
    ) =>
      decideCandidate(
        {
          fqdn: candidate.fqdn,
          connectionCount,
          observationHealthy: this.deps.observationHealthy(),
          filterPolicy,
          selectedScope: candidate.selectedScope,
          proposedRule: candidate.proposedRule,
          coverage,
          direct: attempts.direct,
          proxy: attempts.proxy,
        },
        decisionPolicy(settings),
        evaluatedAt,
      );

    if (preflightCoverage.status === "incomplete") {
      throw new DomainValidationSchedulerError("coverage-failure");
    }
    if (preflightCoverage.status === "covered") {
      let decision: ReturnType<typeof decideCandidate>;
      try {
        decision = evaluate(preflightCoverage, priorAttempts, preflightConnectionCount, startedAt);
      } catch {
        throw new DomainValidationSchedulerError("decision-failure");
      }
      return {
        attempts: [],
        decision: {
          evaluatedAt: startedAt,
          value: decision,
          selectedScope: candidate.selectedScope,
          proposedRule: candidate.proposedRule,
        },
      };
    }

    try {
      this.deps.preflightPair?.();
    } catch {
      throw new DomainValidationSchedulerError("infrastructure-failure");
    }
    const addressSelectionIndex = priorAttempts.direct.length;
    const totalTimeoutMs = settings.requestTimeoutMs;
    const pairController = new AbortController();
    const pairSignal = AbortSignal.any([signal, pairController.signal]);
    const request: ValidationProbeRequest = {
      resolverUrls: settings.externalResolvers,
      resolverQuorum: 2,
      resolverTimeoutMs: totalTimeoutMs,
      connectTimeoutMs: Math.min(DEFAULT_CONNECT_TIMEOUT_MS, totalTimeoutMs),
      totalTimeoutMs,
      addressSelectionIndex,
      signal: pairSignal,
    };
    let primaryError: unknown;
    const runProbe = async <T extends DirectProbeResult | ProxyProbeResult>(
      probe: () => Promise<T>,
      category: "direct-probe-failure" | "proxy-probe-failure",
    ): Promise<T> => {
      try {
        const result = await probe();
        if (SYSTEMIC_PROBE_CATEGORIES.has(result.category)) {
          if (primaryError === undefined) {
            primaryError = new DomainValidationSchedulerError("infrastructure-failure");
            pairController.abort(primaryError);
          }
          throw primaryError;
        }
        return result;
      } catch (error) {
        if (signal.aborted) throw error;
        if (primaryError === undefined) {
          primaryError = new DomainValidationSchedulerError(category);
          pairController.abort(primaryError);
        }
        throw primaryError;
      }
    };
    const settled = await Promise.allSettled([
      runProbe(() => this.deps.probeDirect(candidate.fqdn, request), "direct-probe-failure"),
      runProbe(() => this.deps.probeProxy(candidate.fqdn, request), "proxy-probe-failure"),
    ]);
    if (primaryError !== undefined) throw primaryError;
    const directResult = settled[0];
    const proxyResult = settled[1];
    if (directResult?.status !== "fulfilled" || proxyResult?.status !== "fulfilled") {
      throw new DomainValidationSchedulerError("infrastructure-failure");
    }
    const direct = directResult.value;
    const proxy = proxyResult.value;
    const attemptedAt = startedAt;
    const evaluatedAt = Math.max(attemptedAt, this.now());
    const evaluatedWindowStart = Math.max(
      0,
      evaluatedAt - settings.validationWindowHours * HOUR_MS,
    );

    let coverage: CoverageResult;
    let attempts: { direct: ValidationAttempt[]; proxy: ValidationAttempt[] };
    let connectionCount: number;
    if (!coverageSnapshot.isCurrent()) {
      throw new DomainValidationSchedulerError("coverage-failure");
    }
    try {
      coverage = coverageSnapshot.readCoverage(candidate.fqdn);
    } catch {
      throw new DomainValidationSchedulerError("coverage-failure");
    }
    try {
      attempts = this.deps.readAttempts({
        fqdn: candidate.fqdn,
        since: evaluatedWindowStart,
        until: evaluatedAt,
      });
      connectionCount = this.deps.readObservationCount({
        fqdn: candidate.fqdn,
        since: evaluatedWindowStart,
        until: evaluatedAt,
      });
    } catch {
      throw new DomainValidationSchedulerError("decision-failure");
    }

    const directEvidence = asEvidence("current_direct", attemptedAt, direct);
    const proxyEvidence = asEvidence("current_proxy", attemptedAt, proxy);
    let decision: ReturnType<typeof decideCandidate>;
    try {
      decision = evaluate(
        coverage,
        {
          direct: [...attempts.direct, directEvidence],
          proxy: [...attempts.proxy, proxyEvidence],
        },
        connectionCount,
        evaluatedAt,
      );
    } catch {
      throw new DomainValidationSchedulerError("decision-failure");
    }

    return {
      attempts: [
        { attemptedAt, result: direct },
        { attemptedAt, result: proxy },
      ],
      decision: {
        evaluatedAt,
        value: decision,
        selectedScope: candidate.selectedScope,
        proposedRule: candidate.proposedRule,
      },
    };
  }
}
