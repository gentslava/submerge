import { setSettingInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { applyConfig } from "../nodes/service.js";
import { getAllSettings, setSetting } from "./service.js";

export const settingsRouter = router({
  get: protectedProcedure.query(() => getAllSettings(db)),
  set: protectedProcedure.input(setSettingInput).mutation(async ({ input }) => {
    setSetting(db, input.key, input.value);
    // url-test tuning lives in the mihomo config — regenerate + reload so it takes effect.
    if (input.key.startsWith("autoTest")) await applyConfig(db);
    return { ok: true as const };
  }),
});
