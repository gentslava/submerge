import type { inferRouterOutputs } from "@trpc/server";
import { authRouter } from "../auth/router.js";
import { makeLiveRouter } from "../live/router.js";
import { liveHub } from "../live/singleton.js";
import { channelsRouter } from "../modules/channels/router.js";
import { connectionsRouter } from "../modules/connections/router.js";
import { diagnosticsRouter } from "../modules/diagnostics/router.js";
import { makeLogsRouter } from "../modules/logs/router.js";
import { logHub } from "../modules/logs/singleton.js";
import { nodesRouter } from "../modules/nodes/router.js";
import { settingsRouter } from "../modules/settings/router.js";
import { sourcesRouter } from "../modules/sources/router.js";
import { SUBMERGE_VERSION } from "../version.js";
import { publicProcedure, router } from "./trpc.js";

export const appRouter = router({
  health: router({
    // Returns ok + current server version — used as a liveness check
    ping: publicProcedure.query(() => ({ ok: true, version: SUBMERGE_VERSION })),
  }),
  auth: authRouter,
  sources: sourcesRouter,
  nodes: nodesRouter,
  channels: channelsRouter,
  connections: connectionsRouter,
  diagnostics: diagnosticsRouter,
  logs: makeLogsRouter(logHub),
  settings: settingsRouter,
  live: makeLiveRouter(liveHub),
});

// Re-exported for the web package (Phase 3)
export type AppRouter = typeof appRouter;

// The client-facing (serialized) output types of every procedure — the single
// source of truth for query-data shapes on the web. Derived from the router, so
// it tracks the shared Zod contract through tRPC's JSON serialization (e.g. an
// optional `uuid?: string | undefined` becomes `uuid?: string` over the wire).
export type RouterOutputs = inferRouterOutputs<AppRouter>;
