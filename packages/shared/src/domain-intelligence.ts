import { z } from "zod";

const MAX_DATE_MS = 8_640_000_000_000_000;
const timestampSchema = z.number().int().min(0).max(MAX_DATE_MS);
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const evidenceCountSchema = z.number().int().min(0).max(1_024);
const nullableDurationSchema = z.number().int().min(0).max(60_000).nullable();
const INTERNAL_DOMAIN_SUFFIXES = [
  "localhost",
  "local",
  "lan",
  "home.arpa",
  "in-addr.arpa",
  "ip6.arpa",
] as const;

function hasDomainSuffix(fqdn: string, suffix: string): boolean {
  return fqdn === suffix || fqdn.endsWith(`.${suffix}`);
}

function isIpv4LikeHost(labels: readonly string[]): boolean {
  return labels.every((label) => /^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(label));
}

const fqdnSchema = z
  .string()
  .min(3)
  .max(253)
  .refine((value) => {
    const labels = value.split(".");
    return (
      value === value.toLowerCase() &&
      !value.endsWith(".") &&
      labels.length >= 2 &&
      !isIpv4LikeHost(labels) &&
      !INTERNAL_DOMAIN_SUFFIXES.some((suffix) => hasDomainSuffix(value, suffix)) &&
      labels.every((label) => {
        return (
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
        );
      })
    );
  }, "FQDN must be canonical ASCII");

const proposedRuleSchema = z
  .string()
  .min(3)
  .max(255)
  .refine(
    (value) => fqdnSchema.safeParse(value.startsWith("+.") ? value.slice(2) : value).success,
    {
      message: "rule must contain a canonical domain",
    },
  );

const safeOriginSchema = z
  .string()
  .min(9)
  .max(2_048)
  .pipe(z.url())
  .refine((value) => {
    if (!value.startsWith("https://")) return false;
    const authority = value.slice("https://".length);
    if (authority === "" || /[/@?#]/u.test(authority)) return false;
    const portSeparator = authority.lastIndexOf(":");
    const hostname = portSeparator === -1 ? authority : authority.slice(0, portSeparator);
    const port = portSeparator === -1 ? null : authority.slice(portSeparator + 1);
    return (
      fqdnSchema.safeParse(hostname).success &&
      (port === null || (/^[0-9]{1,5}$/u.test(port) && Number(port) >= 1 && Number(port) <= 65_535))
    );
  }, "origin must be sanitized HTTPS");

export const domainRuleScopeSchema = z.enum(["exact", "site"]);
export type DomainRuleScope = z.infer<typeof domainRuleScopeSchema>;

const policyLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
const policyDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .refine((value) => {
    const labels = value.split(".");
    return (
      labels.length >= 2 && labels.every((label) => policyLabelSchema.safeParse(label).success)
    );
  }, "policy domain must be canonical ASCII");
const telemetryPatternSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (value) => value.split(".").every((label) => policyLabelSchema.safeParse(label).success),
    "telemetry pattern must be canonical ASCII",
  );
const externalResolverSchema = z.enum([
  "https://dns.google/resolve",
  "https://cloudflare-dns.com/dns-query",
]);

function uniqueArray<T extends z.ZodType>(item: T, maximum: number) {
  return z
    .array(item)
    .max(maximum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: "settings values must be unique" });
      }
    });
}

