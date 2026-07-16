import type { DiagnosticsResult } from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { makeDiagnosticsRouter } from "./router.js";

function result(): DiagnosticsResult {
  const timestamp = "2026-07-16T08:00:00.000Z";
  return {
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 10,
    state: "ready",
    summary: "1 из 1 маршрутов · 6 из 6 сервисов",
    components: [],
    externalIp: {
      status: "ok",
      ip: "185.107.56.42",
      country: "NL",
      colo: "AMS",
      durationMs: 5,
      route: "Default",
      node: "NL",
      detail: "Внешний IP определён",
      errorCode: null,
    },
    routes: [],
    services: [],
    config: {
      status: "ok",
      proxyEndpoint: "127.0.0.1:7890",
      mode: "rule",
      dns: true,
      ipv6: false,
      tun: false,
      errorCode: null,
    },
  };
}

function caller(
  service: { run: (input?: { force?: boolean }) => Promise<DiagnosticsResult> },
  authed = true,
) {
  const appRouter = router({ diagnostics: makeDiagnosticsRouter(service) });
  return createCallerFactory(appRouter)({
    authed,
    authRequired: true,
    req: {} as never,
    res: {} as never,
  });
}

describe("diagnostics router", () => {
  it("parses the default input and forwards force refresh", async () => {
    const service = { run: vi.fn(async () => result()) };
    await expect(caller(service).diagnostics.run({})).resolves.toEqual(result());
    expect(service.run).toHaveBeenLastCalledWith({ force: false });

    await caller(service).diagnostics.run({ force: true });
    expect(service.run).toHaveBeenLastCalledWith({ force: true });
  });

  it("protects the query", async () => {
    const service = { run: vi.fn(async () => result()) };
    await expect(caller(service, false).diagnostics.run({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(service.run).not.toHaveBeenCalled();
  });

  it("rejects output that does not match the shared contract", async () => {
    const service = { run: vi.fn(async () => ({ ...result(), rawError: "secret" })) };
    await expect(caller(service as never).diagnostics.run({})).rejects.toThrow();
  });
});
