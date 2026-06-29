import { describe, expect, it } from "vitest";
import { createCallerFactory, router } from "../trpc/trpc.js";
import { authRouter } from "./router.js";

const caller = createCallerFactory(router({ auth: authRouter }));
const stub = { req: { headers: {} } as never, res: { setHeader() {} } as never };

describe("auth router", () => {
  it("me reflects the context flags", async () => {
    const open = caller({ authed: true, authRequired: false, ...stub });
    expect(await open.auth.me()).toEqual({ authed: true, required: false });
    const locked = caller({ authed: false, authRequired: true, ...stub });
    expect(await locked.auth.me()).toEqual({ authed: false, required: true });
  });
});
