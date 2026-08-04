import { Buffer } from "node:buffer";
import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainCandidateList,
  type DomainCandidateListInput,
  type DomainCandidateReviewActionResult,
  type DomainCandidateReviewErrorReason,
  type DomainCandidateStatus,
  type DomainIntelligenceDeploymentCapability,
  type DomainIntelligenceOverview,
  type DomainIntelligenceReportSettings,
  type DomainIntelligenceSettingsMutationResult,
  type DomainIntelligenceSettingsView,
  type DomainObserverHealth,
  type DomainReportExclusionReason,
  domainCandidateListSchema,
  domainCandidateReviewActionResultSchema,
  domainIntelligenceOverviewSchema,
  domainIntelligenceReportSettingsSchema,
  domainIntelligenceSettingsMutationResultSchema,
  domainIntelligenceSettingsViewSchema,
  MAX_SETTING_VALUE_BYTES,
} from "@submerge/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { domainRulesDeploymentCapability } from "../../config/domain-rules.js";
import type { Db } from "../../db/client.js";
import type { DomainValidationRunErrorCategory } from "../../db/schema.js";
import {
  DOMAIN_VALIDATION_RUN_ERROR_CATEGORIES,
  domainCandidates,
  domainDailyStats,
  domainDecisions,
  domainObservations,
  domainValidationAttempts,
  domainValidationRuns,
  settings,
} from "../../db/schema.js";
import { getSetting } from "../settings/service.js";
import {
  CANDIDATE_DECISION_BLOCKING_REASONS,
  CANDIDATE_DECISION_CONFIDENCES,
  CANDIDATE_DECISION_REASONS,
  CANDIDATE_DECISION_STATUSES,
  type CandidateDecision,
  decisionConfidenceForStatus,
  decisionStatusForReasons,
  type ValidationAttempt,
} from "./decision.js";
import {
  type DomainExclusionReason,
  type DomainFilterPolicy,
  deriveDomainCandidate,
  serializeDomainRule,
} from "./model.js";
import {
  canReconcileObservations,
  type DomainObservation,
  fingerprintObservation,
  normalizeObservedFqdn,
  OBSERVATION_RECONCILIATION_WINDOW_MS,
} from "./observer.js";
import { type DirectProbeResult, PROBE_CATEGORIES, type ProxyProbeResult } from "./probe.js";
import {
  FAILURE_CATEGORIES_WITH_HTTP_STATUS,
  QUALIFYING_DIRECT_FAILURE_CATEGORIES,
} from "./probe-category.js";
import { canonicalPublicIpAddress } from "./resolver.js";

export interface RecordObservationResult {
  status: "inserted" | "duplicate" | "reconciled";
  dailyCount: number;
}

export const DOMAIN_OPERATIONAL_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MIN_DECISION_WINDOW_MS = 60 * 60 * 1_000;
const MAX_DECISION_WINDOW_MS = DAY_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;

function safeTimestampAfter(timestamp: number, delayMs: number): number {
  return Math.min(MAX_DATE_MS, timestamp + delayMs);
}

export interface DomainRetentionResult {
  observations: number;
  dailyStats: number;
  candidates: number;
  validationRuns: number;
  validationAttempts: number;
  decisions: number;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function assertObservation(observation: DomainObservation): void {
  if (normalizeObservedFqdn(observation.fqdn) !== observation.fqdn) {
    throw new Error("domain observation FQDN is not normalized");
  }
  if (
    fingerprintObservation(observation.fqdn, observation.transport, observation.observedAt) !==
    observation.fingerprint
  ) {
    throw new Error("domain observation fingerprint does not match its facts");
  }
}

export function recordObservation(db: Db, observation: DomainObservation): RecordObservationResult {
  assertObservation(observation);

  return db.transaction((tx) => {
    const day = utcDay(observation.observedAt);
    const readDailyCount = (canonicalDay: string): number =>
      tx
        .select({ count: domainDailyStats.connectionCount })
        .from(domainDailyStats)
        .where(
          and(eq(domainDailyStats.day, canonicalDay), eq(domainDailyStats.fqdn, observation.fqdn)),
        )
        .get()?.count ?? 0;

    const touchDailyAggregate = (canonicalDay: string, observedAt: number): void => {
      tx.update(domainDailyStats)
        .set({
          firstSeenAt: sql`min(${domainDailyStats.firstSeenAt}, ${observedAt})`,
          lastSeenAt: sql`max(${domainDailyStats.lastSeenAt}, ${observedAt})`,
        })
        .where(
          and(eq(domainDailyStats.day, canonicalDay), eq(domainDailyStats.fqdn, observation.fqdn)),
        )
        .run();
    };

    const rebuildDailyAggregate = (canonicalDay: string): void => {
      const dayStart = Date.parse(`${canonicalDay}T00:00:00.000Z`);
      const dayEnd = dayStart + 86_400_000;
      const rows = tx
        .select()
        .from(domainObservations)
        .where(
          and(
            eq(domainObservations.fqdn, observation.fqdn),
            gte(domainObservations.observedAt, dayStart),
            lt(domainObservations.observedAt, dayEnd),
          ),
        )
        .all();
      if (rows.length === 0) {
        tx.delete(domainDailyStats)
          .where(
            and(
              eq(domainDailyStats.day, canonicalDay),
              eq(domainDailyStats.fqdn, observation.fqdn),
            ),
          )
          .run();
        return;
      }

      const connectionCount = rows.reduce((total, row) => total + row.count, 0);
      const firstSeenAt = Math.min(...rows.map((row) => row.observedAt));
      const lastSeenAt = Math.max(...rows.map((row) => row.lastSeenAt));
      tx.insert(domainDailyStats)
        .values({
          day: canonicalDay,
          fqdn: observation.fqdn,
          connectionCount,
          firstSeenAt,
          lastSeenAt,
        })
        .onConflictDoUpdate({
          target: [domainDailyStats.day, domainDailyStats.fqdn],
          set: { connectionCount, firstSeenAt, lastSeenAt },
        })
        .run();
    };

    const reconcileStored = (
      stored: typeof domainObservations.$inferSelect,
      status: "duplicate" | "reconciled",
    ): RecordObservationResult => {
      const incomingIsCanonical =
        observation.observedAt < stored.observedAt ||
        (observation.observedAt === stored.observedAt &&
          observation.source === "connection-snapshot" &&
          stored.source !== "connection-snapshot");
      const previousDay = utcDay(stored.observedAt);
      const canonicalDay = utcDay(incomingIsCanonical ? observation.observedAt : stored.observedAt);
      tx.update(domainObservations)
        .set({
          fingerprint: incomingIsCanonical ? observation.fingerprint : stored.fingerprint,
          observedAt: incomingIsCanonical ? observation.observedAt : stored.observedAt,
          source: incomingIsCanonical ? observation.source : stored.source,
          lastSeenAt: Math.max(stored.lastSeenAt, observation.observedAt),
        })
        .where(eq(domainObservations.fingerprint, stored.fingerprint))
        .run();
      if (previousDay === canonicalDay) {
        touchDailyAggregate(canonicalDay, observation.observedAt);
      } else {
        rebuildDailyAggregate(previousDay);
        rebuildDailyAggregate(canonicalDay);
      }
      return { status, dailyCount: readDailyCount(canonicalDay) };
    };

    const exact = tx
      .select()
      .from(domainObservations)
      .where(eq(domainObservations.fingerprint, observation.fingerprint))
      .get();
    if (exact) return reconcileStored(exact, "duplicate");

    const lowerBound = Math.max(0, observation.observedAt - OBSERVATION_RECONCILIATION_WINDOW_MS);
    const upperBound = observation.observedAt + OBSERVATION_RECONCILIATION_WINDOW_MS;
    const candidate = tx
      .select()
      .from(domainObservations)
      .where(
        and(
          eq(domainObservations.fqdn, observation.fqdn),
          eq(domainObservations.transport, observation.transport),
          ne(domainObservations.source, observation.source),
          gte(domainObservations.observedAt, lowerBound),
          lte(domainObservations.observedAt, upperBound),
        ),
      )
      .orderBy(sql`abs(${domainObservations.observedAt} - ${observation.observedAt})`)
      .limit(1)
      .get();
    const reconciled =
      candidate && canReconcileObservations(candidate, observation) ? candidate : undefined;
    if (reconciled) return reconcileStored(reconciled, "reconciled");

    tx.insert(domainObservations)
      .values({
        fingerprint: observation.fingerprint,
        fqdn: observation.fqdn,
        observedAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
        transport: observation.transport,
        source: observation.source,
        count: 1,
      })
      .run();
    tx.insert(domainDailyStats)
      .values({
        day,
        fqdn: observation.fqdn,
        connectionCount: 1,
        firstSeenAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
      })
      .onConflictDoUpdate({
        target: [domainDailyStats.day, domainDailyStats.fqdn],
        set: {
          connectionCount: sql`${domainDailyStats.connectionCount} + 1`,
          firstSeenAt: sql`min(${domainDailyStats.firstSeenAt}, ${observation.observedAt})`,
          lastSeenAt: sql`max(${domainDailyStats.lastSeenAt}, ${observation.observedAt})`,
        },
      })
      .run();
    return { status: "inserted", dailyCount: readDailyCount(day) };
  });
}

const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const timestampSchema = z.number().int().min(0).max(MAX_DATE_MS);
const boundedCountSchema = z.number().int().min(0).max(1_024);
const fqdnSchema = z
  .string()
  .min(3)
  .max(253)
  .refine((value) => normalizeObservedFqdn(value) === value, "FQDN must be normalized");
const ruleScopeSchema = z.enum(["exact", "site"]);
const proposedRuleSchema = z
  .string()
  .min(3)
  .max(255)
  .refine((value) => {
    const hostname = value.startsWith("+.") ? value.slice(2) : value;
    return normalizeObservedFqdn(hostname) === hostname;
  }, "proposed rule must contain only a normalized domain");
const filterValueSchema = z.string().min(1).max(253);
const filterPolicySchema = z
  .object({
    excludedTlds: z.array(filterValueSchema).max(4_096),
    neverAddDomains: z.array(filterValueSchema).max(4_096),
    neverAddSuffixes: z.array(filterValueSchema).max(4_096),
    nonWidenableSuffixes: z.array(filterValueSchema).max(4_096),
    telemetryPatterns: z.array(filterValueSchema).max(4_096),
  })
  .strict();
const safeOriginSchema = z
  .string()
  .min(9)
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.origin === value &&
        parsed.pathname === "/" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        normalizeObservedFqdn(parsed.hostname) === parsed.hostname
      );
    } catch {
      return false;
    }
  }, "final origin must be a sanitized HTTPS origin");
