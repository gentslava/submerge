import {
  createChannelInput,
  deleteChannelInput,
  reorderChannelsInput,
  setChannelPolicyInput,
  setChannelPoolInput,
  updateChannelInput,
} from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { applyConfig } from "../nodes/service.js";
import { registry } from "./instance.js";
import { getPool, setPool } from "./pool.js";
import {
  createChannel,
  deleteChannel,
  listChannels,
  readDefaultChannel,
  reorderChannels,
  setChannelPolicy,
  updateChannel,
} from "./service.js";

export const channelsRouter = router({
  // Phase 1 exposes only the Default channel; multi-channel CRUD lands in Phase 3.
  get: protectedProcedure.query(() => readDefaultChannel(db)),
  list: protectedProcedure.query(() => listChannels(db)),
  create: protectedProcedure.input(createChannelInput).mutation(async ({ input }) => {
    const ch = createChannel(db, input);
    // A new channel adds a routing group — regenerate + reload the mihomo config.
    await applyConfig(db);
    return ch;
  }),
  update: protectedProcedure.input(updateChannelInput).mutation(async ({ input }) => {
    updateChannel(db, input.id, input);
    // name/enabled/matcher all shape the generated config (group membership, rules).
    await applyConfig(db);
    return { ok: true as const };
  }),
  remove: protectedProcedure.input(deleteChannelInput).mutation(async ({ input }) => {
    // Throws for the Default channel — surfaces as a tRPC error, which is correct:
    // the UI must never offer to delete the permanent catch-all.
    deleteChannel(db, input.id);
    await applyConfig(db);
    return { ok: true as const };
  }),
  reorder: protectedProcedure.input(reorderChannelsInput).mutation(async ({ input }) => {
    reorderChannels(db, input.ids);
    // Match order changed — regenerate the rule set in the new priority order.
    await applyConfig(db);
    return { ok: true as const };
  }),
  getPool: protectedProcedure.input(deleteChannelInput).query(({ input }) => getPool(db, input.id)),
  setPool: protectedProcedure.input(setChannelPoolInput).mutation(async ({ input }) => {
    setPool(db, input.id, input.members);
    // The pool changes which proxies the channel's group may route through.
    await applyConfig(db);
    return { ok: true as const };
  }),
  setPolicy: protectedProcedure.input(setChannelPolicyInput).mutation(async ({ input }) => {
    setChannelPolicy(db, input.id, input.policy);
    // Drop transient control state (failures/heldSince/lastCheck/lastSpeedNow) from the
    // previous policy session so it can't leak into the new one — e.g. a stale
    // heldSince misfiring maxHoldHours. The decision log is preserved.
    registry.reset(input.id);
    // The policy shapes the mihomo config (group type + tuning) — regenerate + reload.
    const { applied } = await applyConfig(db);
    return { ok: true as const, applied };
  }),
  recentDecisions: protectedProcedure.query(() => registry.recent()),
});
