import { setSettingInput } from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { setMihomoSecret } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { operationalLog } from "../../log.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { domainIntelligenceRuntimeCoordinator } from "../logs/singleton.js";
import { applyConfig } from "../nodes/service.js";
import { getSettingsView, isInternalSettingKey, setSetting } from "./service.js";

export const settingsRouter = router({
  get: protectedProcedure.query(() => getSettingsView(db)),
  set: protectedProcedure.input(setSettingInput).mutation(async ({ input }) => {
    if (isInternalSettingKey(input.key) || input.key === "domainIntelligence") {
      throw new TRPCError({ code: "FORBIDDEN", message: "managed settings are read-only" });
    }
    setSetting(db, input.key, input.value);
    // The secret is editable: it's written into the regenerated config (rotating a
    // sidecar engine) AND it's the panel's client credential. reloadConfig authenticates
    // with the CURRENT (old) secret. The serialized callback re-points the client after
    // the reload attempt but before domain-intelligence runtime resumption. A reload
    // failure still re-points the client, so re-entering the prior secret can recover.
    let applied = true;
    if (input.key === "mihomoSecret") {
      try {
        const result = await domainIntelligenceRuntimeCoordinator.runConfigApply(async () => {
          try {
            return await applyConfig(db, undefined, undefined, {
              skipRuntimeReconciliation: true,
            });
          } finally {
            // The reload above authenticates with the old secret. Re-point the client
            // before this serialized callback resolves so the runtime cannot issue its
            // first /connections request with stale credentials.
            setMihomoSecret(input.value);
          }
        });
        applied = result.applied;
      } catch (err) {
        operationalLog("secret-rotation-write-failed", {}, err);
        applied = false;
      }
    }
    return { ok: true as const, applied };
  }),
  // "Перезагрузить конфиг": regenerate the config from current state and reload mihomo
  // (PUT /configs). mihomo runs as a separate process/container, so a true process
  // restart isn't ours to trigger — reapplying + reloading the config is the honest
  // engine-side refresh, and it also heals any drift between the DB and the engine.
  // `force` is essential here: this button's whole job is to push a reload even when
  // the config is byte-identical to disk (that's exactly the drift-recovery case, e.g.
  // after a previous reload failed and left the engine stale). The coordinator owns
  // that forced apply and keeps the domain observer disabled until it succeeds.
  reload: protectedProcedure.mutation(async () => {
    const { applied } = await domainIntelligenceRuntimeCoordinator.reconcile();
    return { ok: true as const, applied };
  }),
});
