import { addSourceInput, idInput, reorderInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { publicProcedure, router } from "../../trpc/trpc.js";
import {
  addSource,
  listSources,
  refreshSource,
  removeSource,
  reorderSources,
  toggleSource,
} from "./service.js";

export const sourcesRouter = router({
  list: publicProcedure.query(() => listSources(db)),
  add: publicProcedure.input(addSourceInput).mutation(({ input }) => addSource(db, input)),
  remove: publicProcedure.input(idInput).mutation(({ input }) => removeSource(db, input.id)),
  refresh: publicProcedure.input(idInput).mutation(({ input }) => refreshSource(db, input.id)),
  toggle: publicProcedure.input(idInput).mutation(({ input }) => toggleSource(db, input.id)),
  reorder: publicProcedure
    .input(reorderInput)
    .mutation(({ input }) => reorderSources(db, input.ids)),
});
