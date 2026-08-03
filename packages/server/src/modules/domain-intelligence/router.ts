import {
  type DomainCandidateList,
  type DomainCandidateListInput,
  type DomainIntelligenceOverview,
  domainCandidateListInputSchema,
  domainCandidateListSchema,
  domainIntelligenceOverviewSchema,
} from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { domainIntelligenceScheduler } from "../logs/singleton.js";
import {
  getDomainIntelligenceOverview,
  listDomainCandidateReport,
  readDomainIntelligenceFilterPolicy,
} from "./service.js";

export interface DomainIntelligenceReadService {
  overview: () => DomainIntelligenceOverview | Promise<DomainIntelligenceOverview>;
  list: (input: DomainCandidateListInput) => DomainCandidateList | Promise<DomainCandidateList>;
}

export function makeDomainIntelligenceRouter(service: DomainIntelligenceReadService) {
  return router({
    overview: protectedProcedure
      .output(domainIntelligenceOverviewSchema)
      .query(() => service.overview()),
    list: protectedProcedure
      .input(domainCandidateListInputSchema)
      .output(domainCandidateListSchema)
      .query(({ input }) => service.list(input)),
  });
}

const domainIntelligenceReadService: DomainIntelligenceReadService = {
  overview: () =>
    getDomainIntelligenceOverview(db, {
      now: Date.now(),
      health: domainIntelligenceScheduler.health(),
    }),
  list: (input) => listDomainCandidateReport(db, input, readDomainIntelligenceFilterPolicy(db)),
};

export const domainIntelligenceRouter = makeDomainIntelligenceRouter(domainIntelligenceReadService);
