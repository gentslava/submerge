import { delayInput, selectNodeInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { policyProbe, readDefaultPolicy } from "../channels/service.js";
import { checkHealth, listNodes, selectNode, testDelay } from "./service.js";

export const nodesRouter = router({
  list: protectedProcedure.query(() => listNodes(db)),
  // Is the panel reaching mihomo right now? Polled by Settings + the "Проверить" button.
  health: protectedProcedure.query(async () => ({ connected: await checkHealth() })),
  delay: protectedProcedure
    .input(delayInput)
    .mutation(({ input }) => testDelay(input.name, policyProbe(readDefaultPolicy(db)).url)),
  select: protectedProcedure
    .input(selectNodeInput)
    .mutation(({ input }) => selectNode(input.group, input.name)),
});
