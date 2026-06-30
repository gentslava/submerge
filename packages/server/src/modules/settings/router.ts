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
    // The secret is the panel's credential for the mihomo API (which may be an
    // external engine) — re-point the client; don't force-rewrite mihomo's config.
    if (input.key === "mihomoSecret") setMihomoSecret(input.value);
    return { ok: true as const };
  }),
});
