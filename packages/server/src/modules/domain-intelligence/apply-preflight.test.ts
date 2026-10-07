import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainIntelligenceReportSettings,
} from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import type { DomainRuleApplyOperationDependencies } from "./apply-operation.js";
import { createDomainRulePreparedPreflight } from "./apply-preflight.js";
import type { CoverageResult } from "./coverage.js";
import type { CandidateDecision, ValidationAttempt } from "./decision.js";

type Operation = Parameters<DomainRuleApplyOperationDependencies["preflightPrepared"]>[0];

const NOW = Date.parse("2026-08-04T10:00:00.000Z");
const SETTINGS: DomainIntelligenceReportSettings = {
  ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  enabled: true,
  defaultRuleScope: "site",
};
const UNCOVERED: CoverageResult = {
  status: "uncovered",
  match: null,
  incompleteSourceIds: [],
};
const CONFIRMED: CandidateDecision = {
  status: "confirmed",
  confidence: "high",
  reasons: [],
  windowStart: NOW - 24 * 60 * 60_000,
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

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "automatic-1",
    idempotencyKey: "automatic-1",
    action: "automatic-add",
    phase: "prepared",
    rollbackTargetRevision: null,
    candidateFqdn: "www.service.example",
    expectedSourceRevision: "a".repeat(40),
    intendedContentSha256: "b".repeat(64),
    proposedRule: "+.service.example",
    ownershipDelta: {
      upserts: [{ rule: "+.service.example", ownership: "automatic" }],
      deletes: [],
    },
    automaticConsentId: "consent-1",
    automaticConsentRevision: `domain-auto-v1:sha256:${"c".repeat(64)}`,
    automaticBudgetDay: "2026-08-04",
    automaticBudgetSlots: 1,
    resultingRevision: null,
    resultingContentSha256: null,
    activationStatus: "not-started",
    activationAttemptCount: 0,
    lastActivationAttemptAt: null,
    activationErrorCategory: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    completedAt: null,
    ...overrides,
  };
}

function setup() {
  const direct: ValidationAttempt[] = [];
  const proxy: ValidationAttempt[] = [];
  const dependencies = {
    now: () => NOW,
    observationHealthy: () => true,
    readSettings: vi.fn(() => SETTINGS),
    readCandidate: vi.fn(() => ({
      fqdn: "www.service.example",
      status: "confirmed" as const,
      reviewState: "active" as const,
      selectedScope: "site" as const,
      proposedRule: "+.service.example",
      leaseId: null,
      leaseUntil: null,
    })),
    readCoverage: vi.fn(() => UNCOVERED),
    readObservationCount: vi.fn(() => 12),
    readEvidence: vi.fn(() => ({ direct, proxy })),
    decide: vi.fn(() => CONFIRMED),
  };
  return {
    dependencies,
    preflight: createDomainRulePreparedPreflight(dependencies),
  };
}