const nullableDurationSchema = z.number().int().min(0).max(60_000).nullable();
const qualifyingDirectFailureCategories = new Set<string>(QUALIFYING_DIRECT_FAILURE_CATEGORIES);
const failureCategoriesWithHttpStatus = new Set<string>(FAILURE_CATEGORIES_WITH_HTTP_STATUS);
const probeResultSchema = z
  .object({
    direction: z.enum(["direct", "proxy"]),
    category: z.enum(PROBE_CATEGORIES),
    transportSuccess: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    resolvedAddress: z.string().min(2).max(45).nullable(),
    availableAddressCount: boundedCountSchema,
    connectDurationMs: nullableDurationSchema,
    tlsDurationMs: nullableDurationSchema,
    totalDurationMs: z.number().int().min(0).max(60_000),
    redirectCount: z.number().int().min(0).max(5),
    finalOrigin: safeOriginSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const canonicalAddress =
      result.resolvedAddress === null ? null : canonicalPublicIpAddress(result.resolvedAddress);
    if (result.resolvedAddress !== null && canonicalAddress !== result.resolvedAddress) {
      context.addIssue({
        code: "custom",
        message: "resolved address must be canonical and public",
      });
    }
    if (
      (result.resolvedAddress === null && result.availableAddressCount !== 0) ||
      (result.resolvedAddress !== null && result.availableAddressCount < 1)
    ) {
      context.addIssue({ code: "custom", message: "resolved address count is inconsistent" });
    }
    if (
      (result.connectDurationMs !== null && result.connectDurationMs > result.totalDurationMs) ||
      (result.tlsDurationMs !== null && result.tlsDurationMs > result.totalDurationMs)
    ) {
      context.addIssue({ code: "custom", message: "phase duration exceeds total duration" });
    }
    if (result.category === "http_response") {
      if (
        !result.transportSuccess ||
        result.httpStatus === null ||
        result.resolvedAddress === null
      ) {
        context.addIssue({ code: "custom", message: "HTTP result shape is inconsistent" });
      }
      return;
    }
    if (result.transportSuccess) {
      context.addIssue({ code: "custom", message: "failure cannot be a transport success" });
    }
    const carriesHttpStatus = failureCategoriesWithHttpStatus.has(result.category);
    if (
      (carriesHttpStatus && result.httpStatus === null) ||
      (!carriesHttpStatus && result.httpStatus !== null)
    ) {
      context.addIssue({ code: "custom", message: "failure HTTP status is inconsistent" });
    }
    if (
      result.category === "dns_failure" &&
      (result.resolvedAddress !== null || result.availableAddressCount !== 0)
    ) {
      context.addIssue({ code: "custom", message: "DNS failure cannot carry an address" });
    }
    if (
      result.category !== "dns_failure" &&
      (qualifyingDirectFailureCategories.has(result.category) || carriesHttpStatus) &&
      result.resolvedAddress === null
    ) {
      context.addIssue({
        code: "custom",
        message: "probe failure requires a pinned public address",
      });
    }
  });
const persistedAttemptInputSchema = z
  .object({
    id: identifierSchema,
    attemptedAt: timestampSchema,
    result: probeResultSchema,
  })
  .strict();
const decisionEvidenceSchema = z
  .object({
    directQualifyingFailures: boundedCountSchema,
    directSpacedFailures: boundedCountSchema,
    directAddressDiversityRequired: z.boolean(),
    directAddressDiversitySatisfied: z.boolean(),
    proxyHttpSuccesses: boundedCountSchema,
    proxyTransportFailures: boundedCountSchema,
    proxyUncertainFailures: boundedCountSchema,
  })
  .strict();
const emptyDecisionEvidence = {
  directQualifyingFailures: 0,
  directSpacedFailures: 0,
  directAddressDiversityRequired: false,
  directAddressDiversitySatisfied: false,
  proxyHttpSuccesses: 0,
  proxyTransportFailures: 0,
  proxyUncertainFailures: 0,
} as const;

function isEmptyDecisionEvidence(evidence: z.infer<typeof decisionEvidenceSchema>): boolean {
  return Object.entries(emptyDecisionEvidence).every(
    ([key, value]) => evidence[key as keyof typeof evidence] === value,
  );
}

function hasHardConfirmedEvidence(evidence: z.infer<typeof decisionEvidenceSchema>): boolean {
  return (
    evidence.directQualifyingFailures >= 3 &&
    evidence.directSpacedFailures >= 3 &&
    evidence.directAddressDiversitySatisfied &&
    evidence.proxyHttpSuccesses >= 2 &&
    evidence.proxyTransportFailures === 0 &&
    evidence.proxyUncertainFailures === 0
  );
}

function hasValidDecisionWindow(windowStart: number | null, evaluatedAt: number): boolean {
  if (windowStart === null) return true;
  const duration = evaluatedAt - windowStart;
  return duration >= MIN_DECISION_WINDOW_MS && duration <= MAX_DECISION_WINDOW_MS;
}

const candidateDecisionSchema = z
  .object({
    status: z.enum(CANDIDATE_DECISION_STATUSES),
    confidence: z.enum(CANDIDATE_DECISION_CONFIDENCES),
    reasons: z.array(z.enum(CANDIDATE_DECISION_REASONS)).max(CANDIDATE_DECISION_REASONS.length),
    windowStart: timestampSchema.nullable(),
    evidence: decisionEvidenceSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (new Set(decision.reasons).size !== decision.reasons.length) {
      context.addIssue({ code: "custom", message: "decision reasons must be unique" });
    }
    const expectedStatus = decisionStatusForReasons(decision.reasons);
    if (decision.status !== expectedStatus) {
      context.addIssue({ code: "custom", message: "decision status does not match reasons" });
    }
    if (decision.confidence !== decisionConfidenceForStatus(decision.status)) {
      context.addIssue({ code: "custom", message: "decision confidence does not match status" });
    }
    if (decision.evidence.directSpacedFailures > decision.evidence.directQualifyingFailures) {
      context.addIssue({ code: "custom", message: "spaced failures exceed qualifying failures" });
    }
    const exactFailClosedDecision =
      decision.status === "blocked" &&
      decision.reasons.length === 1 &&
      (decision.reasons[0] === "invalid-policy" || decision.reasons[0] === "invalid-evidence") &&
      isEmptyDecisionEvidence(decision.evidence);
    if (decision.windowStart === null && !exactFailClosedDecision) {
      context.addIssue({
        code: "custom",
        message: "null window requires an exact fail-closed decision",
      });
    }
    if (decision.reasons[0] === "invalid-policy" && decision.windowStart !== null) {
      context.addIssue({ code: "custom", message: "invalid policy decision cannot have a window" });
    }
    if (
      !exactFailClosedDecision &&
      !decision.evidence.directAddressDiversityRequired &&
      !decision.evidence.directAddressDiversitySatisfied
    ) {
      context.addIssue({ code: "custom", message: "address diversity summary is inconsistent" });
    }
    if (decision.status === "confirmed" && !hasHardConfirmedEvidence(decision.evidence)) {
      context.addIssue({
        code: "custom",
        message: "confirmed decision lacks hard-minimum evidence",
      });
    }
  });

export interface QueueDomainCandidateInput {
  fqdn: string;
  filterPolicy: DomainFilterPolicy;
  preferredScope: "exact" | "site";
  now: number;
}

export type QueueDomainCandidateResult =
  | { status: "queued" | "updated"; fqdn: string }
  | { status: "excluded"; reason: DomainExclusionReason | "invalid-domain" };

const queueCandidateInputSchema = z
  .object({
    fqdn: fqdnSchema,
    filterPolicy: filterPolicySchema,
    preferredScope: ruleScopeSchema,
    now: timestampSchema,
  })
  .strict();

export function queueDomainCandidate(
  db: Db,
  input: QueueDomainCandidateInput,
): QueueDomainCandidateResult {
  const parsed = queueCandidateInputSchema.parse(input);

  return db.transaction((tx) => {
    const bounds = tx
      .select({
        firstSeenAt: sql<number | null>`min(${domainDailyStats.firstSeenAt})`,
        lastSeenAt: sql<number | null>`max(${domainDailyStats.lastSeenAt})`,
      })
      .from(domainDailyStats)
      .where(eq(domainDailyStats.fqdn, parsed.fqdn))
      .get();
    if (
      bounds?.firstSeenAt === null ||
      bounds?.firstSeenAt === undefined ||
      bounds.lastSeenAt === null ||
      bounds.lastSeenAt === undefined
    ) {
      throw new Error("candidate requires a persisted observation aggregate");
    }
    if (parsed.now < bounds.lastSeenAt)
      throw new RangeError("candidate timestamp predates observation");

    const existing = tx
      .select()
      .from(domainCandidates)
      .where(eq(domainCandidates.fqdn, parsed.fqdn))
      .get();
    if (existing && parsed.now < existing.updatedAt) {
      throw new RangeError("candidate timestamp violates lifecycle chronology");
    }
    const candidate = deriveDomainCandidate(
      parsed.fqdn,
      parsed.filterPolicy,
      existing?.selectedScope ?? parsed.preferredScope,
    );
    const cancelRunningForPolicyChange = (): void => {
      tx.update(domainValidationRuns)
        .set({ status: "cancelled", finishedAt: parsed.now, errorCategory: "policy-changed" })
        .where(
          and(
            eq(domainValidationRuns.fqdn, parsed.fqdn),
            eq(domainValidationRuns.status, "running"),
            lte(domainValidationRuns.startedAt, parsed.now),
          ),
        )
        .run();
    };
    if (!candidate) return { status: "excluded", reason: "invalid-domain" };
    if (candidate.excluded || !candidate.selectedScope || !candidate.proposedRule) {
      const reason = candidate.exclusionReason ?? "invalid-domain";
      if (existing && reason !== "invalid-domain") {
        cancelRunningForPolicyChange();
        if (existing.reviewState === "rejected") {
          tx.update(domainCandidates)
            .set({
              firstSeenAt: sql`min(${domainCandidates.firstSeenAt}, ${bounds.firstSeenAt})`,
              lastSeenAt: sql`max(${domainCandidates.lastSeenAt}, ${bounds.lastSeenAt})`,
              leaseId: null,
              leaseUntil: null,
              updatedAt: parsed.now,
            })
            .where(eq(domainCandidates.fqdn, candidate.fqdn))
            .run();
          return { status: "excluded", reason };
        }
        tx.update(domainCandidates)
          .set({
            registrableSite: candidate.registrableSite,
            selectedScope: null,
            proposedRule: null,
            exclusionReason: reason,
            status: "excluded",
            firstSeenAt: sql`min(${domainCandidates.firstSeenAt}, ${bounds.firstSeenAt})`,
            lastSeenAt: sql`max(${domainCandidates.lastSeenAt}, ${bounds.lastSeenAt})`,
            nextValidationAt: MAX_DATE_MS,
            leaseId: null,
            leaseUntil: null,
            updatedAt: parsed.now,
          })
          .where(eq(domainCandidates.fqdn, candidate.fqdn))
          .run();
      }
      return { status: "excluded", reason };
    }
    const selectedScope = candidate.selectedScope;
    const proposedRule = candidate.proposedRule;
    if (existing) {
      const proposalChanged =
        existing.selectedScope !== selectedScope || existing.proposedRule !== proposedRule;
      const mustRequeue = existing.status === "excluded" || proposalChanged;
      if (mustRequeue) cancelRunningForPolicyChange();
      tx.update(domainCandidates)
        .set({
          registrableSite: candidate.registrableSite,
          selectedScope,
          proposedRule,
          exclusionReason: null,
          status: mustRequeue ? "queued" : existing.status,
          firstSeenAt: sql`min(${domainCandidates.firstSeenAt}, ${bounds.firstSeenAt})`,
          lastSeenAt: sql`max(${domainCandidates.lastSeenAt}, ${bounds.lastSeenAt})`,
          nextValidationAt: mustRequeue ? parsed.now : existing.nextValidationAt,
          leaseId: mustRequeue ? null : existing.leaseId,
          leaseUntil: mustRequeue ? null : existing.leaseUntil,
          updatedAt: parsed.now,
        })
        .where(eq(domainCandidates.fqdn, candidate.fqdn))
        .run();
      return { status: "updated", fqdn: candidate.fqdn };
    }

    tx.insert(domainCandidates)
      .values({
        fqdn: candidate.fqdn,
        registrableSite: candidate.registrableSite,
        selectedScope,
        proposedRule,
        exclusionReason: null,
        status: "queued",
        firstSeenAt: bounds.firstSeenAt,
        lastSeenAt: bounds.lastSeenAt,
        nextValidationAt: parsed.now,
        lastValidationAt: null,
        failureStreak: 0,
        leaseId: null,
        leaseUntil: null,
        updatedAt: parsed.now,
      })
      .run();
    return { status: "queued", fqdn: candidate.fqdn };
  });
}

export type DomainCandidateReviewErrorCode = DomainCandidateReviewErrorReason;

export class DomainCandidateReviewError extends Error {
  readonly code: DomainCandidateReviewErrorCode;

  constructor(code: DomainCandidateReviewErrorCode) {
    super(code);
    this.name = "DomainCandidateReviewError";
    this.code = code;
  }
}

export interface SelectDomainCandidateScopeInput {
  fqdn: string;
  selectedScope: "exact" | "site";
  filterPolicy: DomainFilterPolicy;
  now: number;
}

export interface SetDomainCandidateRejectionInput {
  fqdn: string;
  rejected: boolean;
  filterPolicy: DomainFilterPolicy | null;
  now: number;
}

