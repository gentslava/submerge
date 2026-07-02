import { setChannelPolicyInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { applyConfig } from "../nodes/service.js";
import { channelController } from "./instance.js";
import { readDefaultChannel, setChannelPolicy } from "./service.js";

export const channelsRouter = router({
  // Phase 1 exposes only the Default channel; multi-channel CRUD lands in Phase 3.
  get: protectedProcedure.query(() => readDefaultChannel(db)),
  setPolicy: protectedProcedure.input(setChannelPolicyInput).mutation(async ({ input }) => {
    setChannelPolicy(db, input.id, input.policy);
    // Drop transient control state (failures/heldSince/lastCheck/lastSpeedNow) from the
    // previous policy session so it can't leak into the new one — e.g. a stale
    // heldSince misfiring maxHoldHours. The decision log is preserved.
    channelController.reset();
    // The policy shapes the mihomo config (group type + tuning) — regenerate + reload.
    const { applied } = await applyConfig(db);
    return { ok: true as const, applied };
  }),
  recentDecisions: protectedProcedure.query(() => channelController.recent()),
});
