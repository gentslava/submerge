import { delayInput, selectNodeInput, setExcludedInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { prober } from "../../live/singleton.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { policyProbe, readDefaultPolicy } from "../channels/service.js";
import { listNodeBandwidth } from "./bandwidth.js";
import {
  applyConfig,
  checkHealth,
  listNodes,
  selectNode,
  setExcluded,
  testDelay,
} from "./service.js";
import { speedTestNode } from "./speedtest.js";

export const nodesRouter = router({
  // Overlay the panel's last-known delays here too — the initial query must match
  // the SSE stream, else a fresh load right after a reload shows «— ms» until the
  // first live tick replaces it.
  list: protectedProcedure.query(async () => prober.fillLastKnown(await listNodes(db))),
  // Is the panel reaching mihomo right now? Polled by Settings + the "Проверить" button.
  health: protectedProcedure.query(async () => ({ connected: await checkHealth() })),
  delay: protectedProcedure
    .input(delayInput)
    .mutation(({ input }) => testDelay(input.name, policyProbe(readDefaultPolicy(db)).url)),
  select: protectedProcedure
    .input(selectNodeInput)
    .mutation(({ input }) => selectNode(db, input.group, input.name)),
  // Global deny-list toggle: exclude/include a node, then regenerate + reload the
  // config (an excluded node is dropped from the engine; including re-adds it).
  setExcluded: protectedProcedure.input(setExcludedInput).mutation(async ({ input }) => {
    setExcluded(db, input.name, input.excluded);
    const { applied } = await applyConfig(db);
    return { ok: true as const, applied };
  }),
  // Cached on-demand throughput per node (name → { mbps, testedAt }).
  bandwidth: protectedProcedure.query(() => listNodeBandwidth(db)),
  // On-demand throughput test for one node — real quota burn, gated behind a UI
  // warning. Serialized server-side; caches + returns the result.
  speedTest: protectedProcedure
    .input(delayInput)
    .mutation(({ input }) => speedTestNode(db, input.name)),
});
