import { setSettingInput } from "@submerge/shared";
import { TRPCError } from "@trpc/server";
import { db } from "../../db/client.js";
import { operationalLog } from "../../log.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { reconcileDomainRuleDeployment } from "../logs/singleton.js";
import { applyConfig } from "../nodes/service.js";
import {
  beginMihomoSecretRotation,
  getMihomoSecretRotationPersistenceState,
  type MihomoSecretRotationAttempt,
  rollbackMihomoSecretRotation,
} from "./secret-rotation.js";
import { getSettingsView, isInternalSettingKey, setSetting } from "./service.js";

export const settingsRouter = router({
  get: protectedProcedure.query(() => getSettingsView(db)),
  set: protectedProcedure.input(setSettingInput).mutation(async ({ input }) => {
    if (isInternalSettingKey(input.key) || input.key === "domainIntelligence") {
      throw new TRPCError({ code: "FORBIDDEN", message: "managed settings are read-only" });
    }
    if (input.key !== "mihomoSecret") setSetting(db, input.key, input.value);
    // The secret is editable, but the confirmed DB value must stay unchanged until
    // Mihomo authenticates with the replacement. The serialized raw apply creates a
    // durable internal journal; config generation/reload owns proof and promotion.
    // Rejection before the callback creates no journal, while a pre-activation failure
    // invokes the returned rollback. Ambiguous reload failures deliberately retain the
    // journal so a restart can probe both credentials instead of guessing.
    let applied = true;
    if (input.key === "mihomoSecret") {
      let rotationAttempt: MihomoSecretRotationAttempt | null = null;
      try {
        const result = await applyConfig(db, undefined, undefined, {
          stageConfigMutation: () => {
            rotationAttempt = beginMihomoSecretRotation(db, input.value);
            return () => {
              if (rotationAttempt) rollbackMihomoSecretRotation(db, rotationAttempt);
            };
          },
        });
        applied = result.applied;
      } catch (err) {
        operationalLog("secret-rotation-write-failed", {}, err);
        const persistence =
          rotationAttempt === null
            ? "absent"
            : getMihomoSecretRotationPersistenceState(db, rotationAttempt);
        if (persistence === "absent") {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Не удалось сохранить секрет mihomo",
          });
        }
        applied = persistence === "committed";
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
    const { applied } = await reconcileDomainRuleDeployment();
    return { ok: true as const, applied };
  }),
});
