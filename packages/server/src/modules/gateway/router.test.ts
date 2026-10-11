import { describe, expect, it, vi } from "vitest";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { gatewayRouter } from "./router.js";
import { configureGateway } from "./service.js";

vi.mock("../../db/client.js", () => ({ db: {} }));
vi.mock("./service.js", () => ({
  configureGateway: vi.fn(async () => ({ applied: true })),
  gatewayReadiness: vi.fn(),
  getGatewayConfiguration: vi.fn(),
}));
vi.mock("./settings.js", () => ({ readNetworkProfile: vi.fn(() => ({ profile: "proxy" })) }));
const makeCaller = (authed: boolean) =>
  createCallerFactory(router({ gateway: gatewayRouter }))({
    authed,
    authRequired: true,
    req: {} as never,
    res: {} as never,
  });
describe("gateway protected router", () => {
  it("requires authentication for settings and readiness", async () => {
    const caller = makeCaller(false);
    await expect(caller.gateway.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.gateway.configuration()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.gateway.readiness()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.gateway.set({ profile: "proxy" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("validates gateway input before activating configuration", async () => {
    await expect(
      makeCaller(true).gateway.set({ profile: "gateway", nameservers: ["system"] } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(configureGateway).not.toHaveBeenCalled();
    expect(await makeCaller(true).gateway.get()).toEqual({ profile: "proxy" });
  });
});