export interface RecheckDomainCandidateInput {
  fqdn: string;
  filterPolicy: DomainFilterPolicy;
  now: number;
}

const candidateScopeActionSchema = z
  .object({
    fqdn: fqdnSchema,
    selectedScope: ruleScopeSchema,
    filterPolicy: filterPolicySchema,
    now: timestampSchema,
  })
  .strict();

const candidateRejectionActionSchema = z
  .object({
    fqdn: fqdnSchema,
    rejected: z.boolean(),
    filterPolicy: filterPolicySchema.nullable(),
    now: timestampSchema,
  })
  .strict();

const candidateRecheckActionSchema = z
  .object({
    fqdn: fqdnSchema,
    filterPolicy: filterPolicySchema,
    now: timestampSchema,
  })
  .strict();

function reviewActionResult(
  candidate: typeof domainCandidates.$inferSelect,
): DomainCandidateReviewActionResult {
  return domainCandidateReviewActionResultSchema.parse({
    fqdn: candidate.fqdn,
    reviewState: candidate.reviewState,
    status: candidate.status,
    selectedScope: candidate.selectedScope,
    proposedRule: candidate.proposedRule,
  });
}

function reviewCandidateOrThrow(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  fqdn: string,
): typeof domainCandidates.$inferSelect {
  const candidate = tx.select().from(domainCandidates).where(eq(domainCandidates.fqdn, fqdn)).get();
  if (!candidate) throw new DomainCandidateReviewError("candidate-not-found");
  return candidate;
}

function assertReviewChronology(
  candidate: typeof domainCandidates.$inferSelect,
  now: number,
): void {
  if (now < candidate.updatedAt) {
    throw new RangeError("review action timestamp violates lifecycle chronology");
  }
}

function assertNoActiveDomainValidation(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  candidate: typeof domainCandidates.$inferSelect,
  now: number,
): void {
  const running = tx
    .select({ id: domainValidationRuns.id })
    .from(domainValidationRuns)
    .where(
      and(
        eq(domainValidationRuns.fqdn, candidate.fqdn),
        eq(domainValidationRuns.status, "running"),
      ),
    )
    .get();
  if (running || (candidate.leaseUntil !== null && candidate.leaseUntil > now)) {
    throw new DomainCandidateReviewError("validation-in-progress");
  }
}

export function selectDomainCandidateScope(
  db: Db,
  input: SelectDomainCandidateScopeInput,
): DomainCandidateReviewActionResult {
  const parsed = candidateScopeActionSchema.parse(input);
  return db.transaction((tx) => {
    const current = reviewCandidateOrThrow(tx, parsed.fqdn);
    assertReviewChronology(current, parsed.now);
    if (current.reviewState === "rejected") {
      throw new DomainCandidateReviewError("candidate-rejected");
    }
    if (current.status === "excluded") {
      throw new DomainCandidateReviewError("candidate-excluded");
    }
    const derived = deriveDomainCandidate(parsed.fqdn, parsed.filterPolicy, parsed.selectedScope);
    if (!derived || derived.excluded || !derived.selectedScope || !derived.proposedRule) {
      throw new DomainCandidateReviewError("candidate-excluded");
    }
    if (derived.selectedScope !== parsed.selectedScope) {
      throw new DomainCandidateReviewError("scope-unavailable");
    }
    if (
      current.selectedScope === derived.selectedScope &&
      current.proposedRule === derived.proposedRule &&
      current.registrableSite === derived.registrableSite
    ) {
      return reviewActionResult(current);
    }
    assertNoActiveDomainValidation(tx, current, parsed.now);
    tx.update(domainCandidates)
      .set({
        registrableSite: derived.registrableSite,
        selectedScope: derived.selectedScope,
        proposedRule: derived.proposedRule,
        exclusionReason: null,
        status: "queued",
        nextValidationAt: parsed.now,
        failureStreak: 0,
        leaseId: null,
        leaseUntil: null,
        updatedAt: parsed.now,
      })
      .where(eq(domainCandidates.fqdn, parsed.fqdn))
      .run();
    return reviewActionResult(reviewCandidateOrThrow(tx, parsed.fqdn));
  });
}

export function setDomainCandidateRejection(
  db: Db,
  input: SetDomainCandidateRejectionInput,
): DomainCandidateReviewActionResult {
  const parsed = candidateRejectionActionSchema.parse(input);
  return db.transaction((tx) => {
    const current = reviewCandidateOrThrow(tx, parsed.fqdn);
    assertReviewChronology(current, parsed.now);
    if (parsed.rejected) {
      if (current.reviewState === "rejected") return reviewActionResult(current);
      if (current.status === "excluded") {
        throw new DomainCandidateReviewError("candidate-excluded");
      }
      tx.update(domainCandidates)
        .set({ reviewState: "rejected", updatedAt: parsed.now })
        .where(eq(domainCandidates.fqdn, parsed.fqdn))
        .run();
      return reviewActionResult(reviewCandidateOrThrow(tx, parsed.fqdn));
    }

    if (current.reviewState === "active") return reviewActionResult(current);
    if (!parsed.filterPolicy) {
      throw new DomainCandidateReviewError("policy-unavailable");
    }
    assertNoActiveDomainValidation(tx, current, parsed.now);
    const derived = deriveDomainCandidate(
      parsed.fqdn,
      parsed.filterPolicy,
      current.selectedScope ?? "exact",
    );
    if (!derived) throw new DomainCandidateReviewError("candidate-excluded");
    if (derived.excluded || !derived.selectedScope || !derived.proposedRule) {
      tx.update(domainCandidates)
        .set({
          registrableSite: derived.registrableSite,
          selectedScope: null,
          proposedRule: null,
          exclusionReason: derived.exclusionReason ?? "invalid-policy",
          status: "excluded",
          reviewState: "active",
          nextValidationAt: MAX_DATE_MS,
          failureStreak: 0,
          leaseId: null,
          leaseUntil: null,
          updatedAt: parsed.now,
        })
        .where(eq(domainCandidates.fqdn, parsed.fqdn))
        .run();
    } else {
      tx.update(domainCandidates)
        .set({
          registrableSite: derived.registrableSite,
          selectedScope: derived.selectedScope,
          proposedRule: derived.proposedRule,
          exclusionReason: null,
          status: "queued",
          reviewState: "active",
          nextValidationAt: parsed.now,
          failureStreak: 0,
          leaseId: null,
          leaseUntil: null,
          updatedAt: parsed.now,
        })
        .where(eq(domainCandidates.fqdn, parsed.fqdn))
        .run();
    }
    return reviewActionResult(reviewCandidateOrThrow(tx, parsed.fqdn));
  });
}

export function recheckDomainCandidate(
  db: Db,
  input: RecheckDomainCandidateInput,
): DomainCandidateReviewActionResult {
  const parsed = candidateRecheckActionSchema.parse(input);
  return db.transaction((tx) => {
    const current = reviewCandidateOrThrow(tx, parsed.fqdn);
    assertReviewChronology(current, parsed.now);
    if (current.reviewState === "rejected") {
      throw new DomainCandidateReviewError("candidate-rejected");
    }
    if (current.status === "excluded") {
      throw new DomainCandidateReviewError("candidate-excluded");
    }
    assertNoActiveDomainValidation(tx, current, parsed.now);
    const derived = deriveDomainCandidate(
      parsed.fqdn,
      parsed.filterPolicy,
      current.selectedScope ?? "exact",
    );
    if (!derived || derived.excluded || !derived.selectedScope || !derived.proposedRule) {
      throw new DomainCandidateReviewError("candidate-excluded");
    }
    tx.update(domainCandidates)
      .set({
        registrableSite: derived.registrableSite,
        selectedScope: derived.selectedScope,
        proposedRule: derived.proposedRule,
        exclusionReason: null,
        status: "queued",
        nextValidationAt: parsed.now,
        failureStreak: 0,
        leaseId: null,
        leaseUntil: null,
        updatedAt: parsed.now,
      })
      .where(eq(domainCandidates.fqdn, parsed.fqdn))
      .run();
    return reviewActionResult(reviewCandidateOrThrow(tx, parsed.fqdn));
  });
}

const MAX_VALIDATION_LEASE_MS = 10 * 60_000;
const leaseCandidateInputSchema = z
  .object({
    fqdn: fqdnSchema,
    leaseId: identifierSchema,
    now: timestampSchema,
    leaseUntil: timestampSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.leaseUntil <= input.now || input.leaseUntil - input.now > MAX_VALIDATION_LEASE_MS) {
      context.addIssue({ code: "custom", message: "validation lease duration is invalid" });
    }
  });

export function leaseDomainCandidate(
  db: Db,
  input: z.input<typeof leaseCandidateInputSchema>,
): { leaseId: string; leaseGeneration: number; leaseUntil: number } | null {
  const parsed = leaseCandidateInputSchema.parse(input);
  return db.transaction((tx) => {
    const claimed = tx
      .update(domainCandidates)
      .set({
        leaseId: parsed.leaseId,
        leaseUntil: parsed.leaseUntil,
        leaseGeneration: sql`${domainCandidates.leaseGeneration} + 1`,
        updatedAt: parsed.now,
      })
      .where(
        and(
          eq(domainCandidates.fqdn, parsed.fqdn),
          eq(domainCandidates.reviewState, "active"),
          ne(domainCandidates.status, "excluded"),
          lte(domainCandidates.nextValidationAt, parsed.now),
          lte(domainCandidates.updatedAt, parsed.now),
          lt(domainCandidates.leaseGeneration, 1_000_000_000),
          or(isNull(domainCandidates.leaseUntil), lte(domainCandidates.leaseUntil, parsed.now)),
        ),
      )
      .run().changes;
    if (claimed !== 1) return null;
    const lease = tx
      .select({
        leaseId: domainCandidates.leaseId,
        leaseGeneration: domainCandidates.leaseGeneration,
        leaseUntil: domainCandidates.leaseUntil,
      })
      .from(domainCandidates)
      .where(eq(domainCandidates.fqdn, parsed.fqdn))
      .get();
    if (!lease || lease.leaseId === null || lease.leaseUntil === null) {
      throw new Error("claimed validation lease is incomplete");
    }

    tx.update(domainValidationRuns)
      .set({
        status: "cancelled",
        finishedAt: parsed.now,
        errorCategory: "lease-lost",
      })
      .where(
        and(
          eq(domainValidationRuns.fqdn, parsed.fqdn),
          eq(domainValidationRuns.status, "running"),
          ne(domainValidationRuns.leaseGeneration, lease.leaseGeneration),
          lte(domainValidationRuns.startedAt, parsed.now),
        ),
      )
      .run();
    return {
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      leaseUntil: lease.leaseUntil,
    };
  });
}

const dueCandidatesInputSchema = z
  .object({
    now: timestampSchema,
    limit: z.number().int().min(1).max(20),
  })
  .strict();
const dueDomainCandidateSchema = z
  .object({
    fqdn: fqdnSchema,
    registrableSite: fqdnSchema.nullable(),
    selectedScope: ruleScopeSchema,
    proposedRule: proposedRuleSchema,
    nextValidationAt: timestampSchema,
    failureStreak: z.number().int().min(0).max(1_000_000),
    updatedAt: timestampSchema,
  })
  .strict();

export type DueDomainCandidate = z.infer<typeof dueDomainCandidateSchema>;

export function listDueDomainCandidates(
  db: Db,
  input: { now: number; limit: number },
): DueDomainCandidate[] {
  const parsed = dueCandidatesInputSchema.parse(input);
  return z.array(dueDomainCandidateSchema).parse(
    db
      .select({
        fqdn: domainCandidates.fqdn,
        registrableSite: domainCandidates.registrableSite,
        selectedScope: domainCandidates.selectedScope,
        proposedRule: domainCandidates.proposedRule,
        nextValidationAt: domainCandidates.nextValidationAt,
        failureStreak: domainCandidates.failureStreak,
        updatedAt: domainCandidates.updatedAt,
      })
      .from(domainCandidates)
      .where(
        and(
          eq(domainCandidates.reviewState, "active"),
          ne(domainCandidates.status, "excluded"),
          isNotNull(domainCandidates.selectedScope),
          isNotNull(domainCandidates.proposedRule),
          lte(domainCandidates.nextValidationAt, parsed.now),
          lte(domainCandidates.updatedAt, parsed.now),
          gte(
            domainCandidates.lastSeenAt,
            Math.max(0, parsed.now - DOMAIN_OPERATIONAL_RETENTION_DAYS * DAY_MS),
          ),
          or(isNull(domainCandidates.leaseUntil), lte(domainCandidates.leaseUntil, parsed.now)),
        ),
      )
      .orderBy(domainCandidates.nextValidationAt, domainCandidates.fqdn)
      .limit(parsed.limit)
      .all(),
  );
}

