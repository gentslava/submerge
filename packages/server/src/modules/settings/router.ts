import { setSettingInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { publicProcedure, router } from "../../trpc/trpc.js";
import { getAllSettings, setSetting } from "./service.js";

export const settingsRouter = router({
  get: publicProcedure.query(() => getAllSettings(db)),
  set: publicProcedure.input(setSettingInput).mutation(({ input }) => {
    setSetting(db, input.key, input.value);
    return { ok: true as const };
  }),
});
