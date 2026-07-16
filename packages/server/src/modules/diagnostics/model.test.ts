import type {
  DiagnosticCheckStatus,
  DiagnosticRouteResult,
  DiagnosticServiceResult,
} from "@submerge/shared";
import { describe, expect, it } from "vitest";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import {
  type DiagnosticStateInput,
  deriveDiagnosticState,
  resolveActiveLeaf,
  safeTargetHost,
} from "./model.js";

function proxy(name: string, extra: Record<string, unknown> = {}) {
  return { name, type: "Vless", history: [], ...extra };
}

describe("resolveActiveLeaf", () => {
  it("follows nested groups to the current non-group proxy", () => {
    const proxies: ProxiesResponse["proxies"] = {
      AUTO: proxy("AUTO", { type: "URLTest", all: ["nested"], now: "nested" }),
      nested: proxy("nested", { type: "Selector", all: ["NL"], now: "NL" }),
      NL: proxy("NL"),
    };
    expect(resolveActiveLeaf(proxies, "AUTO")).toBe("NL");
  });

  it("accepts DIRECT as a resolved leaf", () => {
    const proxies: ProxiesResponse["proxies"] = {
      AUTO: proxy("AUTO", { type: "Selector", all: ["DIRECT"], now: "DIRECT" }),
      DIRECT: proxy("DIRECT", { type: "Direct" }),
    };
    expect(resolveActiveLeaf(proxies, "AUTO")).toBe("DIRECT");
  });

  it.each([
    ["missing group", { proxies: {} }, "AUTO"],
    ["missing now", { proxies: { AUTO: proxy("AUTO", { all: ["NL"] }) } }, "AUTO"],
    ["missing member", { proxies: { AUTO: proxy("AUTO", { all: ["NL"], now: "NL" }) } }, "AUTO"],
    [
      "cycle",
      {
        proxies: {
          AUTO: proxy("AUTO", { all: ["nested"], now: "nested" }),
          nested: proxy("nested", { all: ["AUTO"], now: "AUTO" }),
        },
      },
      "AUTO",
    ],
  ])("returns null for %s", (_name, response, groupName) => {
    expect(resolveActiveLeaf(response.proxies, groupName)).toBeNull();
  });
});

describe("safeTargetHost", () => {
  it("returns only the hostname", () => {
    expect(safeTargetHost("https://user:secret@example.com:8443/path?q=token#hash")).toBe(
      "example.com",
    );
  });

  it.each(["not a url", "ftp://example.com/file", "https://"])(
    "uses safe fallback for invalid configured value: %s",
    (value) => expect(safeTargetHost(value)).toBe("контрольный URL"),
  );
});

function route(status: DiagnosticCheckStatus): DiagnosticRouteResult {
  return {
    channelId: "default",
    channelName: "Default",
    targetHost: "gstatic.com",
    node: "NL",
    status,
    durationMs: status === "ok" ? 8000 : null,
    detail: "route",
    errorCode: status === "failed" ? "unreachable" : null,
  };
}

function service(status: DiagnosticCheckStatus): DiagnosticServiceResult {
  return {
    id: "google",
    label: "Google",
    status,
    durationMs: status === "ok" ? 9000 : null,
    httpStatus: status === "ok" ? 204 : null,
    detail: "service",
    errorCode: status === "failed" ? "unreachable" : null,
  };
}

function stateInput(overrides: Partial<DiagnosticStateInput> = {}): DiagnosticStateInput {
  return {
    mihomoStatus: "ok",
    realNodeCount: 1,
    externalIpStatus: "ok",
    routes: [route("ok")],
    services: [service("ok")],
    remainingRequiredStatuses: ["ok", "ok", "ok"],
    ...overrides,
  };
}

describe("deriveDiagnosticState", () => {
  it("uses the specified actionable precedence", () => {
    expect(
      deriveDiagnosticState(
        stateInput({ mihomoStatus: "failed", realNodeCount: 0, externalIpStatus: "failed" }),
      ),
    ).toBe("mihomo-down");
    expect(deriveDiagnosticState(stateInput({ realNodeCount: 0 }))).toBe("no-nodes");
    expect(
      deriveDiagnosticState(
        stateInput({
          externalIpStatus: "failed",
          routes: [route("failed"), route("skipped")],
          services: [service("failed")],
        }),
      ),
    ).toBe("no-internet");
    expect(deriveDiagnosticState(stateInput({ externalIpStatus: "failed" }))).toBe(
      "external-ip-unavailable",
    );
    expect(
      deriveDiagnosticState(stateInput({ services: [service("failed"), service("ok")] })),
    ).toBe("partial");
    expect(
      deriveDiagnosticState(stateInput({ remainingRequiredStatuses: ["ok", "skipped"] })),
    ).toBe("partial");
    expect(deriveDiagnosticState(stateInput())).toBe("ready");
  });

  it("does not treat skipped outbound checks as passes or attempted failures", () => {
    expect(
      deriveDiagnosticState(
        stateInput({
          externalIpStatus: "skipped",
          routes: [route("skipped")],
          services: [service("skipped")],
        }),
      ),
    ).toBe("partial");
  });

  it("keeps slow successful checks healthy", () => {
    expect(deriveDiagnosticState(stateInput())).toBe("ready");
  });
});
