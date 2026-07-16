import { diagnosticsResultSchema, diagnosticsRunInput } from "@submerge/shared";
import { protectedProcedure, router } from "../../trpc/trpc.js";
import type { DiagnosticsService } from "./service.js";
import { diagnosticsService } from "./singleton.js";

export function makeDiagnosticsRouter(service: Pick<DiagnosticsService, "run">) {
  return router({
    run: protectedProcedure
      .input(diagnosticsRunInput)
      .output(diagnosticsResultSchema)
      .query(({ input }) => service.run(input)),
  });
}

export const diagnosticsRouter = makeDiagnosticsRouter(diagnosticsService);
