import type { DomainIntelligenceReportSettings } from "@submerge/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { domainCandidates } from "../../db/schema.js";
import { DomainRuleOperationDeferredError, DomainRulePreparedVetoError } from "./apply-errors.js";
import type { DomainRuleApplyOperationDependencies } from "./apply-operation.js";
import type { CoverageResult } from "./coverage.js";
import type {
  CandidateDecision,
  CandidateEvidence,
  DecisionPolicy,
  ValidationAttempt,
} from "./decision.js";
import { decideCandidate } from "./decision.js";
import { serializeDomainRule } from "./model.js";
import { normalizeObservedFqdn } from "./observer.js";
import {
  countDomainObservationsInWindow,
  getDomainIntelligenceSettingsView,
  listDomainCandidateValidationEvidence,
} from "./service.js";

type DomainRuleOperation = Parameters<DomainRuleApplyOperationDependencies["preflightPrepared"]>[0];

export interface DomainRuleApplyCandidateSnapshot {
  fqdn: string;
  status: "queued" | "pending" | "confirmed" | "blocked" | "excluded";
  reviewState: "active" | "rejected";
  selectedScope: "exact" | "site" | null;
  proposedRule: string | null;
  leaseId: string | null;
  leaseUntil: number | null;
}

interface EvidenceWindow {
  fqdn: string;
  since: number;
  until: number;
}

export interface DomainRulePreparedPreflightDependencies {
  now: () => number;
  observationHealthy: () => boolean;
  readSettings: () => DomainIntelligenceReportSettings | null;
  readCandidate: (fqdn: string) => DomainRuleApplyCandidateSnapshot | null;
  readCoverage: (fqdn: string) => CoverageResult;
  readObservationCount: (input: EvidenceWindow) => number;
  readEvidence: (input: EvidenceWindow) => {
    direct: ValidationAttempt[];
    proxy: ValidationAttempt[];
  };
  decide?: (
    evidence: CandidateEvidence,
    policy: DecisionPolicy,
    evaluatedAt: number,
  ) => CandidateDecision;
}

export interface ProductionDomainRulePreparedPreflightInput {
  db: Db;
  observationHealthy: () => boolean;
  readCoverage: (fqdn: string) => CoverageResult;
  now?: () => number;
}

function decisionPolicy(settings: DomainIntelligenceReportSettings): DecisionPolicy {
  return {
    minimumConnectionCount: settings.minimumConnectionCount,
    directAttemptsRequired: settings.directAttemptsRequired,
    minimumAttemptSpacingMinutes: settings.minimumAttemptSpacingMinutes,
    validationWindowHours: settings.validationWindowHours,
    minimumProxySuccesses: settings.minimumProxySuccesses,
    maximumProxyTransportFailures: settings.maximumProxyTransportFailures,
  };
}

function filterPolicy(settings: DomainIntelligenceReportSettings) {
  return {
    excludedTlds: settings.excludedTlds,
    neverAddDomains: settings.neverAddDomains,
    neverAddSuffixes: settings.neverAddSuffixes,
    nonWidenableSuffixes: settings.nonWidenableSuffixes,
    telemetryPatterns: settings.telemetryPatterns,
  };
}

function assertManualProposedRuleScope(operation: DomainRuleOperation): void {
  const rule = operation.proposedRule;
  if (rule === null) return;
  if (!rule.startsWith("+.")) {
    if (normalizeObservedFqdn(rule) !== rule) {
      throw new DomainRulePreparedVetoError("domain-rule manual scope is invalid");
    }
    return;
  }
  const registrableSite = rule.slice(2);
  const syntheticFqdn = `scope-check.${registrableSite}`;
  try {
    if (serializeDomainRule({ fqdn: syntheticFqdn, registrableSite }, "site") !== rule) {
      throw new DomainRulePreparedVetoError("domain-rule manual scope is invalid");
    }
  } catch {
    throw new DomainRulePreparedVetoError("domain-rule manual scope is invalid");
  }
}

function manualCoverageFqdn(operation: DomainRuleOperation): string | null {
  if (operation.action !== "manual-add" && operation.action !== "manual-edit") return null;
  const rule = operation.proposedRule;
  if (rule === null) return null;
  return rule.startsWith("+.") ? rule.slice(2) : rule;
}

