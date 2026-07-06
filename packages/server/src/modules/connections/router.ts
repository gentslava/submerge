import { closeConnectionInput } from "@submerge/shared";
import { closeAllConnections, closeConnection } from "../../clients/mihomo.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { listConnections } from "./service.js";

export const connectionsRouter = router({
  list: protectedProcedure.query(() => listConnections()),
  close: protectedProcedure.input(closeConnectionInput).mutation(async ({ input }) => {
    await closeConnection(input.id);
    return { ok: true as const };
  }),
  closeAll: protectedProcedure.mutation(async () => {
    await closeAllConnections();
    return { ok: true as const };
  }),
});
