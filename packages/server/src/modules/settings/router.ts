import { setSettingInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { getAllSettings, setSetting } from "./service.js";

export const settingsRouter = router({
  get: protectedProcedure.query(() => getAllSettings(db)),
  set: protectedProcedure.input(setSettingInput).mutation(({ input }) => {
    setSetting(db, input.key, input.value);
    return { ok: true as const };
  }),
});