/** Re-read every candidate-derived safety fact immediately before local Git. */
export function createDomainRulePreparedPreflight(
  dependencies: DomainRulePreparedPreflightDependencies,
): DomainRuleApplyOperationDependencies["preflightPrepared"] {
  const decide = dependencies.decide ?? decideCandidate;
  return async (operation: DomainRuleOperation, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (operation.action !== "automatic-add") {
      if (operation.candidateFqdn !== null) {
        throw new DomainRulePreparedVetoError("manual operation cannot claim candidate evidence");
      }
      assertManualProposedRuleScope(operation);
      const settings = dependencies.readSettings();
      if (!settings?.enabled) {
        throw new DomainRulePreparedVetoError("domain-rule manual settings unavailable");
      }
      const coverageFqdn = manualCoverageFqdn(operation);
      if (coverageFqdn !== null) {
        if (!dependencies.observationHealthy()) {
          throw new DomainRuleOperationDeferredError("domain-rule observation is unhealthy");
        }
        const coverage = dependencies.readCoverage(coverageFqdn);
        if (coverage.status === "incomplete") {
          throw new DomainRuleOperationDeferredError("domain-rule coverage is incomplete");
        }
      }
      signal?.throwIfAborted();
      return;
    }

    const settings = dependencies.readSettings();
    if (!settings?.enabled) {
      throw new DomainRulePreparedVetoError("domain-rule automatic settings unavailable");
    }
    const fqdn = operation.candidateFqdn;
    if (!fqdn || !operation.proposedRule) {
      throw new DomainRulePreparedVetoError("domain-rule automatic candidate unavailable");
    }
    const candidate = dependencies.readCandidate(fqdn);
    if (!candidate || candidate.fqdn !== fqdn) {
      throw new DomainRulePreparedVetoError("domain-rule automatic candidate unavailable");
    }
    if (candidate.reviewState !== "active") {
      throw new DomainRulePreparedVetoError("domain-rule candidate is not active");
    }
    if (candidate.status !== "confirmed") {
      throw new DomainRulePreparedVetoError("domain-rule candidate is not confirmed");
    }
    if (candidate.leaseId !== null || candidate.leaseUntil !== null) {
      throw new DomainRuleOperationDeferredError("domain-rule candidate validation lease active");
    }
    if (
      candidate.selectedScope === null ||
      candidate.selectedScope !== (operation.proposedRule.startsWith("+.") ? "site" : "exact")
    ) {
      throw new DomainRulePreparedVetoError("domain-rule candidate scope changed");
    }
    if (candidate.proposedRule !== operation.proposedRule) {
      throw new DomainRulePreparedVetoError("domain-rule candidate scope changed");
    }
    if (!dependencies.observationHealthy()) {
      throw new DomainRuleOperationDeferredError("domain-rule observation is unhealthy");
    }
    signal?.throwIfAborted();

    const coverage = dependencies.readCoverage(fqdn);
    if (coverage.status === "incomplete") {
      throw new DomainRuleOperationDeferredError("domain-rule coverage is incomplete");
    }
    if (coverage.status === "covered") {
      throw new DomainRulePreparedVetoError("domain-rule candidate is already covered");
    }
    const evaluatedAt = dependencies.now();
    const since = Math.max(0, evaluatedAt - settings.validationWindowHours * 60 * 60_000);
    const window = { fqdn, since, until: evaluatedAt };
    const attempts = dependencies.readEvidence(window);
    const evidence: CandidateEvidence = {
      fqdn,
      connectionCount: dependencies.readObservationCount(window),
      observationHealthy: true,
      filterPolicy: filterPolicy(settings),
      selectedScope: candidate.selectedScope,
      proposedRule: candidate.proposedRule,
      coverage,
      direct: attempts.direct,
      proxy: attempts.proxy,
    };
    const decision = decide(evidence, decisionPolicy(settings), evaluatedAt);
    if (decision.status !== "confirmed") {
      throw new DomainRulePreparedVetoError(
        "domain-rule candidate evidence is no longer confirmed",
      );
    }
    signal?.throwIfAborted();
  };
}

export function createProductionDomainRulePreparedPreflight(
  input: ProductionDomainRulePreparedPreflightInput,
): DomainRuleApplyOperationDependencies["preflightPrepared"] {
  return createDomainRulePreparedPreflight({
    now: input.now ?? Date.now,
    observationHealthy: input.observationHealthy,
    readSettings: () => {
      const view = getDomainIntelligenceSettingsView(input.db);
      return view.configurationState === "ready" ? view.settings : null;
    },
    readCandidate: (fqdn) =>
      input.db
        .select({
          fqdn: domainCandidates.fqdn,
          status: domainCandidates.status,
          reviewState: domainCandidates.reviewState,
          selectedScope: domainCandidates.selectedScope,
          proposedRule: domainCandidates.proposedRule,
          leaseId: domainCandidates.leaseId,
          leaseUntil: domainCandidates.leaseUntil,
        })
        .from(domainCandidates)
        .where(eq(domainCandidates.fqdn, fqdn))
        .get() ?? null,
    readCoverage: input.readCoverage,
    readObservationCount: (window) => countDomainObservationsInWindow(input.db, window),
    readEvidence: (window) => listDomainCandidateValidationEvidence(input.db, window),
  });
}
