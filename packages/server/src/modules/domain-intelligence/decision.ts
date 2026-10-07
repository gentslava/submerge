import type { CoverageResult } from "./coverage.js";
import { type DomainFilterPolicy, deriveDomainCandidate, type RuleScope } from "./model.js";
import { normalizeObservedFqdn } from "./observer.js";
import {
  FAILURE_CATEGORIES_WITH_HTTP_STATUS,
  PROBE_CATEGORIES,
  type ProbeCategory,
  QUALIFYING_DIRECT_FAILURE_CATEGORIES,
} from "./probe-category.js";
import { canonicalPublicIpAddress } from "./resolver.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_ATTEMPTS_PER_DIRECTION = 512;
const MAX_AVAILABLE_ADDRESSES = 1_024;
const MAX_VALIDATION_WINDOW_HOURS = 24;
const MIN_DIRECT_ATTEMPTS = 3;
const MIN_DIRECT_SPACING_MINUTES = 120;
const MIN_PROXY_SUCCESSES = 2;
const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const PROBE_CATEGORY_SET = new Set<ProbeCategory>(PROBE_CATEGORIES);

const QUALIFYING_TRANSPORT_FAILURES = new Set<ProbeCategory>(QUALIFYING_DIRECT_FAILURE_CATEGORIES);
const FAILURES_WITH_HTTP_STATUS = new Set<ProbeCategory>(FAILURE_CATEGORIES_WITH_HTTP_STATUS);

export interface ValidationAttempt {
  attemptId: string;
  attemptedAt: number;
  category: ProbeCategory;
  transportSuccess: boolean;
  httpStatus: number | null;
  resolvedAddress: string | null;
  availableAddressCount: number;
  finalOrigin: string | null;
}

export interface CandidateEvidence {
  fqdn: string;
  connectionCount: number;
  observationHealthy: boolean;
  filterPolicy: DomainFilterPolicy;
  selectedScope: RuleScope | null;
  proposedRule: string | null;
  coverage: CoverageResult;
  direct: readonly ValidationAttempt[];
  proxy: readonly ValidationAttempt[];
}

export interface DecisionPolicy {
  minimumConnectionCount: number;
  directAttemptsRequired: number;
  minimumAttemptSpacingMinutes: number;
  validationWindowHours: number;
  minimumProxySuccesses: number;
  maximumProxyTransportFailures: number;
}

export const CANDIDATE_DECISION_STATUSES = ["confirmed", "pending", "blocked"] as const;
export type CandidateDecisionStatus = (typeof CANDIDATE_DECISION_STATUSES)[number];

export const CANDIDATE_DECISION_REASONS = [
  "invalid-policy",
  "invalid-evidence",
  "observer-unhealthy",
  "insufficient-observations",
  "candidate-excluded",
  "invalid-scope",
  "coverage-incomplete",
  "already-covered",
  "proxy-unstable",
  "proxy-evidence-uncertain",
  "insufficient-direct-failures",
  "direct-failures-not-spaced",
  "direct-address-diversity-missing",
  "insufficient-proxy-successes",
] as const;
export type CandidateDecisionReason = (typeof CANDIDATE_DECISION_REASONS)[number];

export const CANDIDATE_DECISION_CONFIDENCES = ["none", "low", "high"] as const;
export type CandidateDecisionConfidence = (typeof CANDIDATE_DECISION_CONFIDENCES)[number];

export interface CandidateDecisionEvidenceSummary {
  directQualifyingFailures: number;
  directSpacedFailures: number;
  directAddressDiversityRequired: boolean;
  directAddressDiversitySatisfied: boolean;
  proxyHttpSuccesses: number;
  proxyTransportFailures: number;
  proxyUncertainFailures: number;
}

export interface CandidateDecision {
  status: CandidateDecisionStatus;
  confidence: CandidateDecisionConfidence;
  reasons: CandidateDecisionReason[];
  windowStart: number | null;
  evidence: CandidateDecisionEvidenceSummary;
}

interface ValidatedAttempt extends ValidationAttempt {
  canonicalAddress: string | null;
  finalOriginFqdn: string;
}

interface SpacedEvidence {
  maximumCount: number;
  maximumDiverseCount: number;
}

const EMPTY_SUMMARY: CandidateDecisionEvidenceSummary = {
  directQualifyingFailures: 0,
  directSpacedFailures: 0,
  directAddressDiversityRequired: false,
  directAddressDiversitySatisfied: false,
  proxyHttpSuccesses: 0,
  proxyTransportFailures: 0,
  proxyUncertainFailures: 0,
};

