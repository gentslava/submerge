import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainCandidateList,
  type DomainCandidateListInput,
  type DomainCandidateReviewActionResult,
  type DomainIntelligenceOverview,
  type DomainIntelligenceReportSettings,
  type DomainIntelligenceSettingsView,
} from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { type DomainIntelligenceService, makeDomainIntelligenceRouter } from "./router.js";
import { DomainCandidateReviewError } from "./service.js";

const now = Date.parse("2026-08-03T12:00:00.000Z");

function overview(): DomainIntelligenceOverview {
  return {
    generatedAt: now,
    period: { from: Date.parse("2026-07-21T00:00:00.000Z"), to: now },
    health: {
      status: "healthy",
      reason: "correlated",
      snapshotDomainConnections: 12,
      correlatedConnections: 10,
      updatedAt: now,
    },
    dailyAggregates: [],
    candidateCounts: {
      queued: 1,
      pending: 2,
      confirmed: 3,
      blocked: 4,
      excluded: 5,
    },
    bucketCounts: { candidate: 6, exclusion: 9 },
    exclusionCounts: [
      { reason: "proxy-unstable", count: 4 },
      { reason: "telemetry-pattern", count: 5 },
    ],
    evidenceIntegrityCounts: { missingDecisions: 0, invalidDecisions: 0 },
  };
}

function candidateList(): DomainCandidateList {
  return { items: [], nextCursor: null };
}

function actionResult(): DomainCandidateReviewActionResult {
  return {
    fqdn: "api.service.example",
    reviewState: "active",
    status: "queued",
    selectedScope: "site",
    proposedRule: "+.service.example",
  };
}

function applyResult() {
  return {
    operationId: "manual-add-review-1",
    phase: "completed" as const,
    contentSha256: "a".repeat(64),
    activationAttempt: 1,
  };
}

function settingsView(): DomainIntelligenceSettingsView {
  return {
    configurationState: "unconfigured",
    settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    deployment: {
      mode: "report",
      apply: { available: false, reason: "deployment-report-only" },
    },
  };
}

function caller(service: DomainIntelligenceService, authed = true) {
  const appRouter = router({ domainIntelligence: makeDomainIntelligenceRouter(service) });
  return createCallerFactory(appRouter)({
    authed,
    authRequired: true,
    req: {} as never,
    res: {} as never,
  });
}

