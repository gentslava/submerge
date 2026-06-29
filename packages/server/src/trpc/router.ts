import { nodesRouter } from "../modules/nodes/router.js";
import { settingsRouter } from "../modules/settings/router.js";
import { sourcesRouter } from "../modules/sources/router.js";
import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  health: router({
    // Returns ok + current server version — used as a liveness check
    ping: publicProcedure.query(() => ({ ok: true, version: "0.2.0" })),
  }),
  sources: sourcesRouter,
  nodes: nodesRouter,
  settings: settingsRouter,
});

// Re-exported for the web package (Phase 3)
export type AppRouter = typeof appRouter;