export const domainIntelligenceReportSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.literal("report"),
    retentionDays: z.literal(14),
    minimumConnectionCount: z.number().int().min(3).max(1_000),
    directAttemptsRequired: z.number().int().min(3).max(24),
    minimumAttemptSpacingMinutes: z.number().int().min(120).max(1_440),
    validationWindowHours: z.literal(24),
    minimumProxySuccesses: z.number().int().min(2).max(24),
    maximumProxyTransportFailures: z.literal(0),
    maximumCandidatesPerRun: z.number().int().min(1).max(20),
    maximumAutomaticRulesPerDay: z.number().int().min(1).max(100),
    maxConcurrency: z.number().int().min(1).max(2),
    requestTimeoutMs: z.number().int().min(1_000).max(30_000),
    defaultRuleScope: domainRuleScopeSchema.nullable(),
    automationMode: z.enum(["off", "review"]),
    automaticConsentRevision: z.null(),
    externalResolvers: uniqueArray(externalResolverSchema, 4).min(2),
    excludedTlds: uniqueArray(policyLabelSchema, 256),
    neverAddDomains: uniqueArray(policyDomainSchema, 4_096),
    neverAddSuffixes: uniqueArray(policyDomainSchema, 4_096),
    nonWidenableSuffixes: uniqueArray(policyDomainSchema, 4_096),
    telemetryPatterns: uniqueArray(telemetryPatternSchema, 4_096),
    customProviderUrl: z.literal(""),
    customTargetChannelId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    applyEnabled: z.literal(false),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.maxConcurrency > settings.maximumCandidatesPerRun) {
      context.addIssue({
        code: "custom",
        path: ["maxConcurrency"],
        message: "validation concurrency cannot exceed the run capacity",
      });
    }
    if (settings.enabled !== (settings.automationMode === "review")) {
      context.addIssue({ code: "custom", message: "report automation state is inconsistent" });
    }
    if (settings.enabled && settings.defaultRuleScope === null) {
      context.addIssue({ code: "custom", message: "enabled reports require an explicit scope" });
    }
  });
export type DomainIntelligenceReportSettings = z.infer<
  typeof domainIntelligenceReportSettingsSchema
>;

export const DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS = {
  enabled: false,
  mode: "report",
  retentionDays: 14,
  minimumConnectionCount: 3,
  directAttemptsRequired: 3,
  minimumAttemptSpacingMinutes: 120,
  validationWindowHours: 24,
  minimumProxySuccesses: 2,
  maximumProxyTransportFailures: 0,
  maximumCandidatesPerRun: 20,
  maximumAutomaticRulesPerDay: 3,
  maxConcurrency: 2,
  requestTimeoutMs: 8_000,
  defaultRuleScope: null,
  automationMode: "off",
  automaticConsentRevision: null,
  externalResolvers: ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"],
  excludedTlds: ["ru", "su", "xn--p1ai"],
  neverAddDomains: [],
  neverAddSuffixes: [],
  nonWidenableSuffixes: [
    "googleapis.com",
    "cloudflare.com",
    "vercel.app",
    "githubusercontent.com",
    "github.io",
    "amazonaws.com",
    "cloudfront.net",
    "fastly.net",
    "akamaized.net",
  ],
  telemetryPatterns: [
    "ads",
    "adservice",
    "analytics",
    "beacon",
    "metrics",
    "telemetry",
    "tracker",
    "tracking",
  ],
  customProviderUrl: "",
  customTargetChannelId: "default",
  applyEnabled: false,
} as const satisfies DomainIntelligenceReportSettings;

export const domainIntelligenceSettingsViewSchema = z
  .object({
    configurationState: z.enum(["unconfigured", "ready", "invalid"]),
    settings: domainIntelligenceReportSettingsSchema,
    automatic: z
      .object({
        available: z.literal(false),
        reason: z.literal("publisher-unavailable"),
      })
      .strict(),
  })
  .strict()
  .superRefine((view, context) => {
    if (
      view.configurationState !== "ready" &&
      (view.settings.enabled ||
        view.settings.automationMode !== "off" ||
        view.settings.defaultRuleScope !== null)
    ) {
      context.addIssue({ code: "custom", message: "unavailable settings must fail closed" });
    }
    if (view.configurationState === "unconfigured" && view.settings.defaultRuleScope !== null) {
      context.addIssue({ code: "custom", message: "unconfigured settings cannot choose a scope" });
    }
    if (view.configurationState === "ready" && view.settings.defaultRuleScope === null) {
      context.addIssue({ code: "custom", message: "ready settings require an explicit scope" });
    }
  });
export type DomainIntelligenceSettingsView = z.infer<typeof domainIntelligenceSettingsViewSchema>;

export const domainIntelligenceSettingsMutationResultSchema = z
  .object({
    view: domainIntelligenceSettingsViewSchema,
    applied: z.boolean(),
  })
  .strict();
export type DomainIntelligenceSettingsMutationResult = z.infer<
  typeof domainIntelligenceSettingsMutationResultSchema
>;

export const domainCandidateReviewStateSchema = z.enum(["active", "rejected"]);
export type DomainCandidateReviewState = z.infer<typeof domainCandidateReviewStateSchema>;