const circuitStateInputSchema = z
  .object({
    now: timestampSchema,
    failureThreshold: z.number().int().min(1).max(100),
    openMs: z.number().int().min(1).max(DAY_MS),
  })
  .strict();
const MAX_CIRCUIT_EVIDENCE_ROWS = 10_000;
const CIRCUIT_FAILURE_CATEGORIES: readonly DomainValidationRunErrorCategory[] = [
  "coverage-failure",
  "direct-probe-failure",
  "proxy-probe-failure",
  "decision-failure",
  "infrastructure-failure",
];

export interface DomainValidationCircuitState {
  open: boolean;
  recentInfrastructureFailures: number;
  retryAt: number | null;
}

export function domainValidationCircuitState(
  db: Db,
  input: { now: number; failureThreshold: number; openMs: number },
): DomainValidationCircuitState {
  const parsed = circuitStateInputSchema.parse(input);
  const evidenceCutoff = Math.max(0, parsed.now - 2 * parsed.openMs);
  const newestFirst = db
    .select({
      finishedAt: domainValidationRuns.finishedAt,
    })
    .from(domainValidationRuns)
    .where(
      and(
        eq(domainValidationRuns.status, "failed"),
        inArray(domainValidationRuns.errorCategory, CIRCUIT_FAILURE_CATEGORIES),
        isNotNull(domainValidationRuns.finishedAt),
        gte(domainValidationRuns.finishedAt, evidenceCutoff),
        lte(domainValidationRuns.finishedAt, parsed.now),
      ),
    )
    .orderBy(desc(domainValidationRuns.finishedAt))
    .limit(MAX_CIRCUIT_EVIDENCE_ROWS)
    .all();
  if (newestFirst.length === MAX_CIRCUIT_EVIDENCE_ROWS) {
    return {
      open: true,
      recentInfrastructureFailures: newestFirst.length,
      retryAt: safeTimestampAfter(parsed.now, parsed.openMs),
    };
  }
  const timestamps = newestFirst
    .flatMap((row) => (row.finishedAt === null ? [] : [row.finishedAt]))
    .reverse();
  let windowStart = 0;
  let recentInfrastructureFailures = 0;
  let retryAt: number | null = null;
  for (let index = 0; index < timestamps.length; index += 1) {
    const triggerAt = timestamps[index];
    if (triggerAt === undefined) continue;
    while (true) {
      const earliest = timestamps[windowStart];
      if (earliest === undefined || earliest >= triggerAt - parsed.openMs) break;
      windowStart += 1;
    }
    const failureCount = index - windowStart + 1;
    const candidateRetryAt = safeTimestampAfter(triggerAt, parsed.openMs);
    if (
      failureCount >= parsed.failureThreshold &&
      parsed.now < candidateRetryAt &&
      (retryAt === null || candidateRetryAt > retryAt)
    ) {
      recentInfrastructureFailures = failureCount;
      retryAt = candidateRetryAt;
    }
  }
  return {
    open: retryAt !== null && parsed.now < retryAt,
    recentInfrastructureFailures,
    retryAt,
  };
}

const startValidationRunSchema = z
  .object({
    id: identifierSchema,
    fqdn: fqdnSchema,
    leaseId: identifierSchema,
    leaseGeneration: z.number().int().min(1).max(1_000_000_000),
    startedAt: timestampSchema,
  })
  .strict();

export function startDomainValidationRun(
  db: Db,
  input: z.input<typeof startValidationRunSchema>,
): void {
  const parsed = startValidationRunSchema.parse(input);
  db.transaction((tx) => {
    const candidate = tx
      .select()
      .from(domainCandidates)
      .where(eq(domainCandidates.fqdn, parsed.fqdn))
      .get();
    if (
      candidate?.reviewState !== "active" ||
      candidate.status === "excluded" ||
      candidate.leaseId !== parsed.leaseId ||
      candidate.leaseGeneration !== parsed.leaseGeneration ||
      candidate.leaseUntil === null ||
      candidate.leaseUntil <= parsed.startedAt ||
      candidate.updatedAt > parsed.startedAt
    ) {
      throw new Error("validation lease is not active");
    }
    const running = tx
      .select({ id: domainValidationRuns.id })
      .from(domainValidationRuns)
      .where(
        and(eq(domainValidationRuns.fqdn, parsed.fqdn), eq(domainValidationRuns.status, "running")),
      )
      .get();
    if (running) throw new Error("candidate already has a running validation");
    tx.insert(domainValidationRuns)
      .values({
        id: parsed.id,
        leaseId: parsed.leaseId,
        leaseGeneration: parsed.leaseGeneration,
        fqdn: parsed.fqdn,
        startedAt: parsed.startedAt,
        finishedAt: null,
        status: "running",
        errorCategory: null,
      })
      .run();
    const updated = tx
      .update(domainCandidates)
      .set({ status: "pending", updatedAt: parsed.startedAt })
      .where(
        and(
          eq(domainCandidates.fqdn, parsed.fqdn),
          eq(domainCandidates.leaseId, parsed.leaseId),
          eq(domainCandidates.leaseGeneration, parsed.leaseGeneration),
          gt(domainCandidates.leaseUntil, parsed.startedAt),
          lte(domainCandidates.updatedAt, parsed.startedAt),
          ne(domainCandidates.status, "excluded"),
        ),
      )
      .run().changes;
    if (updated !== 1) throw new Error("validation lease was lost before start");
  });
}

const claimValidationRunSchema = z
  .object({
    runId: identifierSchema,
    fqdn: fqdnSchema,
    leaseId: identifierSchema,
    now: timestampSchema,
    leaseUntil: timestampSchema,
    rateWindowMs: z.number().int().min(1).max(DAY_MS),
    maximumStarts: z.number().int().min(1).max(20),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.leaseUntil <= input.now || input.leaseUntil - input.now > MAX_VALIDATION_LEASE_MS) {
      context.addIssue({ code: "custom", message: "validation lease duration is invalid" });
    }
  });

export type ClaimDomainValidationRunResult =
  | {
      status: "claimed";
      leaseId: string;
      leaseGeneration: number;
      leaseUntil: number;
    }
  | { status: "rate-limited" | "unavailable" };

export function claimDomainValidationRun(
  db: Db,
  input: z.input<typeof claimValidationRunSchema>,
): ClaimDomainValidationRunResult {
  const parsed = claimValidationRunSchema.parse(input);
  return db.transaction((tx) => {
    const rateCutoff = Math.max(0, parsed.now - parsed.rateWindowMs);
    const recentStarts =
      tx
        .select({ count: sql<number>`count(*)` })
        .from(domainValidationRuns)
        .where(
          and(
            gt(domainValidationRuns.startedAt, rateCutoff),
            lte(domainValidationRuns.startedAt, parsed.now),
          ),
        )
        .get()?.count ?? 0;
    if (recentStarts >= parsed.maximumStarts) return { status: "rate-limited" };

    const claimed = tx
      .update(domainCandidates)
      .set({
        status: "pending",
        leaseId: parsed.leaseId,
        leaseUntil: parsed.leaseUntil,
        leaseGeneration: sql`${domainCandidates.leaseGeneration} + 1`,
        updatedAt: parsed.now,
      })
      .where(
        and(
          eq(domainCandidates.fqdn, parsed.fqdn),
          eq(domainCandidates.reviewState, "active"),
          ne(domainCandidates.status, "excluded"),
          lte(domainCandidates.nextValidationAt, parsed.now),
          lte(domainCandidates.updatedAt, parsed.now),
          lt(domainCandidates.leaseGeneration, 1_000_000_000),
          or(isNull(domainCandidates.leaseUntil), lte(domainCandidates.leaseUntil, parsed.now)),
        ),
      )
      .run().changes;
    if (claimed !== 1) return { status: "unavailable" };

    const lease = tx
      .select({
        leaseId: domainCandidates.leaseId,
        leaseGeneration: domainCandidates.leaseGeneration,
        leaseUntil: domainCandidates.leaseUntil,
      })
      .from(domainCandidates)
      .where(eq(domainCandidates.fqdn, parsed.fqdn))
      .get();
    if (!lease || lease.leaseId === null || lease.leaseUntil === null) {
      throw new Error("claimed validation lease is incomplete");
    }

    tx.update(domainValidationRuns)
      .set({ status: "cancelled", finishedAt: parsed.now, errorCategory: "lease-lost" })
      .where(
        and(
          eq(domainValidationRuns.fqdn, parsed.fqdn),
          eq(domainValidationRuns.status, "running"),
          ne(domainValidationRuns.leaseGeneration, lease.leaseGeneration),
          lte(domainValidationRuns.startedAt, parsed.now),
        ),
      )
      .run();
    const stillRunning = tx
      .select({ id: domainValidationRuns.id })
      .from(domainValidationRuns)
      .where(
        and(eq(domainValidationRuns.fqdn, parsed.fqdn), eq(domainValidationRuns.status, "running")),
      )
      .get();
    if (stillRunning) throw new Error("candidate already has a running validation");

    tx.insert(domainValidationRuns)
      .values({
        id: parsed.runId,
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        fqdn: parsed.fqdn,
        startedAt: parsed.now,
        finishedAt: null,
        status: "running",
        errorCategory: null,
      })
      .run();
    return {
      status: "claimed",
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      leaseUntil: lease.leaseUntil,
    };
  });
}

