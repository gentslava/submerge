import type { IncomingMessage, ServerResponse } from "node:http";
import { initTRPC, TRPCError } from "@trpc/server";

// Per-request context passed to all procedures
export interface Context {
  authed: boolean;
  authRequired: boolean;
  req: IncomingMessage;
  res: ServerResponse;
}

const t = initTRPC.context<Context>().create({
  sse: {
    ping: { enabled: true, intervalMs: 2000 },
    client: { reconnectAfterInactivityMs: 5000 },
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

// Reject when auth is enabled and the request is not authenticated.
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.authRequired && !ctx.authed) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next();
});