export const CANDIDATE_DECISION_BLOCKING_REASONS = [
  "invalid-policy",
  "invalid-evidence",
  "observer-unhealthy",
  "candidate-excluded",
  "invalid-scope",
  "coverage-incomplete",
  "already-covered",
  "proxy-unstable",
  "proxy-evidence-uncertain",
] as const satisfies readonly CandidateDecisionReason[];
const BLOCKING_REASONS = new Set<CandidateDecisionReason>(CANDIDATE_DECISION_BLOCKING_REASONS);

export function decisionStatusForReasons(
  reasons: readonly CandidateDecisionReason[],
): CandidateDecisionStatus {
  if (reasons.some((reason) => BLOCKING_REASONS.has(reason))) return "blocked";
  return reasons.length > 0 ? "pending" : "confirmed";
}

export function decisionConfidenceForStatus(
  status: CandidateDecisionStatus,
): CandidateDecisionConfidence {
  return status === "confirmed" ? "high" : status === "pending" ? "low" : "none";
}

function isSafeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function validPolicy(policy: DecisionPolicy): boolean {
  return (
    isSafeCount(policy.minimumConnectionCount) &&
    policy.minimumConnectionCount >= 3 &&
    isSafeCount(policy.directAttemptsRequired) &&
    policy.directAttemptsRequired >= MIN_DIRECT_ATTEMPTS &&
    isSafeCount(policy.minimumAttemptSpacingMinutes) &&
    policy.minimumAttemptSpacingMinutes >= MIN_DIRECT_SPACING_MINUTES &&
    isSafeCount(policy.validationWindowHours) &&
    policy.validationWindowHours >= 1 &&
    policy.validationWindowHours <= MAX_VALIDATION_WINDOW_HOURS &&
    isSafeCount(policy.minimumProxySuccesses) &&
    policy.minimumProxySuccesses >= MIN_PROXY_SUCCESSES &&
    policy.maximumProxyTransportFailures === 0
  );
}

function validEvaluationTime(value: number, windowMs: number): boolean {
  return Number.isSafeInteger(value) && value >= windowMs && value <= MAX_DATE_MS;
}

function validHttpStatus(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 100 && value <= 599);
}

function finalOriginFqdn(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    const fqdn = normalizeObservedFqdn(parsed.hostname);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin !== value ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      fqdn === null ||
      fqdn !== parsed.hostname
    ) {
      return null;
    }
    return fqdn;
  } catch {
    return null;
  }
}

function candidateRuleCoversFqdn(
  candidate: NonNullable<ReturnType<typeof deriveDomainCandidate>>,
  fqdn: string,
): boolean {
  if (candidate.selectedScope === "exact") return fqdn === candidate.fqdn;
  if (candidate.selectedScope === null) return fqdn === candidate.fqdn;
  const site = candidate.registrableSite;
  return site !== null && (fqdn === site || fqdn.endsWith(`.${site}`));
}

function validateAttempt(attempt: ValidationAttempt, evaluatedAt: number): ValidatedAttempt | null {
  const originFqdn = finalOriginFqdn(attempt.finalOrigin);
  if (
    !ATTEMPT_ID.test(attempt.attemptId) ||
    !Number.isSafeInteger(attempt.attemptedAt) ||
    attempt.attemptedAt < 0 ||
    attempt.attemptedAt > evaluatedAt ||
    !PROBE_CATEGORY_SET.has(attempt.category) ||
    !validHttpStatus(attempt.httpStatus) ||
    !Number.isSafeInteger(attempt.availableAddressCount) ||
    attempt.availableAddressCount < 0 ||
    attempt.availableAddressCount > MAX_AVAILABLE_ADDRESSES ||
    originFqdn === null
  ) {
    return null;
  }
  const canonicalAddress =
    attempt.resolvedAddress === null ? null : canonicalPublicIpAddress(attempt.resolvedAddress);
  if (attempt.resolvedAddress !== null && canonicalAddress === null) return null;
  if (
    (canonicalAddress === null && attempt.availableAddressCount !== 0) ||
    (canonicalAddress !== null && attempt.availableAddressCount < 1)
  ) {
    return null;
  }

  if (attempt.category === "http_response") {
    if (!attempt.transportSuccess || attempt.httpStatus === null || canonicalAddress === null) {
      return null;
    }
  } else {
    if (attempt.transportSuccess) return null;
    if (!FAILURES_WITH_HTTP_STATUS.has(attempt.category) && attempt.httpStatus !== null)
      return null;
  }

  if (attempt.category === "dns_failure") {
    if (
      attempt.httpStatus !== null ||
      canonicalAddress !== null ||
      attempt.availableAddressCount !== 0
    ) {
      return null;
    }
  } else if (QUALIFYING_TRANSPORT_FAILURES.has(attempt.category)) {
    if (attempt.httpStatus !== null || canonicalAddress === null) return null;
  }

  return { ...attempt, canonicalAddress, finalOriginFqdn: originFqdn };
}