const recoverValidationRunsSchema = z
  .object({
    now: timestampSchema,
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();

export function recoverExpiredDomainValidationRuns(
  db: Db,
  input: { now: number; limit: number },
): number {
  const parsed = recoverValidationRunsSchema.parse(input);
  return db.transaction((tx) => {
    const stale = tx
      .select({
        runId: domainValidationRuns.id,
        runLeaseId: domainValidationRuns.leaseId,
        runLeaseGeneration: domainValidationRuns.leaseGeneration,
        fqdn: domainValidationRuns.fqdn,
        startedAt: domainValidationRuns.startedAt,
        candidateLeaseId: domainCandidates.leaseId,
        candidateLeaseGeneration: domainCandidates.leaseGeneration,
        candidateLeaseUntil: domainCandidates.leaseUntil,
        candidateUpdatedAt: domainCandidates.updatedAt,
      })
      .from(domainValidationRuns)
      .innerJoin(domainCandidates, eq(domainCandidates.fqdn, domainValidationRuns.fqdn))
      .where(
        and(
          eq(domainValidationRuns.status, "running"),
          lte(domainValidationRuns.startedAt, parsed.now),
          or(
            isNull(domainCandidates.leaseUntil),
            lte(domainCandidates.leaseUntil, parsed.now),
            ne(domainCandidates.leaseId, domainValidationRuns.leaseId),
            ne(domainCandidates.leaseGeneration, domainValidationRuns.leaseGeneration),
          ),
        ),
      )
      .orderBy(domainValidationRuns.startedAt, domainValidationRuns.id)
      .limit(parsed.limit)
      .all();
    let recovered = 0;
    for (const row of stale) {
      const ownsCandidateLease =
        row.candidateLeaseId === row.runLeaseId &&
        row.candidateLeaseGeneration === row.runLeaseGeneration &&
        row.candidateLeaseUntil !== null;
      const staleAt = ownsCandidateLease
        ? (row.candidateLeaseUntil ?? row.candidateUpdatedAt)
        : row.candidateUpdatedAt;
      const finishedAt = Math.max(row.startedAt, Math.min(parsed.now, staleAt));
      const cancelled = tx
        .update(domainValidationRuns)
        .set({ status: "cancelled", finishedAt, errorCategory: "lease-lost" })
        .where(
          and(
            eq(domainValidationRuns.id, row.runId),
            eq(domainValidationRuns.status, "running"),
            eq(domainValidationRuns.leaseId, row.runLeaseId),
            eq(domainValidationRuns.leaseGeneration, row.runLeaseGeneration),
          ),
        )
        .run().changes;
      if (cancelled !== 1) continue;
      recovered += 1;
      if (
        ownsCandidateLease &&
        row.candidateLeaseUntil !== null &&
        row.candidateLeaseUntil <= parsed.now
      ) {
        tx.update(domainCandidates)
          .set({
            status: "pending",
            nextValidationAt: sql`min(${domainCandidates.nextValidationAt}, ${finishedAt})`,
            leaseId: null,
            leaseUntil: null,
            updatedAt: sql`max(${domainCandidates.updatedAt}, ${finishedAt})`,
          })
          .where(
            and(
              eq(domainCandidates.fqdn, row.fqdn),
              eq(domainCandidates.leaseId, row.runLeaseId),
              eq(domainCandidates.leaseGeneration, row.runLeaseGeneration),
              lte(domainCandidates.leaseUntil, parsed.now),
              ne(domainCandidates.status, "excluded"),
            ),
          )
          .run();
      }
    }
    return recovered;
  });
}

const completeValidationRunSchema = z
  .object({
    runId: identifierSchema,
    leaseId: identifierSchema,
    leaseGeneration: z.number().int().min(1).max(1_000_000_000),
    finishedAt: timestampSchema,
    nextValidationAt: timestampSchema,
    failureStreak: z.number().int().min(0).max(1_000_000),
    attempts: z.array(persistedAttemptInputSchema).max(2),
    decision: z
      .object({
        id: identifierSchema,
        evaluatedAt: timestampSchema,
        value: candidateDecisionSchema,
        selectedScope: ruleScopeSchema,
        proposedRule: proposedRuleSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((input, context) => {
    const directions = new Set(input.attempts.map((attempt) => attempt.result.direction));
    const noProbeDecision =
      input.attempts.length === 0 &&
      input.decision.value.status === "blocked" &&
      input.decision.value.reasons.some((reason) =>
        ["already-covered", "coverage-incomplete"].includes(reason),
      );
    if (
      !noProbeDecision &&
      (input.attempts.length !== 2 || !directions.has("direct") || !directions.has("proxy"))
    ) {
      context.addIssue({
        code: "custom",
        message: "one DIRECT and one PROXY attempt are required unless coverage blocks probing",
      });
    }
    if (input.nextValidationAt < input.finishedAt) {
      context.addIssue({ code: "custom", message: "next validation predates completion" });
    }
    if (input.decision.evaluatedAt > input.finishedAt) {
      context.addIssue({ code: "custom", message: "decision timestamp exceeds completion" });
    }
    if (!hasValidDecisionWindow(input.decision.value.windowStart, input.decision.evaluatedAt)) {
      context.addIssue({ code: "custom", message: "decision window duration is invalid" });
    }
  });

export interface CompleteDomainValidationRunInput {
  runId: string;
  leaseId: string;
  leaseGeneration: number;
  finishedAt: number;
  nextValidationAt: number;
  failureStreak: number;
  attempts: Array<{
    id: string;
    attemptedAt: number;
    result: DirectProbeResult | ProxyProbeResult;
  }>;
  decision: {
    id: string;
    evaluatedAt: number;
    value: CandidateDecision;
    selectedScope: "exact" | "site";
    proposedRule: string;
  };
}

export function completeDomainValidationRun(db: Db, input: CompleteDomainValidationRunInput): void {
  const parsed = completeValidationRunSchema.parse(input);
  db.transaction((tx) => {
    const run = tx
      .select()
      .from(domainValidationRuns)
      .where(eq(domainValidationRuns.id, parsed.runId))
      .get();
    if (
      run?.status !== "running" ||
      run.leaseId !== parsed.leaseId ||
      run.leaseGeneration !== parsed.leaseGeneration
    ) {
      throw new Error("validation run or lease is not active");
    }
    if (
      parsed.finishedAt < run.startedAt ||
      parsed.decision.evaluatedAt < run.startedAt ||
      parsed.attempts.some(
        (attempt) =>
          attempt.attemptedAt < run.startedAt || attempt.attemptedAt > parsed.decision.evaluatedAt,
      )
    ) {
      throw new RangeError("validation evidence is outside the run or decision interval");
    }
    const candidate = tx
      .select()
      .from(domainCandidates)
      .where(eq(domainCandidates.fqdn, run.fqdn))
      .get();
    if (
      !candidate ||
      candidate.status === "excluded" ||
      candidate.leaseId !== parsed.leaseId ||
      candidate.leaseGeneration !== parsed.leaseGeneration ||
      candidate.leaseUntil === null ||
      candidate.leaseUntil <= parsed.finishedAt ||
      candidate.updatedAt > parsed.finishedAt
    ) {
      throw new Error("validation lease is not active at completion");
    }
    if (
      candidate.selectedScope !== parsed.decision.selectedScope ||
      candidate.proposedRule !== parsed.decision.proposedRule ||
      serializeDomainRule(
        { fqdn: candidate.fqdn, registrableSite: candidate.registrableSite },
        parsed.decision.selectedScope,
      ) !== parsed.decision.proposedRule
    ) {
      throw new Error("persisted decision scope does not match the candidate");
    }

    if (parsed.attempts.length > 0) {
      tx.insert(domainValidationAttempts)
        .values(
          parsed.attempts.map((attempt) => ({
            id: attempt.id,
            runId: run.id,
            direction: attempt.result.direction,
            attemptedAt: attempt.attemptedAt,
            category: attempt.result.category,
            transportSuccess: attempt.result.transportSuccess,
            httpStatus: attempt.result.httpStatus,
            resolvedAddress: attempt.result.resolvedAddress,
            availableAddressCount: attempt.result.availableAddressCount,
            connectDurationMs: attempt.result.connectDurationMs,
            tlsDurationMs: attempt.result.tlsDurationMs,
            totalDurationMs: attempt.result.totalDurationMs,
            redirectCount: attempt.result.redirectCount,
            finalOrigin: attempt.result.finalOrigin,
          })),
        )
        .run();
    }
    const finishedRun = tx
      .update(domainValidationRuns)
      .set({ status: "completed", finishedAt: parsed.finishedAt, errorCategory: null })
      .where(
        and(
          eq(domainValidationRuns.id, run.id),
          eq(domainValidationRuns.leaseId, parsed.leaseId),
          eq(domainValidationRuns.leaseGeneration, parsed.leaseGeneration),
          eq(domainValidationRuns.status, "running"),
        ),
      )
      .run().changes;
    if (finishedRun !== 1) throw new Error("validation run lease was lost");
    tx.insert(domainDecisions)
      .values({
        id: parsed.decision.id,
        fqdn: run.fqdn,
        evaluatedAt: parsed.decision.evaluatedAt,
        status: parsed.decision.value.status,
        confidence: parsed.decision.value.confidence,
        reasons: parsed.decision.value.reasons,
        windowStart: parsed.decision.value.windowStart,
        evidence: parsed.decision.value.evidence,
        selectedScope: parsed.decision.selectedScope,
        proposedRule: parsed.decision.proposedRule,
      })
      .run();
    const updatedCandidate = tx
      .update(domainCandidates)
      .set({
        status: parsed.decision.value.status,
        nextValidationAt: parsed.nextValidationAt,
        lastValidationAt: parsed.decision.evaluatedAt,
        failureStreak: parsed.failureStreak,
        leaseId: null,
        leaseUntil: null,
        updatedAt: parsed.finishedAt,
      })
      .where(
        and(
          eq(domainCandidates.fqdn, run.fqdn),
          eq(domainCandidates.leaseId, parsed.leaseId),
          eq(domainCandidates.leaseGeneration, parsed.leaseGeneration),
          gt(domainCandidates.leaseUntil, parsed.finishedAt),
          lte(domainCandidates.updatedAt, parsed.finishedAt),
          ne(domainCandidates.status, "excluded"),
        ),
      )
      .run().changes;
    if (updatedCandidate !== 1) throw new Error("validation candidate lease was lost");
  });
}

const failValidationRunSchema = z
  .object({
    runId: identifierSchema,
    leaseId: identifierSchema,
    leaseGeneration: z.number().int().min(1).max(1_000_000_000),
    finishedAt: timestampSchema,
    status: z.enum(["failed", "cancelled"]),
    errorCategory: z.enum(DOMAIN_VALIDATION_RUN_ERROR_CATEGORIES),
    nextValidationAt: timestampSchema,
    failureStreak: z.number().int().min(0).max(1_000_000),
  })
  .strict();

export function failDomainValidationRun(
  db: Db,
  input: {
    runId: string;
    leaseId: string;
    leaseGeneration: number;
    finishedAt: number;
    status: "failed" | "cancelled";
    errorCategory: DomainValidationRunErrorCategory;
    nextValidationAt: number;
    failureStreak: number;
  },
): void {
  const parsed = failValidationRunSchema.parse(input);
  db.transaction((tx) => {
    const run = tx
      .select()
      .from(domainValidationRuns)
      .where(eq(domainValidationRuns.id, parsed.runId))
      .get();
    if (
      run?.status !== "running" ||
      run.leaseId !== parsed.leaseId ||
      run.leaseGeneration !== parsed.leaseGeneration
    ) {
      throw new Error("validation run or lease is not active");
    }
    if (parsed.finishedAt < run.startedAt || parsed.nextValidationAt < parsed.finishedAt) {
      throw new RangeError("invalid validation failure timestamps");
    }
    const candidate = tx
      .select()
      .from(domainCandidates)
      .where(eq(domainCandidates.fqdn, run.fqdn))
      .get();
    if (
      !candidate ||
      candidate.status === "excluded" ||
      candidate.leaseId !== parsed.leaseId ||
      candidate.leaseGeneration !== parsed.leaseGeneration ||
      candidate.leaseUntil === null ||
      candidate.leaseUntil <= parsed.finishedAt ||
      candidate.updatedAt > parsed.finishedAt
    ) {
      throw new Error("validation lifecycle timestamp or lease is not active at failure");
    }
    const finishedRun = tx
      .update(domainValidationRuns)
      .set({
        status: parsed.status,
        finishedAt: parsed.finishedAt,
        errorCategory: parsed.errorCategory,
      })
      .where(
        and(
          eq(domainValidationRuns.id, run.id),
          eq(domainValidationRuns.leaseId, parsed.leaseId),
          eq(domainValidationRuns.leaseGeneration, parsed.leaseGeneration),
          eq(domainValidationRuns.status, "running"),
        ),
      )
      .run().changes;
    if (finishedRun !== 1) throw new Error("validation run lease was lost");
    const updatedCandidate = tx
      .update(domainCandidates)
      .set({
        status: "pending",
        nextValidationAt: parsed.nextValidationAt,
        failureStreak: parsed.failureStreak,
        leaseId: null,
        leaseUntil: null,
        updatedAt: parsed.finishedAt,
      })
      .where(
        and(
          eq(domainCandidates.fqdn, run.fqdn),
          eq(domainCandidates.leaseId, parsed.leaseId),
          eq(domainCandidates.leaseGeneration, parsed.leaseGeneration),
          gt(domainCandidates.leaseUntil, parsed.finishedAt),
          lte(domainCandidates.updatedAt, parsed.finishedAt),
          ne(domainCandidates.status, "excluded"),
        ),
      )
      .run().changes;
    if (updatedCandidate !== 1) throw new Error("validation candidate lease was lost");
  });
}

const persistedAttemptRowSchema = z
  .object({
    id: identifierSchema,
    runId: identifierSchema,
    direction: z.enum(["direct", "proxy"]),
    attemptedAt: timestampSchema,
    category: z.enum(PROBE_CATEGORIES),
    transportSuccess: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    resolvedAddress: z.string().min(2).max(45).nullable(),
    availableAddressCount: boundedCountSchema,
    connectDurationMs: nullableDurationSchema,
    tlsDurationMs: nullableDurationSchema,
    totalDurationMs: z.number().int().min(0).max(60_000),
    redirectCount: z.number().int().min(0).max(5),
    finalOrigin: safeOriginSchema.nullable(),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      !probeResultSchema.safeParse({
        direction: row.direction,
        category: row.category,
        transportSuccess: row.transportSuccess,
        httpStatus: row.httpStatus,
        resolvedAddress: row.resolvedAddress,
        availableAddressCount: row.availableAddressCount,
        connectDurationMs: row.connectDurationMs,
        tlsDurationMs: row.tlsDurationMs,
        totalDurationMs: row.totalDurationMs,
        redirectCount: row.redirectCount,
        finalOrigin: row.finalOrigin,
      }).success
    ) {
      context.addIssue({ code: "custom", message: "persisted validation attempt is invalid" });
    }
  });

export function listDomainValidationAttempts(
  db: Db,
  runId: string,
): Array<typeof domainValidationAttempts.$inferSelect> {
  const parsedRunId = identifierSchema.parse(runId);
  return z
    .array(persistedAttemptRowSchema)
    .parse(
      db
        .select()
        .from(domainValidationAttempts)
        .where(eq(domainValidationAttempts.runId, parsedRunId))
        .all(),
    );
}

export function countDomainObservationsInWindow(
  db: Db,
  input: { fqdn: string; since: number; until: number },
): number {
  const fqdn = fqdnSchema.parse(input.fqdn);
  const since = timestampSchema.parse(input.since);
  const until = timestampSchema.parse(input.until);
  if (until < since) throw new RangeError("observation window is inverted");
  const count = db
    .select({ count: sql<number>`coalesce(sum(${domainObservations.count}), 0)` })
    .from(domainObservations)
    .where(
      and(
        eq(domainObservations.fqdn, fqdn),
        gte(domainObservations.observedAt, since),
        lte(domainObservations.observedAt, until),
      ),
    )
    .get()?.count;
  return z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .parse(count ?? 0);
}

export function listDomainCandidateValidationEvidence(
  db: Db,
  input: { fqdn: string; since: number; until: number },
): { direct: ValidationAttempt[]; proxy: ValidationAttempt[] } {
  const fqdn = fqdnSchema.parse(input.fqdn);
  const since = timestampSchema.parse(input.since);
  const until = timestampSchema.parse(input.until);
  if (until < since) throw new RangeError("validation evidence window is inverted");
  const rows = db
    .select({ attempt: domainValidationAttempts })
    .from(domainValidationAttempts)
    .innerJoin(domainValidationRuns, eq(domainValidationAttempts.runId, domainValidationRuns.id))
    .where(
      and(
        eq(domainValidationRuns.fqdn, fqdn),
        eq(domainValidationRuns.status, "completed"),
        gte(domainValidationAttempts.attemptedAt, since),
        lte(domainValidationAttempts.attemptedAt, until),
      ),
    )
    .orderBy(domainValidationAttempts.attemptedAt, domainValidationAttempts.id)
    .all();
  const result: { direct: ValidationAttempt[]; proxy: ValidationAttempt[] } = {
    direct: [],
    proxy: [],
  };
  for (const { attempt } of rows) {
    const parsed = persistedAttemptRowSchema.parse(attempt);
    result[parsed.direction].push({
      attemptId: parsed.id,
      attemptedAt: parsed.attemptedAt,
      category: parsed.category,
      transportSuccess: parsed.transportSuccess,
      httpStatus: parsed.httpStatus,
      resolvedAddress: parsed.resolvedAddress,
      availableAddressCount: parsed.availableAddressCount,
      finalOrigin: parsed.finalOrigin,
    });
  }
  return result;
}

const persistedDecisionRowSchema = z
  .object({
    id: identifierSchema,
    fqdn: fqdnSchema,
    evaluatedAt: timestampSchema,
    status: z.enum(CANDIDATE_DECISION_STATUSES),
    confidence: z.enum(CANDIDATE_DECISION_CONFIDENCES),
    reasons: z.array(z.enum(CANDIDATE_DECISION_REASONS)).max(CANDIDATE_DECISION_REASONS.length),
    windowStart: timestampSchema.nullable(),
    evidence: decisionEvidenceSchema,
    selectedScope: ruleScopeSchema.nullable(),
    proposedRule: proposedRuleSchema.nullable(),
  })
  .strict()
  .superRefine((row, context) => {
    const decisionResult = candidateDecisionSchema.safeParse({
      status: row.status,
      confidence: row.confidence,
      reasons: row.reasons,
      windowStart: row.windowStart,
      evidence: row.evidence,
    });
    if (!decisionResult.success) {
      context.addIssue({ code: "custom", message: "persisted decision is invalid" });
    }
    if (!hasValidDecisionWindow(row.windowStart, row.evaluatedAt)) {
      context.addIssue({ code: "custom", message: "persisted decision window is invalid" });
    }
    if ((row.selectedScope === null) !== (row.proposedRule === null)) {
      context.addIssue({ code: "custom", message: "persisted decision scope is incomplete" });
    }
    if (row.status === "confirmed" && (row.selectedScope === null || row.proposedRule === null)) {
      context.addIssue({ code: "custom", message: "confirmed decision requires a rule" });
    }
    if (row.selectedScope === "exact" && row.proposedRule !== row.fqdn) {
      context.addIssue({ code: "custom", message: "exact decision rule does not match FQDN" });
    }
    if (row.selectedScope === "site" && row.proposedRule !== null) {
      const site = row.proposedRule.startsWith("+.") ? row.proposedRule.slice(2) : "";
      if (
        !site ||
        normalizeObservedFqdn(site) !== site ||
        (row.fqdn !== site && !row.fqdn.endsWith(`.${site}`))
      ) {
        context.addIssue({ code: "custom", message: "site decision rule does not cover FQDN" });
      }
    }
  });

interface RawReportDecisionRow {
  id: string;
  fqdn: string;
  evaluatedAt: number;
  status: (typeof CANDIDATE_DECISION_STATUSES)[number];
  confidence: (typeof CANDIDATE_DECISION_CONFIDENCES)[number];
  reasonsJson: string;
  reasonsLength: number;
  reasonsNulOffset: number;
  reasonsStorageType: string;
  windowStart: number | null;
  evidenceJson: string;
  evidenceLength: number;
  evidenceNulOffset: number;
  evidenceStorageType: string;
  selectedScope: "exact" | "site" | null;
  proposedRule: string | null;
}

const MAX_DECISION_REASONS_JSON_LENGTH = 1_024;
const MAX_DECISION_EVIDENCE_JSON_LENGTH = 2_048;

const rawReportDecisionSelection = {
  id: domainDecisions.id,
  fqdn: domainDecisions.fqdn,
  evaluatedAt: domainDecisions.evaluatedAt,
  status: domainDecisions.status,
  confidence: domainDecisions.confidence,
  reasonsJson: sql<string>`cast(substr(
    cast(${domainDecisions.reasons} as blob),
    1,
    ${MAX_DECISION_REASONS_JSON_LENGTH + 1}
  ) as text)`,
  reasonsLength: sql<number>`length(cast(${domainDecisions.reasons} as blob))`,
  reasonsNulOffset: sql<number>`instr(cast(${domainDecisions.reasons} as blob), x'00')`,
  reasonsStorageType: sql<string>`typeof(${domainDecisions.reasons})`,
  windowStart: domainDecisions.windowStart,
  evidenceJson: sql<string>`cast(substr(
    cast(${domainDecisions.evidence} as blob),
    1,
    ${MAX_DECISION_EVIDENCE_JSON_LENGTH + 1}
  ) as text)`,
  evidenceLength: sql<number>`length(cast(${domainDecisions.evidence} as blob))`,
  evidenceNulOffset: sql<number>`instr(cast(${domainDecisions.evidence} as blob), x'00')`,
  evidenceStorageType: sql<string>`typeof(${domainDecisions.evidence})`,
  selectedScope: domainDecisions.selectedScope,
  proposedRule: domainDecisions.proposedRule,
} as const;

function parseRawReportDecision(
  row: RawReportDecisionRow,
): z.infer<typeof persistedDecisionRowSchema> | null {
  if (
    row.reasonsStorageType !== "text" ||
    !Number.isSafeInteger(row.reasonsLength) ||
    row.reasonsLength < 2 ||
    row.reasonsLength > MAX_DECISION_REASONS_JSON_LENGTH ||
    row.reasonsNulOffset !== 0 ||
    Buffer.byteLength(row.reasonsJson, "utf8") !== row.reasonsLength ||
    row.evidenceStorageType !== "text" ||
    !Number.isSafeInteger(row.evidenceLength) ||
    row.evidenceLength < 2 ||
    row.evidenceLength > MAX_DECISION_EVIDENCE_JSON_LENGTH ||
    row.evidenceNulOffset !== 0 ||
    Buffer.byteLength(row.evidenceJson, "utf8") !== row.evidenceLength
  ) {
    return null;
  }
  try {
    const reasons: unknown = JSON.parse(row.reasonsJson);
    const evidence: unknown = JSON.parse(row.evidenceJson);
    const parsed = persistedDecisionRowSchema.safeParse({
      id: row.id,
      fqdn: row.fqdn,
      evaluatedAt: row.evaluatedAt,
      status: row.status,
      confidence: row.confidence,
      reasons,
      windowStart: row.windowStart,
      evidence,
      selectedScope: row.selectedScope,
      proposedRule: row.proposedRule,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function getDomainDecision(
  db: Db,
  decisionId: string,
): typeof domainDecisions.$inferSelect | undefined {
  const parsedId = identifierSchema.parse(decisionId);
  const row = db.select().from(domainDecisions).where(eq(domainDecisions.id, parsedId)).get();
  return row === undefined ? undefined : persistedDecisionRowSchema.parse(row);
}

const DOMAIN_REPORT_DAYS = 14;
const CANDIDATE_STATUSES = ["queued", "pending", "confirmed", "blocked", "excluded"] as const;
const BLOCKING_REPORT_REASONS = new Set<string>(CANDIDATE_DECISION_BLOCKING_REASONS);

function firstBlockingReportReason(
  reasons: readonly (typeof CANDIDATE_DECISION_REASONS)[number][],
): DomainReportExclusionReason {
  return reasons.find((reason) => BLOCKING_REPORT_REASONS.has(reason)) ?? "invalid-evidence";
}

export interface DomainIntelligenceOverviewInput {
  now: number;
  health: DomainObserverHealth;
}

export function getDomainIntelligenceOverview(
  db: Db,
  input: DomainIntelligenceOverviewInput,
): DomainIntelligenceOverview {
  const now = timestampSchema.parse(input.now);
  const dayStart = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const from = Math.max(0, dayStart - (DOMAIN_REPORT_DAYS - 1) * DAY_MS);
  const fromDay = utcDay(from);
  const toDay = utcDay(now);
  const dailyAggregates = db
    .select({
      day: domainDailyStats.day,
      connectionCount: sql<number>`cast(sum(${domainDailyStats.connectionCount}) as integer)`,
      uniqueDomainCount: sql<number>`cast(count(*) as integer)`,
    })
    .from(domainDailyStats)
    .where(and(gte(domainDailyStats.day, fromDay), lte(domainDailyStats.day, toDay)))
    .groupBy(domainDailyStats.day)
    .orderBy(domainDailyStats.day)
    .all();

  const candidateCounts: Record<DomainCandidateStatus, number> = {
    queued: 0,
    pending: 0,
    confirmed: 0,
    blocked: 0,
    excluded: 0,
  };
  for (const row of db
    .select({
      status: domainCandidates.status,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(domainCandidates)
    .groupBy(domainCandidates.status)
    .all()) {
    candidateCounts[row.status] += row.count;
  }

  const exclusionCountByReason = new Map<DomainReportExclusionReason, number>();
  const addExclusionCount = (reason: DomainReportExclusionReason, count = 1): void => {
    exclusionCountByReason.set(reason, (exclusionCountByReason.get(reason) ?? 0) + count);
  };
  const storedExclusionReason = sql<DomainReportExclusionReason>`coalesce(
    ${domainCandidates.exclusionReason},
    'invalid-policy'
  )`;
  for (const row of db
    .select({
      reason: storedExclusionReason,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(domainCandidates)
    .where(and(eq(domainCandidates.reviewState, "active"), eq(domainCandidates.status, "excluded")))
    .groupBy(storedExclusionReason)
    .all()) {
    addExclusionCount(row.reason, row.count);
  }
  const rejectedCount = db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(domainCandidates)
    .where(eq(domainCandidates.reviewState, "rejected"))
    .get()?.count;
  if (rejectedCount) addExclusionCount("user-rejected", rejectedCount);

  let missingDecisions = 0;
  for (const row of db
    .select({
      status: domainCandidates.status,
      reviewState: domainCandidates.reviewState,
      count: sql<number>`cast(count(*) as integer)`,
    })
    .from(domainCandidates)
    .where(
      and(
        inArray(domainCandidates.status, ["confirmed", "blocked"]),
        sql`not exists (
          select 1
          from domain_decisions integrity_decision
          where integrity_decision.fqdn = ${domainCandidates.fqdn}
        )`,
      ),
    )
    .groupBy(domainCandidates.status, domainCandidates.reviewState)
    .all()) {
    missingDecisions += row.count;
    if (row.reviewState === "active" && row.status === "blocked") {
      addExclusionCount("invalid-evidence", row.count);
    }
  }

  let invalidDecisions = 0;
  let decisionCursor: string | undefined;
  const decisionPageSize = 250;
  for (;;) {
    const decisionConditions = [
      sql`not exists (
        select 1
        from domain_decisions newer_integrity_decision
        where newer_integrity_decision.fqdn = ${domainDecisions.fqdn}
          and (
            newer_integrity_decision.evaluated_at > ${domainDecisions.evaluatedAt}
            or (
              newer_integrity_decision.evaluated_at = ${domainDecisions.evaluatedAt}
              and newer_integrity_decision.id > ${domainDecisions.id}
            )
          )
      )`,
    ];
    if (decisionCursor !== undefined) {
      decisionConditions.push(gt(domainCandidates.fqdn, decisionCursor));
    }
    const decisionPage = db
      .select({
        candidateStatus: domainCandidates.status,
        candidateReviewState: domainCandidates.reviewState,
        ...rawReportDecisionSelection,
      })
      .from(domainCandidates)
      .innerJoin(domainDecisions, eq(domainDecisions.fqdn, domainCandidates.fqdn))
      .where(and(...decisionConditions))
      .orderBy(domainCandidates.fqdn)
      .limit(decisionPageSize)
      .all();
    for (const row of decisionPage) {
      const decision = parseRawReportDecision(row);
      const terminalStatus =
        row.candidateStatus === "confirmed" || row.candidateStatus === "blocked";
      if (decision === null || (terminalStatus && decision.status !== row.candidateStatus)) {
        invalidDecisions += 1;
        if (row.candidateReviewState === "active" && row.candidateStatus === "blocked") {
          addExclusionCount("invalid-evidence");
        }
      } else if (row.candidateReviewState === "active" && row.candidateStatus === "blocked") {
        addExclusionCount(firstBlockingReportReason(decision.reasons));
      }
    }
    if (decisionPage.length < decisionPageSize) break;
    decisionCursor = decisionPage.at(-1)?.fqdn;
    if (decisionCursor === undefined) break;
  }
  const exclusionCounts = [...exclusionCountByReason]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
  const lifecycleTotal = Object.values(candidateCounts).reduce((total, count) => total + count, 0);
  const exclusionTotal = exclusionCounts.reduce((total, item) => total + item.count, 0);
  const bucketCounts = {
    candidate: lifecycleTotal - exclusionTotal,
    exclusion: exclusionTotal,
  };

  return domainIntelligenceOverviewSchema.parse({
    generatedAt: now,
    period: { from, to: now },
    health: input.health,
    dailyAggregates,
    candidateCounts,
    bucketCounts,
    evidenceIntegrityCounts: { missingDecisions, invalidDecisions },
    exclusionCounts,
  });
}

type DomainReportFilterPolicy = DomainFilterPolicy;

function safeDefaultDomainIntelligenceSettings(): DomainIntelligenceReportSettings {
  return domainIntelligenceReportSettingsSchema.parse(DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS);
}

export function getDomainIntelligenceSettingsView(
  db: Db,
  deployment: DomainIntelligenceDeploymentCapability = domainRulesDeploymentCapability,
): DomainIntelligenceSettingsView {
  const raw = getSetting(db, "domainIntelligence");
  if (raw === undefined) {
    const storedRow = db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, "domainIntelligence"))
      .get();
    return domainIntelligenceSettingsViewSchema.parse({
      configurationState: storedRow ? "invalid" : "unconfigured",
      settings: safeDefaultDomainIntelligenceSettings(),
      deployment,
    });
  }
  if (raw.includes("\0") || Buffer.byteLength(raw, "utf8") > MAX_SETTING_VALUE_BYTES) {
    return domainIntelligenceSettingsViewSchema.parse({
      configurationState: "invalid",
      settings: safeDefaultDomainIntelligenceSettings(),
      deployment,
    });
  }
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    stored = null;
  }
  const parsed = domainIntelligenceReportSettingsSchema.safeParse(stored);
  return domainIntelligenceSettingsViewSchema.parse({
    configurationState: parsed.success
      ? parsed.data.defaultRuleScope === null
        ? "unconfigured"
        : "ready"
      : "invalid",
    settings: parsed.success ? parsed.data : safeDefaultDomainIntelligenceSettings(),
    deployment,
  });
}

export function setDomainIntelligenceReportSettings(
  db: Db,
  input: DomainIntelligenceReportSettings,
  deployment: DomainIntelligenceDeploymentCapability = domainRulesDeploymentCapability,
): DomainIntelligenceSettingsView {
  const parsed = domainIntelligenceReportSettingsSchema.parse(input);
  const value = JSON.stringify(parsed);
  if (Buffer.byteLength(value, "utf8") > MAX_SETTING_VALUE_BYTES) {
    throw new RangeError("domain intelligence settings exceed the storage limit");
  }
  const filterPolicy = {
    excludedTlds: parsed.excludedTlds,
    neverAddDomains: parsed.neverAddDomains,
    neverAddSuffixes: parsed.neverAddSuffixes,
    nonWidenableSuffixes: parsed.nonWidenableSuffixes,
    telemetryPatterns: parsed.telemetryPatterns,
  };
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(settings)
      .values({ key: "domainIntelligence", value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();

    for (const existing of tx.select().from(domainCandidates).all()) {
      const running = tx
        .select({ startedAt: domainValidationRuns.startedAt })
        .from(domainValidationRuns)
        .where(
          and(
            eq(domainValidationRuns.fqdn, existing.fqdn),
            eq(domainValidationRuns.status, "running"),
          ),
        )
        .all();
      const changedAt = Math.max(now, existing.updatedAt, ...running.map((run) => run.startedAt));
      const candidate = deriveDomainCandidate(
        existing.fqdn,
        filterPolicy,
        existing.selectedScope ?? parsed.defaultRuleScope ?? "exact",
      );
      const excluded =
        !candidate || candidate.excluded || !candidate.selectedScope || !candidate.proposedRule;
      const selectedScope = excluded ? null : candidate.selectedScope;
      const proposedRule = excluded ? null : candidate.proposedRule;
      const proposalChanged =
        selectedScope !== existing.selectedScope || proposedRule !== existing.proposedRule;
      if (!excluded && !proposalChanged) continue;

      tx.update(domainValidationRuns)
        .set({ status: "cancelled", finishedAt: changedAt, errorCategory: "policy-changed" })
        .where(
          and(
            eq(domainValidationRuns.fqdn, existing.fqdn),
            eq(domainValidationRuns.status, "running"),
            lte(domainValidationRuns.startedAt, changedAt),
          ),
        )
        .run();
      tx.update(domainCandidates)
        .set({
          registrableSite: candidate?.registrableSite ?? existing.registrableSite,
          selectedScope,
          proposedRule,
          exclusionReason: excluded ? (candidate?.exclusionReason ?? "invalid-policy") : null,
          status: excluded ? "excluded" : "queued",
          nextValidationAt: excluded ? MAX_DATE_MS : changedAt,
          leaseId: null,
          leaseUntil: null,
          updatedAt: changedAt,
        })
        .where(eq(domainCandidates.fqdn, existing.fqdn))
        .run();
    }
  });
  return domainIntelligenceSettingsViewSchema.parse({
    configurationState: parsed.defaultRuleScope === null ? "unconfigured" : "ready",
    settings: parsed,
    deployment,
  });
}

interface UpdateDomainIntelligenceReportSettingsDeps {
  reconcile: () => Promise<DomainIntelligenceSettingsMutationResult>;
}

export async function updateDomainIntelligenceReportSettings(
  db: Db,
  input: DomainIntelligenceReportSettings,
  deps: UpdateDomainIntelligenceReportSettingsDeps,
): Promise<DomainIntelligenceSettingsMutationResult> {
  setDomainIntelligenceReportSettings(db, input);
  return domainIntelligenceSettingsMutationResultSchema.parse(await deps.reconcile());
}

export function readDomainIntelligenceFilterPolicy(db: Db): DomainFilterPolicy | null {
  const view = getDomainIntelligenceSettingsView(db);
  if (view.configurationState !== "ready") return null;
  return filterPolicySchema.parse({
    excludedTlds: view.settings.excludedTlds,
    neverAddDomains: view.settings.neverAddDomains,
    neverAddSuffixes: view.settings.neverAddSuffixes,
    nonWidenableSuffixes: view.settings.nonWidenableSuffixes,
    telemetryPatterns: view.settings.telemetryPatterns,
  });
}

export function listDomainCandidateReport(
  db: Db,
  input: DomainCandidateListInput,
  filterPolicy: DomainReportFilterPolicy | null,
): DomainCandidateList {
  const conditions = [
    input.view === "candidates"
      ? and(
          eq(domainCandidates.reviewState, "active"),
          inArray(domainCandidates.status, ["queued", "pending", "confirmed"]),
        )
      : input.view === "exclusions"
        ? or(
            eq(domainCandidates.reviewState, "rejected"),
            inArray(domainCandidates.status, ["blocked", "excluded"]),
          )
        : inArray(domainCandidates.status, CANDIDATE_STATUSES),
  ];
  if (input.cursor !== undefined) conditions.push(gt(domainCandidates.fqdn, input.cursor));
  const rows = db
    .select({
      fqdn: domainCandidates.fqdn,
      registrableSite: domainCandidates.registrableSite,
      selectedScope: domainCandidates.selectedScope,
      proposedRule: domainCandidates.proposedRule,
      exclusionReason: domainCandidates.exclusionReason,
      status: domainCandidates.status,
      reviewState: domainCandidates.reviewState,
      firstSeenAt: domainCandidates.firstSeenAt,
      lastSeenAt: domainCandidates.lastSeenAt,
      nextValidationAt: domainCandidates.nextValidationAt,
      lastValidationAt: domainCandidates.lastValidationAt,
    })
    .from(domainCandidates)
    .where(and(...conditions))
    .orderBy(domainCandidates.fqdn)
    .limit(input.limit + 1)
    .all();
  const page = rows.slice(0, input.limit);
  const fqdns = page.map((row) => row.fqdn);

  const connectionCounts = new Map<string, number>();
  const latestDecisions = new Map<string, RawReportDecisionRow>();
  const latestAttempts = new Map<
    string,
    Omit<typeof domainValidationAttempts.$inferSelect, "resolvedAddress" | "availableAddressCount">
  >();
  if (fqdns.length > 0) {
    for (const row of db
      .select({
        fqdn: domainDailyStats.fqdn,
        count: sql<number>`cast(sum(${domainDailyStats.connectionCount}) as integer)`,
      })
      .from(domainDailyStats)
      .where(inArray(domainDailyStats.fqdn, fqdns))
      .groupBy(domainDailyStats.fqdn)
      .all()) {
      connectionCounts.set(row.fqdn, row.count);
    }
    for (const row of db
      .select(rawReportDecisionSelection)
      .from(domainDecisions)
      .where(
        and(
          inArray(domainDecisions.fqdn, fqdns),
          sql`not exists (
            select 1
            from domain_decisions newer_domain_decision
            where newer_domain_decision.fqdn = ${domainDecisions.fqdn}
              and (
                newer_domain_decision.evaluated_at > ${domainDecisions.evaluatedAt}
                or (
                  newer_domain_decision.evaluated_at = ${domainDecisions.evaluatedAt}
                  and newer_domain_decision.id > ${domainDecisions.id}
                )
              )
          )`,
        ),
      )
      .orderBy(
        asc(domainDecisions.fqdn),
        desc(domainDecisions.evaluatedAt),
        desc(domainDecisions.id),
      )
      .limit(fqdns.length)
      .all()) {
      if (!latestDecisions.has(row.fqdn)) latestDecisions.set(row.fqdn, row);
    }
    for (const row of db
      .select({
        fqdn: domainValidationRuns.fqdn,
        id: domainValidationAttempts.id,
        runId: domainValidationAttempts.runId,
        direction: domainValidationAttempts.direction,
        attemptedAt: domainValidationAttempts.attemptedAt,
        category: domainValidationAttempts.category,
        transportSuccess: domainValidationAttempts.transportSuccess,
        httpStatus: domainValidationAttempts.httpStatus,
        connectDurationMs: domainValidationAttempts.connectDurationMs,
        tlsDurationMs: domainValidationAttempts.tlsDurationMs,
        totalDurationMs: domainValidationAttempts.totalDurationMs,
        redirectCount: domainValidationAttempts.redirectCount,
        finalOrigin: domainValidationAttempts.finalOrigin,
      })
      .from(domainValidationAttempts)
      .innerJoin(domainValidationRuns, eq(domainValidationRuns.id, domainValidationAttempts.runId))
      .where(
        and(
          inArray(domainValidationRuns.fqdn, fqdns),
          sql`not exists (
            select 1
            from domain_validation_attempts newer_domain_attempt
            inner join domain_validation_runs newer_domain_run
              on newer_domain_run.id = newer_domain_attempt.run_id
            where newer_domain_run.fqdn = ${domainValidationRuns.fqdn}
              and newer_domain_attempt.direction = ${domainValidationAttempts.direction}
              and (
                newer_domain_attempt.attempted_at > ${domainValidationAttempts.attemptedAt}
                or (
                  newer_domain_attempt.attempted_at = ${domainValidationAttempts.attemptedAt}
                  and newer_domain_attempt.id > ${domainValidationAttempts.id}
                )
              )
          )`,
        ),
      )
      .orderBy(
        asc(domainValidationRuns.fqdn),
        desc(domainValidationAttempts.attemptedAt),
        desc(domainValidationAttempts.id),
      )
      .limit(fqdns.length * 2)
      .all()) {
      const key = `${row.fqdn}:${row.direction}`;
      if (latestAttempts.has(key)) continue;
      const { fqdn: _fqdn, ...attempt } = row;
      latestAttempts.set(key, attempt);
    }
  }

  const items = page.map((row) => {
    const derived = filterPolicy
      ? deriveDomainCandidate(row.fqdn, filterPolicy, row.selectedScope ?? "exact")
      : null;
    const eligibleScopes =
      row.status === "excluded" ? [] : derived && !derived.excluded ? derived.eligibleScopes : [];
    const policyExclusionReason =
      derived?.excluded === true ? (derived.exclusionReason ?? "invalid-policy") : null;
    const siteUnavailableReason =
      filterPolicy === null
        ? "policy-unavailable"
        : derived?.excluded
          ? "policy-excluded"
          : (derived?.siteUnavailableReason ?? null);
    const expectedRule =
      row.selectedScope === "exact"
        ? row.fqdn
        : derived?.registrableSite
          ? `+.${derived.registrableSite}`
          : null;
    const scopeValid =
      row.status !== "excluded" &&
      derived !== null &&
      !derived.excluded &&
      row.selectedScope !== null &&
      row.proposedRule === expectedRule &&
      eligibleScopes.some((scope) => scope === row.selectedScope);
    const status = row.status;
    const decisionRow = latestDecisions.get(row.fqdn);
    const parsedDecision = decisionRow ? parseRawReportDecision(decisionRow) : null;
    const terminalStatus = status === "confirmed" || status === "blocked";
    const decision =
      parsedDecision !== null && (!terminalStatus || parsedDecision.status === status)
        ? parsedDecision
        : null;
    const evidenceIntegrityIssue =
      decisionRow === undefined
        ? terminalStatus
          ? ("missing-decision" as const)
          : null
        : decision === null
          ? ("invalid-decision" as const)
          : null;
    const direct = latestAttempts.get(`${row.fqdn}:direct`);
    const proxy = latestAttempts.get(`${row.fqdn}:proxy`);
    const attemptView = (attempt: typeof direct) =>
      attempt
        ? {
            attemptedAt: attempt.attemptedAt,
            category: attempt.category,
            transportSuccess: attempt.transportSuccess,
            httpStatus: attempt.httpStatus,
            connectDurationMs: attempt.connectDurationMs,
            tlsDurationMs: attempt.tlsDurationMs,
            totalDurationMs: attempt.totalDurationMs,
            redirectCount: attempt.redirectCount,
            finalOrigin: attempt.finalOrigin,
          }
        : null;
    const bucket =
      row.reviewState === "rejected" || status === "blocked" || status === "excluded"
        ? "exclusion"
        : "candidate";
    return {
      fqdn: row.fqdn,
      siteGroup: derived?.registrableSite ?? row.registrableSite ?? row.fqdn,
      bucket,
      reviewState: row.reviewState,
      status,
      selectedScope: filterPolicy === null ? null : row.selectedScope,
      proposedRule: filterPolicy === null ? null : row.proposedRule,
      eligibleScopes,
      scopeValid,
      siteUnavailableReason,
      policyExclusionReason,
      exclusionReason:
        row.reviewState === "rejected"
          ? "user-rejected"
          : status === "excluded"
            ? row.exclusionReason
            : status === "blocked"
              ? decision
                ? firstBlockingReportReason(decision.reasons)
                : "invalid-evidence"
              : null,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      lastValidationAt: row.lastValidationAt,
      nextValidationAt:
        row.reviewState === "rejected" || row.status === "excluded" ? null : row.nextValidationAt,
      connectionCount: connectionCounts.get(row.fqdn) ?? 0,
      evidenceAvailable: decision !== null,
      evidenceIntegrityIssue,
      decision: decision
        ? {
            evaluatedAt: decision.evaluatedAt,
            status: decision.status,
            confidence: decision.confidence,
            reasons: decision.reasons,
            windowStart: decision.windowStart,
            evidence: decision.evidence,
          }
        : null,
      latestAttempts: {
        direct: attemptView(direct),
        proxy: attemptView(proxy),
      },
    };
  });

  return domainCandidateListSchema.parse({
    items,
    nextCursor: rows.length > input.limit ? (page.at(-1)?.fqdn ?? null) : null,
  });
}

export function pruneDomainIntelligence(db: Db, now: number): DomainRetentionResult {
  if (
    !Number.isSafeInteger(now) ||
    now < DOMAIN_OPERATIONAL_RETENTION_DAYS * DAY_MS ||
    now > MAX_DATE_MS
  ) {
    throw new RangeError("invalid domain retention timestamp");
  }
  const cutoff = now - DOMAIN_OPERATIONAL_RETENTION_DAYS * DAY_MS;
  return db.transaction((tx) => {
    const observations = tx
      .delete(domainObservations)
      .where(lt(domainObservations.lastSeenAt, cutoff))
      .run().changes;
    const dailyStats = tx
      .delete(domainDailyStats)
      .where(lt(domainDailyStats.lastSeenAt, cutoff))
      .run().changes;
    const staleValidationAttempts = tx
      .delete(domainValidationAttempts)
      .where(sql`exists (
        select 1
        from domain_validation_runs stale_run
        join domain_candidates stale_candidate on stale_candidate.fqdn = stale_run.fqdn
        where stale_run.id = ${domainValidationAttempts.runId}
          and stale_candidate.last_seen_at < ${cutoff}
          and (stale_candidate.lease_until is null or stale_candidate.lease_until <= ${now})
          and not exists (
            select 1 from domain_validation_runs active_run
            where active_run.fqdn = stale_candidate.fqdn
              and active_run.status = 'running'
          )
      )`)
      .run().changes;
    const staleDecisions = tx
      .delete(domainDecisions)
      .where(sql`exists (
        select 1
        from domain_candidates stale_candidate
        where stale_candidate.fqdn = ${domainDecisions.fqdn}
          and stale_candidate.last_seen_at < ${cutoff}
          and (stale_candidate.lease_until is null or stale_candidate.lease_until <= ${now})
          and not exists (
            select 1 from domain_validation_runs active_run
            where active_run.fqdn = stale_candidate.fqdn
              and active_run.status = 'running'
          )
      )`)
      .run().changes;
    const staleValidationRuns = tx
      .delete(domainValidationRuns)
      .where(
        and(
          ne(domainValidationRuns.status, "running"),
          sql`exists (
            select 1
            from domain_candidates stale_candidate
            where stale_candidate.fqdn = ${domainValidationRuns.fqdn}
              and stale_candidate.last_seen_at < ${cutoff}
              and (stale_candidate.lease_until is null or stale_candidate.lease_until <= ${now})
              and not exists (
                select 1 from domain_validation_runs active_run
                where active_run.fqdn = stale_candidate.fqdn
                  and active_run.status = 'running'
              )
          )`,
        ),
      )
      .run().changes;
    const agedValidationAttempts = tx
      .delete(domainValidationAttempts)
      .where(
        and(
          lt(domainValidationAttempts.attemptedAt, cutoff),
          sql`not exists (
            select 1
            from domain_validation_runs retention_run
            join domain_candidates retention_candidate on retention_candidate.fqdn = retention_run.fqdn
            where retention_run.id = ${domainValidationAttempts.runId}
              and retention_candidate.lease_until > ${now}
          )`,
        ),
      )
      .run().changes;
    const agedValidationRuns = tx
      .delete(domainValidationRuns)
      .where(
        and(
          ne(domainValidationRuns.status, "running"),
          lt(domainValidationRuns.finishedAt, cutoff),
          sql`not exists (
            select 1
            from domain_candidates retention_candidate
            where retention_candidate.fqdn = ${domainValidationRuns.fqdn}
              and retention_candidate.lease_until > ${now}
          )`,
          sql`not exists (
            select 1
            from domain_validation_attempts retained_attempt
            where retained_attempt.run_id = ${domainValidationRuns.id}
              and retained_attempt.attempted_at >= ${cutoff}
          )`,
        ),
      )
      .run().changes;
    const agedDecisions = tx
      .delete(domainDecisions)
      .where(
        and(
          lt(domainDecisions.evaluatedAt, cutoff),
          sql`not exists (
            select 1
            from domain_candidates retention_candidate
            where retention_candidate.fqdn = ${domainDecisions.fqdn}
              and retention_candidate.lease_until > ${now}
          )`,
        ),
      )
      .run().changes;
    const candidates = tx
      .delete(domainCandidates)
      .where(
        and(
          lt(domainCandidates.lastSeenAt, cutoff),
          or(isNull(domainCandidates.leaseUntil), lte(domainCandidates.leaseUntil, now)),
          sql`not exists (
            select 1 from domain_validation_runs retained_run
            where retained_run.fqdn = ${domainCandidates.fqdn}
          )`,
          sql`not exists (
            select 1 from domain_decisions retained_decision
            where retained_decision.fqdn = ${domainCandidates.fqdn}
          )`,
        ),
      )
      .run().changes;
    return {
      observations,
      dailyStats,
      candidates,
      validationRuns: staleValidationRuns + agedValidationRuns,
      validationAttempts: staleValidationAttempts + agedValidationAttempts,
      decisions: staleDecisions + agedDecisions,
    };
  });
}
