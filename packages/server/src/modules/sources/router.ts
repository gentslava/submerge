import { addSourceInput, idInput, reorderInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import {
  addSource,
  listSources,
  refreshSource,
  removeSource,
  reorderSources,
  toggleSource,
} from "./service.js";

export const sourcesRouter = router({
  list: protectedProcedure.query(() => listSources(db)),
  add: protectedProcedure.input(addSourceInput).mutation(({ input }) => addSource(db, input)),
  remove: protectedProcedure.input(idInput).mutation(({ input }) => removeSource(db, input.id)),
  refresh: protectedProcedure.input(idInput).mutation(({ input }) => refreshSource(db, input.id)),
  toggle: protectedProcedure.input(idInput).mutation(({ input }) => toggleSource(db, input.id)),
  reorder: protectedProcedure
    .input(reorderInput)
    .mutation(({ input }) => reorderSources(db, input.ids)),
});