export const domainCandidateStatusSchema = z.enum([
  "queued",
  "pending",
  "confirmed",
  "blocked",
  "excluded",
]);
export type DomainCandidateStatus = z.infer<typeof domainCandidateStatusSchema>;

export const domainExclusionReasonSchema = z.enum([
  "excluded-tld",
  "never-add-domain",
  "never-add-suffix",
  "telemetry-pattern",
  "invalid-policy",
]);
export type DomainExclusionReason = z.infer<typeof domainExclusionReasonSchema>;

export const domainDecisionReasonSchema = z.enum([
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
]);
export type DomainDecisionReason = z.infer<typeof domainDecisionReasonSchema>;

export const domainReportExclusionReasonSchema = z.union([
  domainExclusionReasonSchema,
  domainDecisionReasonSchema,
  z.literal("user-rejected"),
]);
export type DomainReportExclusionReason = z.infer<typeof domainReportExclusionReasonSchema>;

export const domainProbeCategorySchema = z.enum([
  "http_response",
  "dns_failure",
  "unsafe_address",
  "ipv6_unavailable",
  "unsafe_redirect",
  "redirect_limit",
  "connect_timeout",
  "tls_timeout",
  "tls_handshake_reset",
  "connection_reset_before_http",
  "tls_error",
  "network_error",
  "total_timeout",
  "proxy_auth_failure",
  "route_proof_failure",
  "infrastructure_error",
]);
export type DomainProbeCategory = z.infer<typeof domainProbeCategorySchema>;

