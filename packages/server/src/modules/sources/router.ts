import { addSourceInput, idInput, reorderInput } from "@submerge/shared";
import { db } from "../../db/client.js";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import { sourceRefreshCoordinator } from "./instance.js";
import type { SourceRefreshCoordinator } from "./refresh.js";
import { addSource, listSources, removeSource, reorderSources, toggleSource } from "./service.js";

type SourceRefreshRunner = Pick<SourceRefreshCoordinator, "refresh">;

export function makeSourcesRouter(refreshCoordinator: SourceRefreshRunner) {
  return router({
    list: protectedProcedure.query(() => listSources(db)),
    add: protectedProcedure.input(addSourceInput).mutation(({ input }) => addSource(db, input)),
    remove: protectedProcedure.input(idInput).mutation(({ input }) => removeSource(db, input.id)),
    refresh: protectedProcedure
      .input(idInput)
      .mutation(({ input }) => refreshCoordinator.refresh(input.id, "manual")),
    toggle: protectedProcedure.input(idInput).mutation(({ input }) => toggleSource(db, input.id)),
    reorder: protectedProcedure
      .input(reorderInput)
      .mutation(({ input }) => reorderSources(db, input.ids)),
  });
}

export const sourcesRouter = makeSourcesRouter(sourceRefreshCoordinator);
