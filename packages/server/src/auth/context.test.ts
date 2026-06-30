import { describe, expect, it } from "vitest";
import { createCallerFactory, protectedProcedure, router } from "../trpc/trpc.js";

const appRouter = router({ ping: protectedProcedure.query(() => "ok") });
const caller = createCallerFactory(appRouter);
const stub = { req: {} as never, res: {} as never };

describe("protectedProcedure", () => {
  it("allows when auth not required", async () => {
    expect(await caller({ authed: false, authRequired: false, ...stub }).ping()).toBe("ok");
  });
  it("allows when authed", async () => {
    expect(await caller({ authed: true, authRequired: true, ...stub }).ping()).toBe("ok");
  });
  it("rejects when required and not authed", async () => {
    await expect(caller({ authed: false, authRequired: true, ...stub }).ping()).rejects.toThrow(
      /Authentication required/,
    );
  });
});