function coverageIsValid(fqdn: string, coverage: CoverageResult): boolean {
  if (coverage.status === "uncovered") {
    return coverage.match === null && coverage.incompleteSourceIds.length === 0;
  }
  if (coverage.status === "incomplete") {
    return coverage.match === null && coverage.incompleteSourceIds.length > 0;
  }
  if (coverage.match === null || coverage.incompleteSourceIds.length > 0) return false;
  const { kind, rule } = coverage.match;
  if (kind === "exact") return fqdn === rule;
  if (kind === "suffix") return fqdn === rule || fqdn.endsWith(`.${rule}`);
  return fqdn.includes(rule);
}

type DiversityState = "none" | "multiple" | `single:${string}`;

function addAddress(state: DiversityState, address: string | null): DiversityState {
  if (address === null || state === "multiple") return state;
  if (state === "none") return `single:${address}`;
  return state === `single:${address}` ? state : "multiple";
}

function initialDiversityState(address: string | null): DiversityState {
  return address === null ? "none" : `single:${address}`;
}

function evaluateSpacedEvidence(
  attempts: readonly ValidatedAttempt[],
  minimumSpacingMs: number,
): SpacedEvidence {
  const sorted = [...attempts].sort(
    (left, right) =>
      left.attemptedAt - right.attemptedAt || left.attemptId.localeCompare(right.attemptId),
  );
  const statesByEnd: Array<Map<DiversityState, number>> = [];
  let maximumCount = 0;
  let maximumDiverseCount = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    const attempt = sorted[index];
    if (!attempt) continue;
    const current = new Map<DiversityState, number>();
    current.set(initialDiversityState(attempt.canonicalAddress), 1);

    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = sorted[previousIndex];
      const previousStates = statesByEnd[previousIndex];
      if (
        !previous ||
        !previousStates ||
        attempt.attemptedAt - previous.attemptedAt < minimumSpacingMs
      ) {
        continue;
      }
      for (const [state, count] of previousStates) {
        const nextState = addAddress(state, attempt.canonicalAddress);
        current.set(nextState, Math.max(current.get(nextState) ?? 0, count + 1));
      }
    }

    statesByEnd.push(current);
    for (const [state, count] of current) {
      maximumCount = Math.max(maximumCount, count);
      if (state === "multiple") maximumDiverseCount = Math.max(maximumDiverseCount, count);
    }
  }
  return { maximumCount, maximumDiverseCount };
}

function result(
  reasons: CandidateDecisionReason[],
  windowStart: number | null,
  evidence: CandidateDecisionEvidenceSummary,
): CandidateDecision {
  const status = decisionStatusForReasons(reasons);
  const confidence = decisionConfidenceForStatus(status);
  return { status, confidence, reasons, windowStart, evidence };
}

/**
 * Decide from persisted facts at a trusted scheduler timestamp. `evaluatedAt`
 * is deliberately separate from CandidateEvidence so stored rows cannot move
 * their own trailing window.
 */
