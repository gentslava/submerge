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
    // The secret is the panel's CLIENT credential for the mihomo API (possibly an
    // external engine) — only re-point the client. We deliberately do NOT reload the
    // config on a secret change: reloadConfig authenticates with the current secret,
    // so reloading here would 401 and lock you out the moment a wrong secret is typed
    // (you could never enter the right one). The config's own secret is the deploy
    // secret (env), independent of this value.
    if (input.key === "mihomoSecret") setMihomoSecret(input.value);
    return { ok: true as const };
  }),
});
