import { initTRPC } from "@trpc/server";

// Per-request context passed to all procedures
export interface Context {
  authed: boolean;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
