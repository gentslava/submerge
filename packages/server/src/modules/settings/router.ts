import { setSettingInput } from "@submerge/shared";
import { setMihomoSecret } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { applyConfig } from "../nodes/service.js";
import { getSettingsView, setSetting } from "./service.js";

export const settingsRouter = router({
  get: protectedProcedure.query(() => getSettingsView(db)),
  set: protectedProcedure.input(setSettingInput).mutation(async ({ input }) => {
    setSetting(db, input.key, input.value);
    // AUTO tuning lives in the mihomo config — regenerate + reload so it takes effect.
    if (input.key.startsWith("auto")) await applyConfig(db);
    // The secret is editable: it's written into the regenerated config (rotating a
    // sidecar engine) AND it's the panel's client credential. reloadConfig authenticates
    // with the CURRENT (old) secret, so we rotate first, then re-point the client in a
    // `finally` — that re-point ALWAYS runs even if the reload 401s, so typing a wrong
    // secret can never lock you out (re-enter the right one to recover).
    if (input.key === "mihomoSecret") {
      try {
        await applyConfig(db);
      } catch {
        /* engine unreachable or current secret stale — the client re-point below recovers */
      } finally {
        setMihomoSecret(input.value);
      }
    }
    return { ok: true as const };
  }),
});
