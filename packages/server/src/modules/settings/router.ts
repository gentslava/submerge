import { setSettingInput } from "@submerge/shared";
import { setMihomoSecret } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { log } from "../../log.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { applyConfig } from "../nodes/service.js";
import { getSettingsView, setSetting } from "./service.js";

export const settingsRouter = router({
  get: protectedProcedure.query(() => getSettingsView(db)),
  set: protectedProcedure.input(setSettingInput).mutation(async ({ input }) => {
    setSetting(db, input.key, input.value);
    // The secret is editable: it's written into the regenerated config (rotating a
    // sidecar engine) AND it's the panel's client credential. reloadConfig authenticates
    // with the CURRENT (old) secret, so we rotate first, then re-point the client in a
    // `finally` — that re-point ALWAYS runs even if the reload 401s, so typing a wrong
    // secret can never lock you out (re-enter the right one to recover).
    let applied = true;
    if (input.key === "mihomoSecret") {
      try {
        // Reload failures are soft inside applyConfig (applied:false); this catch
        // now only guards fs errors — still non-fatal here, so a wrong secret or a
        // broken mount can't block the client re-point below.
        ({ applied } = await applyConfig(db));
      } catch (err) {
        log.warn({ err }, "config write after secret rotation failed");
        applied = false;
      } finally {
        setMihomoSecret(input.value);
      }
    }
    return { ok: true as const, applied };
  }),
  // "Перезагрузить конфиг": regenerate the config from current state and reload mihomo
  // (PUT /configs). mihomo runs as a separate process/container, so a true process
  // restart isn't ours to trigger — reapplying + reloading the config is the honest
  // engine-side refresh, and it also heals any drift between the DB and the engine.
  reload: protectedProcedure.mutation(async () => {
    const { applied } = await applyConfig(db);
    return { ok: true as const, applied };
  }),
});
