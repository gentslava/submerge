import { describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { createCallerFactory } from "./trpc.js";

const createCaller = createCallerFactory(appRouter);

describe("appRouter", () => {
  it("health.ping returns ok", async () => {
    const caller = createCaller({ authed: true });
    const res = await caller.health.ping();
    expect(res.ok).toBe(true);
    expect(typeof res.version).toBe("string");
  });
});
