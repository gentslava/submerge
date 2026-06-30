import { delayInput, selectNodeInput } from "@submerge/shared";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { listNodes, selectNode, testDelay } from "./service.js";

export const nodesRouter = router({
  list: protectedProcedure.query(() => listNodes()),
  delay: protectedProcedure.input(delayInput).mutation(({ input }) => testDelay(input.name)),
  select: protectedProcedure
    .input(selectNodeInput)
    .mutation(({ input }) => selectNode(input.group, input.name)),
});
