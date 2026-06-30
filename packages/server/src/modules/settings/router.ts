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
    // AUTO tuning AND the API secret both live in the generated mihomo config —
    // regenerate + reload so the on-disk config and the panel stay coherent (a
    // secret only re-pointed on the client would diverge from the config on the
    // next reload / engine restart).
    if (input.key.startsWith("auto") || input.key === "mihomoSecret") {
      await applyConfig(db);
    }
    // Re-point the client AFTER the reload: reloadConfig authenticates with the
    // current (old) secret, so rotating the client first would 401 the reload.
    if (input.key === "mihomoSecret") setMihomoSecret(input.value);
    return { ok: true as const };
  }),
});
