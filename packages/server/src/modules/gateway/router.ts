import { networkProfileSchema } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { configureGateway, gatewayReadiness, getGatewayConfiguration } from "./service.js";
import { readNetworkProfile } from "./settings.js";

export const gatewayRouter = router({
  get: protectedProcedure.query(() => readNetworkProfile(db)),
  configuration: protectedProcedure.query(() => getGatewayConfiguration(db)),
  set: protectedProcedure
    .input(networkProfileSchema)
    .mutation(({ input }) => configureGateway(db, input)),
  readiness: protectedProcedure.query(() => gatewayReadiness(db)),
});
