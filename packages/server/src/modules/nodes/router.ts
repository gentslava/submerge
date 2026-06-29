import { delayInput, selectNodeInput } from "@submerge/shared";
import { publicProcedure, router } from "../../trpc/trpc.js";
import { listNodes, selectNode, testDelay } from "./service.js";

export const nodesRouter = router({
  list: publicProcedure.query(() => listNodes()),
  delay: publicProcedure.input(delayInput).mutation(({ input }) => testDelay(input.name)),
  select: publicProcedure
    .input(selectNodeInput)
    .mutation(({ input }) => selectNode(input.group, input.name)),
});
