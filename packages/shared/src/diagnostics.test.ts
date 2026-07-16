import { describe, expect, it } from "vitest";
import {
  diagnosticCheckStatusSchema,
  diagnosticErrorCodeSchema,
  diagnosticsResultSchema,
  diagnosticsRunInput,
} from "./diagnostics.js";

const validResult = {
  startedAt: "2026-07-16T08:00:00.000Z",
  completedAt: "2026-07-16T08:00:01.250Z",
  durationMs: 1250,
  state: "ready",
  summary: "4 из 4 маршрутов работают",
  components: [
    {
      id: "submerge",
      status: "ok",
      durationMs: 12,
      version: "0.2.0",
      detail: "SQLite доступна",
      errorCode: null,
    },
    {
      id: "mihomo",
      status: "ok",
      durationMs: 4,
      version: "v1.19.12",
      detail: "Контроллер доступен",
      errorCode: null,
    },
    {
      id: "happ-decoder",
      status: "ok",
      durationMs: 18,
      version: null,
      detail: "Доступен",
      errorCode: null,
    },
  ],
  externalIp: {
    status: "ok",
    ip: "185.107.56.42",
    country: "NL",
    colo: "AMS",
    durationMs: 84,
    route: "Default",
    node: "nl-ams-01",
    detail: "Cloudflare trace",
    errorCode: null,
  },
  routes: [
    {
      channelId: "default",
      channelName: "Default",
      targetHost: "gstatic.com",
      node: "nl-ams-01",
      status: "ok",
      durationMs: 48,
      detail: "Маршрут доступен",
      errorCode: null,
    },
  ],
  services: [
    {
      id: "google",
      label: "Google",
      status: "ok",
      durationMs: 44,
      httpStatus: 204,
      detail: "Доступен",
      errorCode: null,
    },
  ],
  config: {
    status: "ok",
    proxyEndpoint: "127.0.0.1:7890",
    mode: "rule",
    dns: true,
    ipv6: false,
    tun: null,
    errorCode: null,
  },
} as const;

describe("diagnostics contract", () => {
  it("parses the complete safe result shape", () => {
    expect(diagnosticsResultSchema.parse(validResult)).toEqual(validResult);
  });

  it("defaults a missing force flag to false", () => {
    expect(diagnosticsRunInput.parse({})).toEqual({ force: false });
    expect(diagnosticsRunInput.parse({ force: true })).toEqual({ force: true });
  });

  it.each([
    ["negative result duration", { ...validResult, durationMs: -1 }],
    [
      "negative nested duration",
      {
        ...validResult,
        services: [{ ...validResult.services[0], durationMs: -1 }],
      },
    ],
    ["invalid start time", { ...validResult, startedAt: "today" }],
    [
      "malformed IP",
      { ...validResult, externalIp: { ...validResult.externalIp, ip: "999.1.1.1" } },
    ],
    [
      "unknown component",
      {
        ...validResult,
        components: [{ ...validResult.components[0], id: "redis" }],
      },
    ],
    [
      "unknown service",
      { ...validResult, services: [{ ...validResult.services[0], id: "example" }] },
    ],
    [
      "unknown status",
      { ...validResult, externalIp: { ...validResult.externalIp, status: "slow" } },
    ],
    [
      "raw nested error",
      {
        ...validResult,
        externalIp: {
          ...validResult.externalIp,
          error: { message: "Authorization: Bearer secret" },
        },
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(diagnosticsResultSchema.safeParse(value).success).toBe(false);
  });

  it("keeps finite status and error code enums", () => {
    expect(diagnosticCheckStatusSchema.safeParse("slow").success).toBe(false);
    expect(diagnosticErrorCodeSchema.safeParse("ECONNRESET").success).toBe(false);
  });
});
