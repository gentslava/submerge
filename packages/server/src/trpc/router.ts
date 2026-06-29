import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  health: router({
    // Returns ok + current server version — used as a liveness check
    ping: publicProcedure.query(() => ({ ok: true, version: "0.2.0" })),
  }),
});

// Re-exported for the web package (Phase 3)
export type AppRouter = typeof appRouter;
