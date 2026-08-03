import { and, desc, eq, gt, gte, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
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
} from "../../db/schema.js";
import {
  CANDIDATE_DECISION_CONFIDENCES,
  CANDIDATE_DECISION_REASONS,
  CANDIDATE_DECISION_STATUSES,
  type CandidateDecision,
  decisionConfidenceForStatus,
  decisionStatusForReasons,
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
          ne(domainCandidates.status, "excluded"),
          isNotNull(domainCandidates.selectedScope),
          isNotNull(domainCandidates.proposedRule),
          lte(domainCandidates.nextValidationAt, parsed.now),
          lte(domainCandidates.updatedAt, parsed.now),
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
        eq(domainValidationRuns.errorCategory, "infrastructure-failure"),
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
      !candidate ||
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
    attempts: z.array(persistedAttemptInputSchema).length(2),
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
    if (!directions.has("direct") || !directions.has("proxy")) {
      context.addIssue({
        code: "custom",
        message: "one DIRECT and one PROXY attempt are required",
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
      try {
        if (
          !site ||
          serializeDomainRule({ fqdn: row.fqdn, registrableSite: site }, "site") !==
            row.proposedRule
        ) {
          throw new Error("site rule mismatch");
        }
      } catch {
        context.addIssue({ code: "custom", message: "site decision rule does not cover FQDN" });
      }
    }
  });

export function getDomainDecision(
  db: Db,
  decisionId: string,
): typeof domainDecisions.$inferSelect | undefined {
  const parsedId = identifierSchema.parse(decisionId);
  const row = db.select().from(domainDecisions).where(eq(domainDecisions.id, parsedId)).get();
  return row === undefined ? undefined : persistedDecisionRowSchema.parse(row);
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
    const validationAttempts = tx
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
    const validationRuns = tx
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
    const decisions = tx
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
          lt(domainCandidates.updatedAt, cutoff),
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
      validationRuns,
      validationAttempts,
      decisions,
    };
  });
}