export const domainObserverHealthSchema = z
  .object({
    status: z.enum(["inactive", "accumulating", "healthy", "degraded"]),
    reason: z.enum([
      "disabled",
      "awaiting-domain-traffic",
      "awaiting-correlation",
      "correlated",
      "parser-drift",
      "snapshot-error",
    ]),
    snapshotDomainConnections: countSchema,
    correlatedConnections: countSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type DomainObserverHealth = z.infer<typeof domainObserverHealthSchema>;

const candidateDecisionEvidenceSchema = z
  .object({
    directQualifyingFailures: evidenceCountSchema,
    directSpacedFailures: evidenceCountSchema,
    directAddressDiversityRequired: z.boolean(),
    directAddressDiversitySatisfied: z.boolean(),
    proxyHttpSuccesses: evidenceCountSchema,
    proxyTransportFailures: evidenceCountSchema,
    proxyUncertainFailures: evidenceCountSchema,
  })
  .strict();

const BLOCKING_DECISION_REASONS = new Set<DomainDecisionReason>([
  "invalid-policy",
  "invalid-evidence",
  "observer-unhealthy",
  "candidate-excluded",
  "invalid-scope",
  "coverage-incomplete",
  "already-covered",
  "proxy-unstable",
  "proxy-evidence-uncertain",
]);

function isEmptyEvidence(evidence: z.infer<typeof candidateDecisionEvidenceSchema>): boolean {
  return (
    evidence.directQualifyingFailures === 0 &&
    evidence.directSpacedFailures === 0 &&
    !evidence.directAddressDiversityRequired &&
    !evidence.directAddressDiversitySatisfied &&
    evidence.proxyHttpSuccesses === 0 &&
    evidence.proxyTransportFailures === 0 &&
    evidence.proxyUncertainFailures === 0
  );
}

const candidateDecisionSchema = z
  .object({
    evaluatedAt: timestampSchema,
    status: z.enum(["confirmed", "pending", "blocked"]),
    confidence: z.enum(["none", "low", "high"]),
    reasons: z.array(domainDecisionReasonSchema).max(32),
    windowStart: timestampSchema.nullable(),
    evidence: candidateDecisionEvidenceSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    if (new Set(decision.reasons).size !== decision.reasons.length) {
      context.addIssue({ code: "custom", message: "decision reasons must be unique" });
    }
    const expectedStatus = decision.reasons.some((reason) => BLOCKING_DECISION_REASONS.has(reason))
      ? "blocked"
      : decision.reasons.length > 0
        ? "pending"
        : "confirmed";
    const expectedConfidence =
      decision.status === "confirmed" ? "high" : decision.status === "pending" ? "low" : "none";
    if (decision.status !== expectedStatus) {
      context.addIssue({ code: "custom", message: "decision status does not match reasons" });
    }
    if (decision.confidence !== expectedConfidence) {
      context.addIssue({ code: "custom", message: "decision confidence does not match status" });
    }
    if (decision.evidence.directSpacedFailures > decision.evidence.directQualifyingFailures) {
      context.addIssue({ code: "custom", message: "spaced failures exceed qualifying failures" });
    }
    const exactFailClosed =
      decision.status === "blocked" &&
      decision.reasons.length === 1 &&
      (decision.reasons[0] === "invalid-policy" || decision.reasons[0] === "invalid-evidence") &&
      isEmptyEvidence(decision.evidence);
    if (decision.windowStart === null && !exactFailClosed) {
      context.addIssue({ code: "custom", message: "decision window is missing" });
    }
    if (decision.reasons[0] === "invalid-policy" && decision.windowStart !== null) {
      context.addIssue({ code: "custom", message: "invalid policy cannot have a window" });
    }
    if (
      decision.windowStart !== null &&
      (decision.evaluatedAt - decision.windowStart < 60 * 60 * 1_000 ||
        decision.evaluatedAt - decision.windowStart > 24 * 60 * 60 * 1_000)
    ) {
      context.addIssue({ code: "custom", message: "decision window is outside report bounds" });
    }
    if (
      !exactFailClosed &&
      !decision.evidence.directAddressDiversityRequired &&
      !decision.evidence.directAddressDiversitySatisfied
    ) {
      context.addIssue({ code: "custom", message: "address diversity summary is inconsistent" });
    }
    if (
      decision.status === "confirmed" &&
      (decision.evidence.directQualifyingFailures < 3 ||
        decision.evidence.directSpacedFailures < 3 ||
        !decision.evidence.directAddressDiversitySatisfied ||
        decision.evidence.proxyHttpSuccesses < 2 ||
        decision.evidence.proxyTransportFailures !== 0 ||
        decision.evidence.proxyUncertainFailures !== 0)
    ) {
      context.addIssue({ code: "custom", message: "confirmed decision lacks hard evidence" });
    }
  });

const latestAttemptSchema = z
  .object({
    attemptedAt: timestampSchema,
    category: domainProbeCategorySchema,
    transportSuccess: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    connectDurationMs: nullableDurationSchema,
    tlsDurationMs: nullableDurationSchema,
    totalDurationMs: z.number().int().min(0).max(60_000),
    redirectCount: z.number().int().min(0).max(5),
    finalOrigin: safeOriginSchema.nullable(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const isHttpResponse = attempt.category === "http_response";
    if (isHttpResponse !== (attempt.transportSuccess && attempt.httpStatus !== null)) {
      context.addIssue({ code: "custom", message: "attempt HTTP result is inconsistent" });
    }
    if (!isHttpResponse && attempt.transportSuccess) {
      context.addIssue({ code: "custom", message: "attempt failure cannot be successful" });
    }
    const categoryCarriesHttpStatus =
      attempt.category === "unsafe_redirect" || attempt.category === "redirect_limit";
    if (
      !isHttpResponse &&
      ((categoryCarriesHttpStatus && attempt.httpStatus === null) ||
        (!categoryCarriesHttpStatus && attempt.httpStatus !== null))
    ) {
      context.addIssue({ code: "custom", message: "attempt failure status is inconsistent" });
    }
    if (
      (attempt.connectDurationMs !== null && attempt.connectDurationMs > attempt.totalDurationMs) ||
      (attempt.tlsDurationMs !== null && attempt.tlsDurationMs > attempt.totalDurationMs)
    ) {
      context.addIssue({ code: "custom", message: "attempt phase exceeds total duration" });
    }
  });

const eligibleScopesSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("exact")]),
  z.tuple([z.literal("exact"), z.literal("site")]),
]);

