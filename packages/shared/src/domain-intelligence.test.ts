import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  domainCandidateListInputSchema,
  domainCandidateListSchema,
  domainCandidateRecheckActionInputSchema,
  domainCandidateRejectionActionInputSchema,
  domainCandidateReviewActionResultSchema,
  domainCandidateReviewMutationResultSchema,
  domainCandidateScopeActionInputSchema,
  domainIntelligenceOverviewSchema,
  domainIntelligenceReportSettingsSchema,
  domainIntelligenceSettingsMutationResultSchema,
  domainIntelligenceSettingsViewSchema,
  domainProbeCategorySchema,
} from "./domain-intelligence.js";

const health = {
  status: "healthy" as const,
  reason: "correlated" as const,
  snapshotDomainConnections: 12,
  correlatedConnections: 10,
  updatedAt: Date.parse("2026-08-03T12:00:00.000Z"),
};

describe("domain intelligence shared contracts", () => {
  it("keeps report settings disabled and unconfigured until scope is explicit", () => {
    expect(
      domainIntelligenceSettingsViewSchema.parse({
        configurationState: "unconfigured",
        settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        automatic: { available: false, reason: "publisher-unavailable" },
      }),
    ).toMatchObject({
      configurationState: "unconfigured",
      settings: { enabled: false, mode: "report", defaultRuleScope: null },
      automatic: { available: false },
    });

    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        enabled: true,
        automationMode: "review",
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        maximumCandidatesPerRun: 1,
        maxConcurrency: 2,
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        maximumAutomaticRulesPerDay: 4,
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        mode: "apply",
        applyEnabled: true,
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        automationMode: "automatic",
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        externalResolvers: [
          "https://user:password@dns.example/resolve",
          "https://dns.google/resolve",
        ],
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        customProviderUrl: "https://rules.example/custom.txt?token=secret",
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        externalResolvers: [
          "https://resolver.example/token/example-secret/dns-query",
          "https://dns.google/resolve",
        ],
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        customProviderUrl: "https://rules.example/token/ghp_example_secret/custom.txt",
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceSettingsViewSchema.parse({
        configurationState: "ready",
        settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        automatic: { available: false, reason: "publisher-unavailable" },
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceSettingsViewSchema.parse({
        configurationState: "ready",
        settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
        automatic: { available: true, reason: null },
      }),
    ).toThrow();
  });

  it("accepts only internally consistent report settings mutation results", () => {
    const enabled = {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled: true,
      defaultRuleScope: "site" as const,
      automationMode: "review" as const,
    };
    const view = {
      configurationState: "ready" as const,
      settings: enabled,
      automatic: { available: false as const, reason: "publisher-unavailable" as const },
    };

    expect(domainIntelligenceSettingsMutationResultSchema.parse({ view, applied: true })).toEqual({
      view,
      applied: true,
    });
    expect(() =>
      domainIntelligenceReportSettingsSchema.parse({
        ...enabled,
        automationMode: "off",
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceSettingsMutationResultSchema.parse({
        view,
        applied: true,
        repositoryToken: "secret",
      }),
    ).toThrow();
  });

  it("strictly validates the only three report-mode review actions", () => {
    expect(
      domainCandidateScopeActionInputSchema.parse({
        fqdn: "api.service.example",
        selectedScope: "site",
      }),
    ).toEqual({ fqdn: "api.service.example", selectedScope: "site" });
    expect(
      domainCandidateRejectionActionInputSchema.parse({
        fqdn: "api.service.example",
        rejected: true,
      }),
    ).toEqual({ fqdn: "api.service.example", rejected: true });
    expect(domainCandidateRecheckActionInputSchema.parse({ fqdn: "api.service.example" })).toEqual({
      fqdn: "api.service.example",
    });
    expect(
      domainCandidateReviewActionResultSchema.parse({
        fqdn: "api.service.example",
        reviewState: "active",
        status: "queued",
        selectedScope: "site",
        proposedRule: "+.service.example",
      }),
    ).toMatchObject({ reviewState: "active", proposedRule: "+.service.example" });
    expect(
      domainCandidateReviewMutationResultSchema.parse({
        ok: true,
        candidate: {
          fqdn: "api.service.example",
          reviewState: "active",
          status: "queued",
          selectedScope: "site",
          proposedRule: "+.service.example",
        },
      }),
    ).toMatchObject({ ok: true, candidate: { selectedScope: "site" } });
    expect(
      domainCandidateReviewMutationResultSchema.parse({
        ok: false,
        reason: "scope-unavailable",
      }),
    ).toEqual({ ok: false, reason: "scope-unavailable" });

    expect(() =>
      domainCandidateScopeActionInputSchema.parse({
        fqdn: "api.service.example",
        selectedScope: "site",
        apply: true,
      }),
    ).toThrow();
    expect(() =>
      domainCandidateRejectionActionInputSchema.parse({
        fqdn: "api.service.example",
        rejected: "yes",
      }),
    ).toThrow();
    expect(() => domainCandidateRecheckActionInputSchema.parse({ fqdn: "api.local" })).toThrow();
    expect(() =>
      domainCandidateReviewActionResultSchema.parse({
        fqdn: "api.service.example",
        reviewState: "active",
        status: "queued",
        selectedScope: "site",
        proposedRule: "+.other.example",
      }),
    ).toThrow();
    expect(() =>
      domainCandidateReviewMutationResultSchema.parse({
        ok: false,
        reason: "scope-unavailable",
        internalPolicy: true,
      }),
    ).toThrow();
  });

  it("keeps every persisted safe probe category in the public enum", () => {
    expect(domainProbeCategorySchema.options).toEqual([
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
  });

  it("applies bounded list defaults and rejects unknown input", () => {
    expect(domainCandidateListInputSchema.parse({})).toEqual({
      view: "candidates",
      limit: 50,
    });
    expect(() => domainCandidateListInputSchema.parse({ limit: 101 })).toThrow();
    expect(() => domainCandidateListInputSchema.parse({ rawObservations: true })).toThrow();
  });

  it("accepts a safe report overview and rejects uncontracted fields", () => {
    const overview = {
      generatedAt: Date.parse("2026-08-03T12:00:00.000Z"),
      period: {
        from: Date.parse("2026-07-21T00:00:00.000Z"),
        to: Date.parse("2026-08-03T12:00:00.000Z"),
      },
      health,
      dailyAggregates: [{ day: "2026-08-03", connectionCount: 42, uniqueDomainCount: 7 }],
      candidateCounts: {
        queued: 1,
        pending: 2,
        confirmed: 3,
        blocked: 4,
        excluded: 5,
      },
      bucketCounts: { candidate: 6, exclusion: 9 },
      exclusionCounts: [
        { reason: "telemetry-pattern" as const, count: 5 },
        { reason: "user-rejected" as const, count: 4 },
      ],
      evidenceIntegrityCounts: { missingDecisions: 0, invalidDecisions: 0 },
    };

    expect(domainIntelligenceOverviewSchema.parse(overview)).toEqual(overview);
    expect(() =>
      domainIntelligenceOverviewSchema.parse({ ...overview, rawObservations: [] }),
    ).toThrow();
    expect(() =>
      domainIntelligenceOverviewSchema.parse({
        ...overview,
        bucketCounts: { candidate: 15, exclusion: 0 },
        exclusionCounts: [],
      }),
    ).toThrow();
    expect(() =>
      domainIntelligenceOverviewSchema.parse({
        ...overview,
        exclusionCounts: [
          { reason: "telemetry-pattern", count: 5 },
          { reason: "telemetry-pattern", count: 4 },
        ],
      }),
    ).toThrow();
  });

  it("exposes only bounded candidate evidence without internal identifiers or addresses", () => {
    const list = {
      items: [
        {
          fqdn: "api.service.example",
          siteGroup: "service.example",
          bucket: "candidate" as const,
          reviewState: "active" as const,
          status: "pending" as const,
          selectedScope: "site" as const,
          proposedRule: "+.service.example",
          eligibleScopes: ["exact", "site"] as const,
          scopeValid: true,
          siteUnavailableReason: null,
          exclusionReason: null,
          policyExclusionReason: null,
          firstSeenAt: Date.parse("2026-08-01T08:00:00.000Z"),
          lastSeenAt: Date.parse("2026-08-03T10:00:00.000Z"),
          lastValidationAt: Date.parse("2026-08-03T09:00:00.000Z"),
          nextValidationAt: Date.parse("2026-08-03T14:00:00.000Z"),
          connectionCount: 23,
          evidenceAvailable: true,
          evidenceIntegrityIssue: null,
          decision: {
            evaluatedAt: Date.parse("2026-08-03T09:00:00.000Z"),
            status: "pending" as const,
            confidence: "low" as const,
            reasons: ["insufficient-direct-failures" as const],
            windowStart: Date.parse("2026-08-02T09:00:00.000Z"),
            evidence: {
              directQualifyingFailures: 2,
              directSpacedFailures: 2,
              directAddressDiversityRequired: false,
              directAddressDiversitySatisfied: true,
              proxyHttpSuccesses: 2,
              proxyTransportFailures: 0,
              proxyUncertainFailures: 0,
            },
          },
          latestAttempts: {
            direct: {
              attemptedAt: Date.parse("2026-08-03T09:00:00.000Z"),
              category: "connect_timeout" as const,
              transportSuccess: false,
              httpStatus: null,
              connectDurationMs: 8_000,
              tlsDurationMs: null,
              totalDurationMs: 8_000,
              redirectCount: 0,
              finalOrigin: "https://api.service.example",
            },
            proxy: {
              attemptedAt: Date.parse("2026-08-03T09:00:01.000Z"),
              category: "http_response" as const,
              transportSuccess: true,
              httpStatus: 403,
              connectDurationMs: 20,
              tlsDurationMs: 30,
              totalDurationMs: 60,
              redirectCount: 0,
              finalOrigin: "https://api.service.example",
            },
          },
        },
      ],
      nextCursor: "api.service.example",
    };

    expect(domainCandidateListSchema.parse(list)).toEqual(list);
    expect(
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...list.items[0],
            bucket: "exclusion",
            reviewState: "rejected",
            exclusionReason: "user-rejected",
            nextValidationAt: null,
          },
        ],
      }),
    ).toMatchObject({
      items: [
        {
          status: "pending",
          bucket: "exclusion",
          reviewState: "rejected",
          exclusionReason: "user-rejected",
        },
      ],
    });
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [{ ...list.items[0], leaseId: "secret_lease", resolvedAddress: "1.1.1.1" }],
      }),
    ).toThrow();
    const safeItem = list.items[0];
    for (const legacyIp of ["127.1", "01.01.01.01", "0x7f.0.0.1"]) {
      expect(() =>
        domainCandidateListSchema.parse({
          ...list,
          items: [{ ...safeItem, fqdn: legacyIp, scopeValid: false }],
        }),
      ).toThrow();
      expect(() =>
        domainCandidateListSchema.parse({
          ...list,
          items: [{ ...safeItem, proposedRule: legacyIp, scopeValid: false }],
        }),
      ).toThrow();
      expect(() =>
        domainCandidateListSchema.parse({
          ...list,
          items: [
            {
              ...safeItem,
              latestAttempts: {
                ...safeItem.latestAttempts,
                direct: {
                  ...safeItem.latestAttempts.direct,
                  finalOrigin: `https://${legacyIp}`,
                },
              },
            },
          ],
        }),
      ).toThrow();
      expect(() => domainCandidateListInputSchema.parse({ cursor: legacyIp })).toThrow();
    }
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            fqdn: "1.1.1.1",
            siteGroup: "1.1.1.1",
            selectedScope: "exact",
            proposedRule: "1.1.1.1",
            eligibleScopes: ["exact"],
            latestAttempts: {
              ...safeItem.latestAttempts,
              direct: {
                ...safeItem.latestAttempts.direct,
                finalOrigin: "https://1.1.1.1",
              },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [{ ...safeItem, fqdn: "api.local" }],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "confirmed",
            decision: {
              ...safeItem.decision,
              status: "confirmed",
              confidence: "high",
              reasons: [],
              evidence: {
                directQualifyingFailures: 0,
                directSpacedFailures: 0,
                directAddressDiversityRequired: false,
                directAddressDiversitySatisfied: false,
                proxyHttpSuccesses: 0,
                proxyTransportFailures: 0,
                proxyUncertainFailures: 0,
              },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            latestAttempts: {
              ...safeItem.latestAttempts,
              direct: {
                ...safeItem.latestAttempts.direct,
                category: "http_response",
                transportSuccess: false,
                httpStatus: null,
              },
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            latestAttempts: {
              ...safeItem.latestAttempts,
              direct: {
                ...safeItem.latestAttempts.direct,
                category: "connect_timeout",
                transportSuccess: true,
                httpStatus: null,
              },
            },
          },
        ],
      }),
    ).toThrow();

    const confirmedDecision = {
      evaluatedAt: Date.parse("2026-08-03T09:00:00.000Z"),
      status: "confirmed" as const,
      confidence: "high" as const,
      reasons: [],
      windowStart: Date.parse("2026-08-02T09:00:00.000Z"),
      evidence: {
        directQualifyingFailures: 3,
        directSpacedFailures: 3,
        directAddressDiversityRequired: false,
        directAddressDiversitySatisfied: true,
        proxyHttpSuccesses: 2,
        proxyTransportFailures: 0,
        proxyUncertainFailures: 0,
      },
    };
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [{ ...safeItem, status: "pending", decision: confirmedDecision }],
      }),
    ).not.toThrow();

    const invalidEvidenceDecision = {
      evaluatedAt: Date.parse("2026-08-03T09:00:00.000Z"),
      status: "blocked" as const,
      confidence: "none" as const,
      reasons: ["invalid-evidence" as const],
      windowStart: Date.parse("2026-08-03T08:00:00.000Z"),
      evidence: {
        directQualifyingFailures: 0,
        directSpacedFailures: 0,
        directAddressDiversityRequired: false,
        directAddressDiversitySatisfied: false,
        proxyHttpSuccesses: 0,
        proxyTransportFailures: 0,
        proxyUncertainFailures: 0,
      },
    };
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "blocked",
            bucket: "exclusion",
            exclusionReason: "invalid-evidence",
            decision: invalidEvidenceDecision,
          },
        ],
      }),
    ).not.toThrow();
    const mixedBlockedDecision = {
      ...invalidEvidenceDecision,
      reasons: ["insufficient-observations" as const, "proxy-unstable" as const],
      windowStart: Date.parse("2026-08-02T09:00:00.000Z"),
      evidence: {
        directQualifyingFailures: 3,
        directSpacedFailures: 3,
        directAddressDiversityRequired: false,
        directAddressDiversitySatisfied: true,
        proxyHttpSuccesses: 1,
        proxyTransportFailures: 1,
        proxyUncertainFailures: 0,
      },
    };
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "blocked",
            bucket: "exclusion",
            exclusionReason: "proxy-unstable",
            decision: mixedBlockedDecision,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "blocked",
            bucket: "exclusion",
            exclusionReason: "insufficient-observations",
            decision: mixedBlockedDecision,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            decision: {
              ...safeItem.decision,
              windowStart: safeItem.decision.evaluatedAt + 1,
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            decision: {
              ...safeItem.decision,
              reasons: ["insufficient-direct-failures", "insufficient-direct-failures"],
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "confirmed",
            evidenceAvailable: true,
            decision: null,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "confirmed",
            evidenceAvailable: false,
            evidenceIntegrityIssue: "missing-decision",
            decision: null,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "blocked",
            bucket: "exclusion",
            exclusionReason: "invalid-evidence",
            evidenceAvailable: false,
            evidenceIntegrityIssue: "invalid-decision",
            decision: null,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [
          {
            ...safeItem,
            status: "blocked",
            bucket: "exclusion",
            exclusionReason: null,
            decision: invalidEvidenceDecision,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      domainCandidateListSchema.parse({
        ...list,
        items: [{ ...safeItem, exclusionReason: "never-add-domain" }],
      }),
    ).toThrow();
  });
});