describe("domain intelligence router", () => {
  it("exposes protected overview and bounded candidate list queries", async () => {
    const service = {
      settings: vi.fn(() => settingsView()),
      setSettings: vi.fn(() => ({ view: settingsView(), applied: true })),
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
      setScope: vi.fn(() => actionResult()),
      setRejected: vi.fn(() => actionResult()),
      recheck: vi.fn(() => actionResult()),
      applyCandidate: vi.fn(() => applyResult()),
    };

    await expect(caller(service).domainIntelligence.overview()).resolves.toEqual(overview());
    await expect(caller(service).domainIntelligence.list({})).resolves.toEqual(candidateList());
    expect(service.list).toHaveBeenCalledWith({ view: "candidates", limit: 50 });
  });

  it("exposes strict report-only settings without apply capabilities", async () => {
    const configured: DomainIntelligenceReportSettings = {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled: true,
      defaultRuleScope: "site",
      automationMode: "review",
    };
    const ready: DomainIntelligenceSettingsView = {
      configurationState: "ready",
      settings: configured,
      deployment: {
        mode: "report",
        apply: { available: false, reason: "deployment-report-only" },
      },
    };
    const service = {
      settings: vi.fn(() => ready),
      setSettings: vi.fn(() => ({ view: ready, applied: true })),
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
      setScope: vi.fn(() => actionResult()),
      setRejected: vi.fn(() => actionResult()),
      recheck: vi.fn(() => actionResult()),
      applyCandidate: vi.fn(() => applyResult()),
    };
    const api = caller(service).domainIntelligence;

    await expect(api.settings()).resolves.toEqual(ready);
    await expect(api.setSettings(configured)).resolves.toEqual({ view: ready, applied: true });
    expect(service.setSettings).toHaveBeenCalledWith(configured);
    await expect(
      api.setSettings({ ...configured, mode: "apply", applyEnabled: true } as never),
    ).rejects.toThrow();
    expect(service.setSettings).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated report access before calling the service", async () => {
    const service = {
      settings: vi.fn(() => settingsView()),
      setSettings: vi.fn(() => ({ view: settingsView(), applied: true })),
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
      setScope: vi.fn(() => actionResult()),
      setRejected: vi.fn(() => actionResult()),
      recheck: vi.fn(() => actionResult()),
      applyCandidate: vi.fn(() => applyResult()),
    };
    const unauthenticated = caller(service, false).domainIntelligence;

    await expect(unauthenticated.settings()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      unauthenticated.setSettings(DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthenticated.overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthenticated.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      unauthenticated.setScope({ fqdn: "api.service.example", selectedScope: "site" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      unauthenticated.setRejected({ fqdn: "api.service.example", rejected: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthenticated.recheck({ fqdn: "api.service.example" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      unauthenticated.applyCandidate({
        fqdn: "api.service.example",
        operationId: "manual-add-review-1",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(service.settings).not.toHaveBeenCalled();
    expect(service.setSettings).not.toHaveBeenCalled();
    expect(service.overview).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.setScope).not.toHaveBeenCalled();
    expect(service.setRejected).not.toHaveBeenCalled();
    expect(service.recheck).not.toHaveBeenCalled();
    expect(service.applyCandidate).not.toHaveBeenCalled();
  });

  it("rejects service output outside the shared privacy contract", async () => {
    const unsafe = {
      settings: vi.fn(() => ({ ...settingsView(), repositoryToken: "secret" })),
      setSettings: vi.fn(() => ({ view: settingsView(), applied: true })),
      overview: vi.fn(() => ({ ...overview(), rawObservations: [] })),
      list: vi.fn((_input: DomainCandidateListInput) => ({
        ...candidateList(),
        internalCursor: "lease_1",
      })),
      setScope: vi.fn(() => actionResult()),
      setRejected: vi.fn(() => actionResult()),
      recheck: vi.fn(() => actionResult()),
      applyCandidate: vi.fn(() => applyResult()),
    };
    const api = caller(unsafe as never).domainIntelligence;

    await expect(api.settings()).rejects.toThrow();
    await expect(api.overview()).rejects.toThrow();
    await expect(api.list({})).rejects.toThrow();
  });

  it("exposes only protected scope, rejection, and recheck review mutations", async () => {
    const service = {
      settings: vi.fn(() => settingsView()),
      setSettings: vi.fn(() => ({ view: settingsView(), applied: true })),
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
      setScope: vi.fn(() => actionResult()),
      setRejected: vi.fn(() => ({ ...actionResult(), reviewState: "rejected" as const })),
      recheck: vi.fn(() => actionResult()),
      applyCandidate: vi.fn(() => applyResult()),
    };
    const api = caller(service as never).domainIntelligence as unknown as {
      setScope: (input: { fqdn: string; selectedScope: "exact" | "site" }) => Promise<unknown>;
      setRejected: (input: { fqdn: string; rejected: boolean }) => Promise<unknown>;
      recheck: (input: { fqdn: string }) => Promise<unknown>;
      applyCandidate: (input: { fqdn: string; operationId: string }) => Promise<unknown>;
    };

    expect(api.setScope).toBeTypeOf("function");
    await expect(
      api.setScope({ fqdn: "api.service.example", selectedScope: "site" }),
    ).resolves.toEqual({ ok: true, candidate: actionResult() });
    await expect(
      api.setRejected({ fqdn: "api.service.example", rejected: true }),
    ).resolves.toMatchObject({ ok: true, candidate: { reviewState: "rejected" } });
    await expect(api.recheck({ fqdn: "api.service.example" })).resolves.toEqual({
      ok: true,
      candidate: actionResult(),
    });
    await expect(
      api.applyCandidate({ fqdn: "api.service.example", operationId: "manual-add-review-1" }),
    ).resolves.toEqual(applyResult());
    expect(service.setScope).toHaveBeenCalledWith({
      fqdn: "api.service.example",
      selectedScope: "site",
    });
    expect(service.setRejected).toHaveBeenCalledWith({
      fqdn: "api.service.example",
      rejected: true,
    });
    expect(service.recheck).toHaveBeenCalledWith({ fqdn: "api.service.example" });
    expect(service.applyCandidate).toHaveBeenCalledWith({
      fqdn: "api.service.example",
      operationId: "manual-add-review-1",
    });
  });

  it("rejects apply-shaped review input and output outside the safe action contract", async () => {
    const service = {
      settings: vi.fn(() => settingsView()),
      setSettings: vi.fn(() => ({ view: settingsView(), applied: true })),
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
      setScope: vi.fn(() => ({ ...actionResult(), resultingRevision: "secret" })),
      setRejected: vi.fn(() => actionResult()),
      recheck: vi.fn(() => actionResult()),
      applyCandidate: vi.fn(() => applyResult()),
    };
    const api = caller(service as never).domainIntelligence;

    await expect(
      api.setScope({
        fqdn: "api.service.example",
        selectedScope: "site",
        apply: true,
      } as never),
    ).rejects.toThrow();
    expect(service.setScope).not.toHaveBeenCalled();
    await expect(
      api.setRejected({
        fqdn: "api.service.example",
        rejected: true,
        publish: true,
      } as never),
    ).rejects.toThrow();
    expect(service.setRejected).not.toHaveBeenCalled();
    await expect(
      api.setScope({ fqdn: "api.service.example", selectedScope: "site" }),
    ).rejects.toThrow();
  });

  it("returns stable safe review reason codes without exposing internal error details", async () => {
    const service = {
      settings: vi.fn(() => settingsView()),
      setSettings: vi.fn(() => ({ view: settingsView(), applied: true })),
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
      setScope: vi.fn(() => {
        throw new DomainCandidateReviewError("validation-in-progress");
      }),
      setRejected: vi.fn(() => {
        throw new DomainCandidateReviewError("candidate-not-found");
      }),
      recheck: vi.fn(() => {
        throw new DomainCandidateReviewError("policy-unavailable");
      }),
      applyCandidate: vi.fn(() => applyResult()),
    };
    const api = caller(service).domainIntelligence;

    await expect(
      api.setScope({ fqdn: "api.service.example", selectedScope: "exact" }),
    ).resolves.toEqual({ ok: false, reason: "validation-in-progress" });
    await expect(api.setRejected({ fqdn: "api.service.example", rejected: true })).resolves.toEqual(
      { ok: false, reason: "candidate-not-found" },
    );
    await expect(api.recheck({ fqdn: "api.service.example" })).resolves.toEqual({
      ok: false,
      reason: "policy-unavailable",
    });
  });
});