export function decideCandidate(
  evidence: CandidateEvidence,
  policy: DecisionPolicy,
  evaluatedAt: number,
): CandidateDecision {
  if (!validPolicy(policy)) return result(["invalid-policy"], null, { ...EMPTY_SUMMARY });
  const windowMs = policy.validationWindowHours * HOUR_MS;
  if (!validEvaluationTime(evaluatedAt, windowMs)) {
    return result(["invalid-evidence"], null, { ...EMPTY_SUMMARY });
  }
  const windowStart = evaluatedAt - windowMs;
  if (
    !isSafeCount(evidence.connectionCount) ||
    typeof evidence.observationHealthy !== "boolean" ||
    normalizeObservedFqdn(evidence.fqdn) !== evidence.fqdn ||
    evidence.direct.length > MAX_ATTEMPTS_PER_DIRECTION ||
    evidence.proxy.length > MAX_ATTEMPTS_PER_DIRECTION ||
    !coverageIsValid(evidence.fqdn, evidence.coverage)
  ) {
    return result(["invalid-evidence"], windowStart, { ...EMPTY_SUMMARY });
  }

  let currentCandidate: ReturnType<typeof deriveDomainCandidate>;
  try {
    currentCandidate = deriveDomainCandidate(
      evidence.fqdn,
      evidence.filterPolicy,
      evidence.selectedScope ?? "exact",
    );
  } catch {
    currentCandidate = null;
  }
  if (!currentCandidate) {
    return result(["invalid-evidence"], windowStart, { ...EMPTY_SUMMARY });
  }

  const validatedDirect = evidence.direct.map((attempt) => validateAttempt(attempt, evaluatedAt));
  const validatedProxy = evidence.proxy.map((attempt) => validateAttempt(attempt, evaluatedAt));
  if (validatedDirect.includes(null) || validatedProxy.includes(null)) {
    return result(["invalid-evidence"], windowStart, { ...EMPTY_SUMMARY });
  }
  const direct = validatedDirect as ValidatedAttempt[];
  const proxy = validatedProxy as ValidatedAttempt[];
  const attemptIds = new Set([...direct, ...proxy].map((attempt) => attempt.attemptId));
  if (attemptIds.size !== direct.length + proxy.length) {
    return result(["invalid-evidence"], windowStart, { ...EMPTY_SUMMARY });
  }

  const directInWindow = direct.filter((attempt) => attempt.attemptedAt >= windowStart);
  const proxyInWindow = proxy.filter((attempt) => attempt.attemptedAt >= windowStart);
  const directQualifying = directInWindow.filter(
    (attempt) =>
      QUALIFYING_TRANSPORT_FAILURES.has(attempt.category) &&
      candidateRuleCoversFqdn(currentCandidate, attempt.finalOriginFqdn),
  );
  const spaced = evaluateSpacedEvidence(
    directQualifying,
    policy.minimumAttemptSpacingMinutes * MINUTE_MS,
  );
  const directAddressDiversityRequired = directQualifying.some(
    (attempt) => attempt.availableAddressCount > 1,
  );
  const directAddressDiversitySatisfied =
    !directAddressDiversityRequired || spaced.maximumDiverseCount >= policy.directAttemptsRequired;
  const proxyHttpSuccesses = proxyInWindow.filter(
    (attempt) => attempt.category === "http_response" && attempt.transportSuccess,
  ).length;
  const proxyTransportFailures = proxyInWindow.filter((attempt) =>
    QUALIFYING_TRANSPORT_FAILURES.has(attempt.category),
  ).length;
  const proxyUncertainFailures = proxyInWindow.filter(
    (attempt) =>
      attempt.category !== "http_response" && !QUALIFYING_TRANSPORT_FAILURES.has(attempt.category),
  ).length;
  const summary: CandidateDecisionEvidenceSummary = {
    directQualifyingFailures: directQualifying.length,
    directSpacedFailures: spaced.maximumCount,
    directAddressDiversityRequired,
    directAddressDiversitySatisfied,
    proxyHttpSuccesses,
    proxyTransportFailures,
    proxyUncertainFailures,
  };

  const reasons: CandidateDecisionReason[] = [];
  if (!evidence.observationHealthy) reasons.push("observer-unhealthy");
  if (evidence.connectionCount < policy.minimumConnectionCount) {
    reasons.push("insufficient-observations");
  }
  if (currentCandidate.excluded) reasons.push("candidate-excluded");
  if (
    !currentCandidate.excluded &&
    (evidence.selectedScope === null ||
      currentCandidate.selectedScope !== evidence.selectedScope ||
      currentCandidate.proposedRule !== evidence.proposedRule)
  ) {
    reasons.push("invalid-scope");
  }
  if (evidence.coverage.status === "incomplete") reasons.push("coverage-incomplete");
  if (evidence.coverage.status === "covered") reasons.push("already-covered");
  if (proxyTransportFailures > policy.maximumProxyTransportFailures) {
    reasons.push("proxy-unstable");
  }
  if (proxyUncertainFailures > 0) reasons.push("proxy-evidence-uncertain");
  if (directQualifying.length < policy.directAttemptsRequired) {
    reasons.push("insufficient-direct-failures");
  } else if (spaced.maximumCount < policy.directAttemptsRequired) {
    reasons.push("direct-failures-not-spaced");
  }
  if (!directAddressDiversitySatisfied) reasons.push("direct-address-diversity-missing");
  if (proxyHttpSuccesses < policy.minimumProxySuccesses) {
    reasons.push("insufficient-proxy-successes");
  }

  return result(reasons, windowStart, summary);
}
