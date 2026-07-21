import type { Source } from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { makeSourcesRouter } from "./router.js";

function source(): Source {
  return {
    id: 7,
    kind: "sub",
    value: "https://provider.example/sub",
    label: "Provider",
    hwid: false,
    enabled: true,
    sortOrder: 0,
    proxies: [],
    meta: null,
    updatedAt: "2026-07-21 09:00:00",
    createdAt: "2026-07-20 09:00:00",
  };
}

describe("sources router", () => {
  it("runs a manual refresh through the shared coordinator", async () => {
    const coordinator = {
      refresh: vi.fn(async () => ({ source: source(), applied: true })),
    };
    const appRouter = router({ sources: makeSourcesRouter(coordinator) });
    const caller = createCallerFactory(appRouter)({
      authed: true,
      authRequired: true,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.sources.refresh({ id: 7 })).resolves.toEqual({
      source: source(),
      applied: true,
    });
    expect(coordinator.refresh).toHaveBeenCalledWith(7, "manual");
  });
});
