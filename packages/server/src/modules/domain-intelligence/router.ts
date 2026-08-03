import {
  type DomainCandidateList,
  type DomainCandidateListInput,
  type DomainCandidateRecheckActionInput,
  type DomainCandidateRejectionActionInput,
  type DomainCandidateReviewActionResult,
  type DomainCandidateReviewMutationResult,
  type DomainCandidateScopeActionInput,
  type DomainIntelligenceOverview,
  domainCandidateListInputSchema,
  domainCandidateListSchema,
  domainCandidateRecheckActionInputSchema,
  domainCandidateRejectionActionInputSchema,
  domainCandidateReviewMutationResultSchema,
  domainCandidateScopeActionInputSchema,
  domainIntelligenceOverviewSchema,
} from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { domainIntelligenceScheduler } from "../logs/singleton.js";
import {
  DomainCandidateReviewError,
  getDomainIntelligenceOverview,
  listDomainCandidateReport,
  readDomainIntelligenceFilterPolicy,
  recheckDomainCandidate,
  selectDomainCandidateScope,
  setDomainCandidateRejection,
} from "./service.js";

export interface DomainIntelligenceService {
  overview: () => DomainIntelligenceOverview | Promise<DomainIntelligenceOverview>;
  list: (input: DomainCandidateListInput) => DomainCandidateList | Promise<DomainCandidateList>;
  setScope: (
    input: DomainCandidateScopeActionInput,
  ) => DomainCandidateReviewActionResult | Promise<DomainCandidateReviewActionResult>;
  setRejected: (
    input: DomainCandidateRejectionActionInput,
  ) => DomainCandidateReviewActionResult | Promise<DomainCandidateReviewActionResult>;
  recheck: (
    input: DomainCandidateRecheckActionInput,
  ) => DomainCandidateReviewActionResult | Promise<DomainCandidateReviewActionResult>;
}

async function executeReviewAction(
  action: () => DomainCandidateReviewActionResult | Promise<DomainCandidateReviewActionResult>,
): Promise<DomainCandidateReviewMutationResult> {
  try {
    return { ok: true, candidate: await action() };
  } catch (error) {
    if (!(error instanceof DomainCandidateReviewError)) throw error;
    return { ok: false, reason: error.code };
  }
}

export function makeDomainIntelligenceRouter(service: DomainIntelligenceService) {
  return router({
    overview: protectedProcedure
      .output(domainIntelligenceOverviewSchema)
      .query(() => service.overview()),
    list: protectedProcedure
      .input(domainCandidateListInputSchema)
      .output(domainCandidateListSchema)
      .query(({ input }) => service.list(input)),
    setScope: protectedProcedure
      .input(domainCandidateScopeActionInputSchema)
      .output(domainCandidateReviewMutationResultSchema)
      .mutation(({ input }) => executeReviewAction(() => service.setScope(input))),
    setRejected: protectedProcedure
      .input(domainCandidateRejectionActionInputSchema)
      .output(domainCandidateReviewMutationResultSchema)
      .mutation(({ input }) => executeReviewAction(() => service.setRejected(input))),
    recheck: protectedProcedure
      .input(domainCandidateRecheckActionInputSchema)
      .output(domainCandidateReviewMutationResultSchema)
      .mutation(({ input }) => executeReviewAction(() => service.recheck(input))),
  });
}

const domainIntelligenceService: DomainIntelligenceService = {
  overview: () =>
    getDomainIntelligenceOverview(db, {
      now: Date.now(),
      health: domainIntelligenceScheduler.health(),
    }),
  list: (input) => listDomainCandidateReport(db, input, readDomainIntelligenceFilterPolicy(db)),
  setScope: (input) => {
    const filterPolicy = readDomainIntelligenceFilterPolicy(db);
    if (!filterPolicy) throw new DomainCandidateReviewError("policy-unavailable");
    return selectDomainCandidateScope(db, { ...input, filterPolicy, now: Date.now() });
  },
  setRejected: (input) => {
    return setDomainCandidateRejection(db, {
      ...input,
      filterPolicy: readDomainIntelligenceFilterPolicy(db),
      now: Date.now(),
    });
  },
  recheck: (input) => {
    const filterPolicy = readDomainIntelligenceFilterPolicy(db);
    if (!filterPolicy) throw new DomainCandidateReviewError("policy-unavailable");
    return recheckDomainCandidate(db, { ...input, filterPolicy, now: Date.now() });
  },
};

export const domainIntelligenceRouter = makeDomainIntelligenceRouter(domainIntelligenceService);
