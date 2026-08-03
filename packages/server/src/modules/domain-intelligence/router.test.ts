import type {
  DomainCandidateList,
  DomainCandidateListInput,
  DomainIntelligenceOverview,
} from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { makeDomainIntelligenceRouter } from "./router.js";

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
    exclusionCounts: [],
    evidenceIntegrityCounts: { missingDecisions: 0, invalidDecisions: 0 },
  };
}

function candidateList(): DomainCandidateList {
  return { items: [], nextCursor: null };
}

function caller(
  service: {
    overview: () => DomainIntelligenceOverview;
    list: (input: DomainCandidateListInput) => DomainCandidateList;
  },
  authed = true,
) {
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
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
    };

    await expect(caller(service).domainIntelligence.overview()).resolves.toEqual(overview());
    await expect(caller(service).domainIntelligence.list({})).resolves.toEqual(candidateList());
    expect(service.list).toHaveBeenCalledWith({ view: "candidates", limit: 50 });
  });

  it("rejects unauthenticated report access before calling the service", async () => {
    const service = {
      overview: vi.fn(() => overview()),
      list: vi.fn((_input: DomainCandidateListInput) => candidateList()),
    };
    const unauthenticated = caller(service, false).domainIntelligence;

    await expect(unauthenticated.overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(unauthenticated.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(service.overview).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects service output outside the shared privacy contract", async () => {
    const unsafe = {
      overview: vi.fn(() => ({ ...overview(), rawObservations: [] })),
      list: vi.fn((_input: DomainCandidateListInput) => ({
        ...candidateList(),
        internalCursor: "lease_1",
      })),
    };
    const api = caller(unsafe as never).domainIntelligence;

    await expect(api.overview()).rejects.toThrow();
    await expect(api.list({})).rejects.toThrow();
  });
});