export const domainCandidateReportItemSchema = z
  .object({
    fqdn: fqdnSchema,
    siteGroup: fqdnSchema,
    bucket: z.enum(["candidate", "exclusion"]),
    reviewState: domainCandidateReviewStateSchema,
    status: domainCandidateStatusSchema,
    selectedScope: domainRuleScopeSchema.nullable(),
    proposedRule: proposedRuleSchema.nullable(),
    eligibleScopes: eligibleScopesSchema,
    scopeValid: z.boolean(),
    siteUnavailableReason: z
      .enum(["public-suffix", "non-widenable-suffix", "policy-unavailable", "policy-excluded"])
      .nullable(),
    exclusionReason: domainReportExclusionReasonSchema.nullable(),
    policyExclusionReason: domainExclusionReasonSchema.nullable(),
    firstSeenAt: timestampSchema,
    lastSeenAt: timestampSchema,
    lastValidationAt: timestampSchema.nullable(),
    nextValidationAt: timestampSchema.nullable(),
    connectionCount: countSchema,
    evidenceAvailable: z.boolean(),
    evidenceIntegrityIssue: z.enum(["missing-decision", "invalid-decision"]).nullable(),
    decision: candidateDecisionSchema.nullable(),
    latestAttempts: z
      .object({
        direct: latestAttemptSchema.nullable(),
        proxy: latestAttemptSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((item, context) => {
    if ((item.selectedScope === null) !== (item.proposedRule === null)) {
      context.addIssue({ code: "custom", message: "scope and rule must be paired" });
    }
    if (item.status === "excluded" && item.bucket !== "exclusion") {
      context.addIssue({ code: "custom", message: "excluded candidate must use exclusion bucket" });
    }
    const expectedBucket =
      item.reviewState === "rejected" || item.status === "blocked" || item.status === "excluded"
        ? "exclusion"
        : "candidate";
    if (item.bucket !== expectedBucket) {
      context.addIssue({ code: "custom", message: "candidate bucket does not match status" });
    }
    if ((item.bucket === "exclusion") !== (item.exclusionReason !== null)) {
      context.addIssue({ code: "custom", message: "exclusion bucket requires one safe reason" });
    }
    if (
      item.reviewState === "rejected" &&
      (item.exclusionReason !== "user-rejected" || item.nextValidationAt !== null)
    ) {
      context.addIssue({ code: "custom", message: "rejected candidate shape is inconsistent" });
    }
    if (item.reviewState === "active" && item.exclusionReason === "user-rejected") {
      context.addIssue({ code: "custom", message: "active candidate cannot be user-rejected" });
    }
    if (item.status === "excluded") {
      if (
        item.selectedScope !== null ||
        item.proposedRule !== null ||
        item.eligibleScopes.length !== 0 ||
        item.scopeValid ||
        item.exclusionReason === null ||
        item.nextValidationAt !== null
      ) {
        context.addIssue({ code: "custom", message: "excluded candidate shape is inconsistent" });
      }
    } else if (
      item.siteUnavailableReason !== "policy-unavailable" &&
      (item.selectedScope === null || item.proposedRule === null)
    ) {
      context.addIssue({ code: "custom", message: "eligible candidate requires a scoped rule" });
    }
    if (item.siteUnavailableReason === "policy-unavailable") {
      if (
        item.selectedScope !== null ||
        item.proposedRule !== null ||
        item.eligibleScopes.length !== 0 ||
        item.scopeValid ||
        item.policyExclusionReason !== null
      ) {
        context.addIssue({ code: "custom", message: "unavailable policy must fail closed" });
      }
    }
    if (
      item.scopeValid &&
      item.selectedScope &&
      !item.eligibleScopes.some((scope) => scope === item.selectedScope)
    ) {
      context.addIssue({ code: "custom", message: "valid scope must remain eligible" });
    }
    if (item.scopeValid && item.selectedScope === "exact" && item.proposedRule !== item.fqdn) {
      context.addIssue({ code: "custom", message: "exact rule must match FQDN" });
    }
    if (
      item.scopeValid &&
      item.selectedScope === "site" &&
      (item.proposedRule !== `+.${item.siteGroup}` || !hasDomainSuffix(item.fqdn, item.siteGroup))
    ) {
      context.addIssue({ code: "custom", message: "site rule must match the site group" });
    }
    if (
      item.eligibleScopes.some((scope) => scope === "site") &&
      item.siteUnavailableReason !== null
    ) {
      context.addIssue({ code: "custom", message: "eligible site cannot have a restriction" });
    }
    if (
      item.policyExclusionReason !== null &&
      (item.eligibleScopes.length !== 0 ||
        item.scopeValid ||
        item.siteUnavailableReason !== "policy-excluded")
    ) {
      context.addIssue({ code: "custom", message: "current policy exclusion is inconsistent" });
    }
    if (item.siteUnavailableReason === "policy-excluded" && item.policyExclusionReason === null) {
      context.addIssue({ code: "custom", message: "policy exclusion reason is missing" });
    }
    if (item.firstSeenAt > item.lastSeenAt) {
      context.addIssue({ code: "custom", message: "candidate chronology is inconsistent" });
    }
    if (item.evidenceAvailable !== (item.decision !== null)) {
      context.addIssue({ code: "custom", message: "evidence availability is inconsistent" });
    }
    if (item.evidenceAvailable && item.evidenceIntegrityIssue !== null) {
      context.addIssue({ code: "custom", message: "available evidence cannot have an issue" });
    }
    if (item.evidenceIntegrityIssue !== null && item.decision !== null) {
      context.addIssue({ code: "custom", message: "invalid evidence cannot expose a decision" });
    }
    if (
      item.evidenceIntegrityIssue === "missing-decision" &&
      item.status !== "confirmed" &&
      item.status !== "blocked"
    ) {
      context.addIssue({ code: "custom", message: "only terminal status can miss a decision" });
    }
    if (
      (item.status === "confirmed" || item.status === "blocked") &&
      !item.evidenceAvailable &&
      item.evidenceIntegrityIssue === null
    ) {
      context.addIssue({ code: "custom", message: "terminal status requires an integrity issue" });
    }
    if (
      item.status === "confirmed" &&
      item.evidenceAvailable &&
      item.decision?.status !== "confirmed"
    ) {
      context.addIssue({ code: "custom", message: "confirmed candidate requires a decision" });
    }
    if (
      item.status === "blocked" &&
      item.evidenceAvailable &&
      item.decision?.status !== "blocked"
    ) {
      context.addIssue({ code: "custom", message: "blocked candidate requires a decision" });
    }
    if (item.status === "blocked" && item.reviewState === "active") {
      const expectedReason =
        item.decision?.reasons.find((reason) => BLOCKING_DECISION_REASONS.has(reason)) ??
        "invalid-evidence";
      if (item.exclusionReason !== expectedReason) {
        context.addIssue({ code: "custom", message: "blocked candidate reason is inconsistent" });
      }
    }
  });
export type DomainCandidateReportItem = z.infer<typeof domainCandidateReportItemSchema>;

export const domainCandidateScopeActionInputSchema = z
  .object({ fqdn: fqdnSchema, selectedScope: domainRuleScopeSchema })
  .strict();
export type DomainCandidateScopeActionInput = z.infer<typeof domainCandidateScopeActionInputSchema>;

export const domainCandidateRejectionActionInputSchema = z
  .object({ fqdn: fqdnSchema, rejected: z.boolean() })
  .strict();
export type DomainCandidateRejectionActionInput = z.infer<
  typeof domainCandidateRejectionActionInputSchema
>;

export const domainCandidateRecheckActionInputSchema = z.object({ fqdn: fqdnSchema }).strict();
export type DomainCandidateRecheckActionInput = z.infer<
  typeof domainCandidateRecheckActionInputSchema
>;

export const domainCandidateReviewActionResultSchema = z
  .object({
    fqdn: fqdnSchema,
    reviewState: domainCandidateReviewStateSchema,
    status: domainCandidateStatusSchema,
    selectedScope: domainRuleScopeSchema.nullable(),
    proposedRule: proposedRuleSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.selectedScope === null) !== (result.proposedRule === null)) {
      context.addIssue({ code: "custom", message: "scope and rule must be paired" });
    }
    if (result.status === "excluded" && result.selectedScope !== null) {
      context.addIssue({ code: "custom", message: "excluded candidate cannot expose a rule" });
    }
    if (result.status !== "excluded" && result.selectedScope === null) {
      context.addIssue({ code: "custom", message: "eligible candidate requires a rule" });
    }
    if (result.selectedScope === "exact" && result.proposedRule !== result.fqdn) {
      context.addIssue({ code: "custom", message: "exact rule must match FQDN" });
    }
    if (
      result.selectedScope === "site" &&
      (result.proposedRule === null ||
        !result.proposedRule.startsWith("+.") ||
        !hasDomainSuffix(result.fqdn, result.proposedRule.slice(2)))
    ) {
      context.addIssue({ code: "custom", message: "site rule must cover FQDN" });
    }
  });
export type DomainCandidateReviewActionResult = z.infer<
  typeof domainCandidateReviewActionResultSchema
>;

export const domainCandidateReviewErrorReasonSchema = z.enum([
  "candidate-not-found",
  "candidate-rejected",
  "candidate-excluded",
  "policy-unavailable",
  "scope-unavailable",
  "validation-in-progress",
]);
export type DomainCandidateReviewErrorReason = z.infer<
  typeof domainCandidateReviewErrorReasonSchema
>;

export const domainCandidateReviewMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), candidate: domainCandidateReviewActionResultSchema }).strict(),
  z.object({ ok: z.literal(false), reason: domainCandidateReviewErrorReasonSchema }).strict(),
]);
export type DomainCandidateReviewMutationResult = z.infer<
  typeof domainCandidateReviewMutationResultSchema