describe("createDomainRulePreparedPreflight", () => {
  it("re-evaluates an automatic candidate from current settings and evidence", async () => {
    const { dependencies, preflight } = setup();

    await expect(preflight(operation())).resolves.toBeUndefined();

    const since = NOW - SETTINGS.validationWindowHours * 60 * 60_000;
    expect(dependencies.readObservationCount).toHaveBeenCalledWith({
      fqdn: "www.service.example",
      since,
      until: NOW,
    });
    expect(dependencies.readEvidence).toHaveBeenCalledWith({
      fqdn: "www.service.example",
      since,
      until: NOW,
    });
    expect(dependencies.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        fqdn: "www.service.example",
        connectionCount: 12,
        observationHealthy: true,
        selectedScope: "site",
        proposedRule: "+.service.example",
        coverage: UNCOVERED,
      }),
      expect.objectContaining({
        minimumConnectionCount: SETTINGS.minimumConnectionCount,
        directAttemptsRequired: SETTINGS.directAttemptsRequired,
      }),
      NOW,
    );
  });

  it.each([
    ["inactive review", { reviewState: "rejected" as const }, "candidate is not active"],
    ["stale status", { status: "pending" as const }, "candidate is not confirmed"],
    ["changed scope", { selectedScope: "exact" as const }, "candidate scope changed"],
    ["changed rule", { proposedRule: "www.service.example" }, "candidate scope changed"],
    ["active lease", { leaseId: "lease-1", leaseUntil: NOW + 1_000 }, "validation lease active"],
  ])("rejects %s before evidence evaluation", async (_label, candidateOverride, message) => {
    const { dependencies, preflight } = setup();
    dependencies.readCandidate.mockReturnValue({
      fqdn: "www.service.example",
      status: "confirmed",
      reviewState: "active",
      selectedScope: "site",
      proposedRule: "+.service.example",
      leaseId: null,
      leaseUntil: null,
      ...candidateOverride,
    });

    await expect(preflight(operation())).rejects.toThrow(message);
    expect(dependencies.decide).not.toHaveBeenCalled();
  });

  it("fails closed when observation or coverage evidence is not currently trustworthy", async () => {
    const unhealthy = setup();
    unhealthy.dependencies.observationHealthy = () => false;
    await expect(unhealthy.preflight(operation())).rejects.toThrow("observation is unhealthy");

    const incomplete = setup();
    incomplete.dependencies.readCoverage.mockReturnValue({
      status: "incomplete",
      match: null,
      incompleteSourceIds: ["provider-1"],
    });
    await expect(incomplete.preflight(operation())).rejects.toThrow("coverage is incomplete");

    const covered = setup();
    covered.dependencies.readCoverage.mockReturnValue({
      status: "covered",
      match: {
        sourceId: "custom",
        sourceKind: "provider",
        rule: "+.service.example",
        ruleKind: "suffix",
      },
      incompleteSourceIds: [],
    });
    await expect(covered.preflight(operation())).rejects.toThrow("candidate is already covered");
  });

  it("rejects evidence that no longer produces a confirmed decision", async () => {
    const { dependencies, preflight } = setup();
    dependencies.decide.mockReturnValue({
      ...CONFIRMED,
      status: "pending",
      confidence: "low",
      reasons: ["insufficient-direct-failures"],
    });

    await expect(preflight(operation())).rejects.toThrow(
      "candidate evidence is no longer confirmed",
    );
  });

  it("re-evaluates explicit review-mode candidate confirmation without automatic budget", async () => {
    const { dependencies, preflight } = setup();
    dependencies.readSettings.mockReturnValue({ ...SETTINGS, automationMode: "review" });

    await expect(
      preflight(
        operation({
          action: "manual-add",
          automaticConsentId: null,
          automaticConsentRevision: null,
          automaticBudgetDay: null,
          automaticBudgetSlots: 0,
          ownershipDelta: {
            upserts: [{ rule: "+.service.example", ownership: "manual" }],
            deletes: [],
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(dependencies.readCandidate).toHaveBeenCalledWith("www.service.example");
    expect(dependencies.decide).toHaveBeenCalledTimes(1);
  });

  it("allows only distinct candidate-free manual operations to bypass evidence", async () => {
    const { dependencies, preflight } = setup();

    await expect(
      preflight(
        operation({
          action: "manual-add",
          candidateFqdn: null,
          automaticConsentId: null,
          automaticConsentRevision: null,
          automaticBudgetDay: null,
          automaticBudgetSlots: 0,
          ownershipDelta: {
            upserts: [{ rule: "+.manual.example", ownership: "manual" }],
            deletes: [],
          },
          proposedRule: "+.manual.example",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(dependencies.readCandidate).not.toHaveBeenCalled();

    dependencies.readSettings.mockReturnValue({ ...SETTINGS, automationMode: "automatic" });
    await expect(
      preflight(
        operation({
          action: "manual-add",
          automaticConsentId: null,
          automaticConsentRevision: null,
          automaticBudgetDay: null,
          automaticBudgetSlots: 0,
          ownershipDelta: {
            upserts: [{ rule: "+.service.example", ownership: "manual" }],
            deletes: [],
          },
        }),
      ),
    ).rejects.toThrow("review authorization unavailable");
  });

  it("rechecks feature state, observer health, and coverage for manual additions", async () => {
    const manualAdd = operation({
      action: "manual-add",
      candidateFqdn: null,
      automaticConsentId: null,
      automaticConsentRevision: null,
      automaticBudgetDay: null,
      automaticBudgetSlots: 0,
      ownershipDelta: {
        upserts: [{ rule: "+.manual.example", ownership: "manual" }],
        deletes: [],
      },
      proposedRule: "+.manual.example",
    });

    const disabled = setup();
    disabled.dependencies.readSettings.mockReturnValue({ ...SETTINGS, enabled: false });
    await expect(disabled.preflight(manualAdd)).rejects.toThrow("settings unavailable");

    const unhealthy = setup();
    unhealthy.dependencies.observationHealthy = () => false;
    await expect(unhealthy.preflight(manualAdd)).rejects.toThrow("observation is unhealthy");

    const coveredPreview = setup();
    coveredPreview.dependencies.readCoverage.mockReturnValue({
      status: "covered",
      match: {
        sourceId: "submerge-custom",
        sourceKind: "custom",
        rule: "+.manual.example",
        ruleKind: "suffix",
      },
      incompleteSourceIds: [],
    });
    await expect(coveredPreview.preflight(manualAdd)).resolves.toBeUndefined();
    expect(coveredPreview.dependencies.readCoverage).toHaveBeenCalledWith("manual.example");

    const incomplete = setup();
    incomplete.dependencies.readCoverage.mockReturnValue({
      status: "incomplete",
      match: null,
      incompleteSourceIds: ["provider-1"],
    });
    await expect(incomplete.preflight(manualAdd)).rejects.toThrow("coverage is incomplete");
  });

  it.each(["+.com", "+.co.uk", "+.vercel.app"])(
    "rejects manual widening at a public or shared suffix boundary: %s",
    async (proposedRule) => {
      const { preflight } = setup();

      await expect(
        preflight(
          operation({
            action: "manual-add",
            candidateFqdn: null,
            automaticConsentId: null,
            automaticConsentRevision: null,
            automaticBudgetDay: null,
            automaticBudgetSlots: 0,
            ownershipDelta: {
              upserts: [{ rule: proposedRule, ownership: "manual" }],
              deletes: [],
            },
            proposedRule,
          }),
        ),
      ).rejects.toThrow("manual scope is invalid");
    },
  );

  it("honors cancellation before reading mutable state", async () => {
    const { dependencies, preflight } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(preflight(operation(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(dependencies.readSettings).not.toHaveBeenCalled();
  });
});