>;

export const domainCandidateListInputSchema = z
  .object({
    view: z.enum(["candidates", "exclusions", "all"]).default("candidates"),
    cursor: fqdnSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type DomainCandidateListInput = z.infer<typeof domainCandidateListInputSchema>;

export const domainCandidateListSchema = z
  .object({
    items: z.array(domainCandidateReportItemSchema).max(100),
    nextCursor: fqdnSchema.nullable(),
  })
  .strict();
export type DomainCandidateList = z.infer<typeof domainCandidateListSchema>;

export const domainIntelligenceOverviewSchema = z
  .object({
    generatedAt: timestampSchema,
    period: z
      .object({
        from: timestampSchema,
        to: timestampSchema,
      })
      .strict(),
    health: domainObserverHealthSchema,
    dailyAggregates: z
      .array(
        z
          .object({
            day: z.iso.date(),
            connectionCount: countSchema,
            uniqueDomainCount: countSchema,
          })
          .strict(),
      )
      .max(14),
    candidateCounts: z
      .object({
        queued: countSchema,
        pending: countSchema,
        confirmed: countSchema,
        blocked: countSchema,
        excluded: countSchema,
      })
      .strict(),
    bucketCounts: z
      .object({
        candidate: countSchema,
        exclusion: countSchema,
      })
      .strict(),
    evidenceIntegrityCounts: z
      .object({
        missingDecisions: countSchema,
        invalidDecisions: countSchema,
      })
      .strict(),
    exclusionCounts: z
      .array(
        z
          .object({
            reason: domainReportExclusionReasonSchema,
            count: countSchema,
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .superRefine((overview, context) => {
    if (overview.period.from > overview.period.to || overview.period.to !== overview.generatedAt) {
      context.addIssue({ code: "custom", message: "report period is inconsistent" });
    }
    const lifecycleTotal = Object.values(overview.candidateCounts).reduce(
      (total, count) => total + count,
      0,
    );
    if (overview.bucketCounts.candidate + overview.bucketCounts.exclusion !== lifecycleTotal) {
      context.addIssue({ code: "custom", message: "report bucket counts are inconsistent" });
    }
    const mandatoryExclusionTotal =
      overview.candidateCounts.blocked + overview.candidateCounts.excluded;
    if (overview.bucketCounts.exclusion < mandatoryExclusionTotal) {
      context.addIssue({
        code: "custom",
        message: "blocked and excluded candidates require exclusion buckets",
      });
    }
    const exclusionTotal = overview.exclusionCounts.reduce((total, item) => total + item.count, 0);
    if (overview.bucketCounts.exclusion !== exclusionTotal) {
      context.addIssue({ code: "custom", message: "exclusion counts are inconsistent" });
    }
    if (
      new Set(overview.exclusionCounts.map((item) => item.reason)).size !==
      overview.exclusionCounts.length
    ) {
      context.addIssue({ code: "custom", message: "exclusion reasons must be unique" });
    }
  });
export type DomainIntelligenceOverview = z.infer<typeof domainIntelligenceOverviewSchema>;
