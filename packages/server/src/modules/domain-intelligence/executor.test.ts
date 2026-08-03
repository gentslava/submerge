import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainIntelligenceSettingsView,
} from "@submerge/shared";
import { describe, expect, it, vi } from "vitest";
import type { ValidationAttempt } from "./decision.js";
import { DomainValidationExecutor } from "./executor.js";
import type { DomainValidationSchedulerError } from "./scheduler.js";

const HOUR_MS = 60 * 60 * 1_000;
const evaluatedAt = 48 * HOUR_MS;
const fqdn = "api.service.example";

function readyView(): DomainIntelligenceSettingsView {
  return {
    configurationState: "ready",
    settings: {
      ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
      enabled: true,
      automationMode: "review",
      defaultRuleScope: "exact",
    },
    automatic: { available: false, reason: "publisher-unavailable" },
  };
}

function attempt(
  attemptId: string,
  attemptedAt: number,
  direction: "direct" | "proxy",
): ValidationAttempt {
  return direction === "direct"
    ? {
        attemptId,
        attemptedAt,
        category: "connect_timeout",
        transportSuccess: false,
        httpStatus: null,
        resolvedAddress: "1.1.1.1",
        availableAddressCount: 1,
        finalOrigin: `https://${fqdn}`,
      }
    : {
        attemptId,
        attemptedAt,
        category: "http_response",
        transportSuccess: true,
        httpStatus: 403,
        resolvedAddress: "1.1.1.1",
        availableAddressCount: 1,
        finalOrigin: `https://${fqdn}`,
      };
}

function harness(
  overrides: Partial<ConstructorParameters<typeof DomainValidationExecutor>[0]> = {},
) {
  const readAttempts = vi.fn(() => ({
    direct: [
      attempt("direct_1", evaluatedAt - 4 * HOUR_MS, "direct"),
      attempt("direct_2", evaluatedAt - 2 * HOUR_MS, "direct"),
    ],
    proxy: [attempt("proxy_1", evaluatedAt - 2 * HOUR_MS, "proxy")],
  }));
  const probeDirect = vi.fn(async () => ({
    direction: "direct" as const,
    category: "connect_timeout" as const,
    transportSuccess: false,
    httpStatus: null,
    resolvedAddress: "1.1.1.1",
    availableAddressCount: 1,
    connectDurationMs: 5_000,
    tlsDurationMs: null,
    totalDurationMs: 8_000,
    redirectCount: 0,
    finalOrigin: `https://${fqdn}`,
  }));
  const probeProxy = vi.fn(async () => ({
    direction: "proxy" as const,
    category: "http_response" as const,
    transportSuccess: true,
    httpStatus: 403,
    resolvedAddress: "1.1.1.1",
    availableAddressCount: 1,
    connectDurationMs: 20,
    tlsDurationMs: 30,
    totalDurationMs: 60,
    redirectCount: 0,
    finalOrigin: `https://${fqdn}`,
  }));
  const deps = {
    readSettings: () => readyView(),
    readCoverage: () => ({ status: "uncovered" as const, match: null, incompleteSourceIds: [] }),
    readObservationCount: () => 3,
    readAttempts,
    observationHealthy: () => true,
    probeDirect,
    probeProxy,
    now: () => evaluatedAt,
    ...overrides,
  };
  return { executor: new DomainValidationExecutor(deps), probeDirect, probeProxy, readAttempts };
}

const candidate = {
  fqdn,
  registrableSite: "service.example",
  selectedScope: "exact" as const,
  proposedRule: fqdn,
  nextValidationAt: evaluatedAt,
  failureStreak: 0,
  updatedAt: evaluatedAt,
};

describe("DomainValidationExecutor", () => {
  it("runs one parallel A/B pair and decides from persisted plus current evidence", async () => {
    const { executor, probeDirect, probeProxy, readAttempts } = harness();

    const execution = await executor.execute(candidate, new AbortController().signal);

    expect(execution.decision.value).toMatchObject({ status: "confirmed", reasons: [] });
    expect(readAttempts).toHaveBeenCalledTimes(2);
    expect(probeDirect).toHaveBeenCalledWith(
      fqdn,
      expect.objectContaining({
        resolverQuorum: 2,
        connectTimeoutMs: 5_000,
        totalTimeoutMs: 8_000,
        addressSelectionIndex: 2,
      }),
    );
    expect(probeProxy).toHaveBeenCalledTimes(1);
  });

  it("does not confirm an exact rule from a DIRECT failure on a redirect outside its scope", async () => {
    const { executor } = harness({
      probeDirect: vi.fn(async () => ({
        direction: "direct" as const,
        category: "connect_timeout" as const,
        transportSuccess: false,
        httpStatus: null,
        resolvedAddress: "1.1.1.1",
        availableAddressCount: 1,
        connectDurationMs: 5_000,
        tlsDurationMs: null,
        totalDurationMs: 8_000,
        redirectCount: 1,
        finalOrigin: "https://blocked.shared.example",
      })),
    });

    const execution = await executor.execute(candidate, new AbortController().signal);

    expect(execution.decision.value).toMatchObject({
      status: "pending",
      reasons: expect.arrayContaining(["insufficient-direct-failures"]),
      evidence: { directQualifyingFailures: 2 },
    });
  });

  it("classifies a final coverage read failure without persisting a false decision", async () => {
    const { executor } = harness({
      readCoverage: () => {
        throw new Error("provider cache unavailable");
      },
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "coverage-failure",
      }),
    );
  });

  it("refuses to probe when the persisted runtime intent is disabled", async () => {
    const { executor, probeDirect, probeProxy } = harness({
      readSettings: () => ({
        ...readyView(),
        settings: {
          ...readyView().settings,
          enabled: false,
          automationMode: "off",
        },
      }),
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "infrastructure-failure",
      }),
    );
    expect(probeDirect).not.toHaveBeenCalled();
    expect(probeProxy).not.toHaveBeenCalled();
  });

  it("rejects a newly forbidden queued candidate before any network probe", async () => {
    const { executor, probeDirect, probeProxy } = harness({
      readSettings: () => ({
        ...readyView(),
        settings: {
          ...readyView().settings,
          neverAddDomains: [fqdn],
        },
      }),
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "policy-changed",
      }),
    );
    expect(probeDirect).not.toHaveBeenCalled();
    expect(probeProxy).not.toHaveBeenCalled();
  });

  it("blocks already-covered candidates without consuming an A/B probe pair", async () => {
    const { executor, probeDirect, probeProxy } = harness({
      readCoverage: () => ({
        status: "covered",
        match: {
          kind: "suffix",
          rule: "service.example",
          sourceKind: "third-party",
          sourceId: "provider:active",
        },
        incompleteSourceIds: [],
      }),
    });

    const execution = await executor.execute(candidate, new AbortController().signal);

    expect(execution.attempts).toEqual([]);
    expect(execution.decision.value).toMatchObject({
      status: "blocked",
      reasons: expect.arrayContaining(["already-covered"]),
    });
    expect(probeDirect).not.toHaveBeenCalled();
    expect(probeProxy).not.toHaveBeenCalled();
  });

  it("opens a circuit-worthy failure for incomplete provider materialization before probes", async () => {
    const { executor, probeDirect, probeProxy } = harness({
      readCoverage: () => ({
        status: "incomplete",
        match: null,
        incompleteSourceIds: ["provider:unavailable"],
      }),
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "coverage-failure",
      }),
    );
    expect(probeDirect).not.toHaveBeenCalled();
    expect(probeProxy).not.toHaveBeenCalled();
  });

  it("cancels and awaits the peer probe when one side fails", async () => {
    let directAborted = false;
    const probeDirect = vi.fn(
      async (_fqdn: string, request: { signal: AbortSignal }): Promise<never> =>
        new Promise((_, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              directAborted = true;
              reject(request.signal.reason);
            },
            { once: true },
          );
        }),
    );
    const { executor } = harness({
      probeDirect,
      probeProxy: vi.fn(async () => {
        throw new Error("validation route disappeared");
      }),
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "proxy-probe-failure",
      }),
    );
    expect(directAborted).toBe(true);
  });

  it("turns common proxy infrastructure outcomes into circuit-worthy failures", async () => {
    const { executor } = harness({
      probeProxy: vi.fn(async () => ({
        direction: "proxy" as const,
        category: "route_proof_failure" as const,
        transportSuccess: false,
        httpStatus: null,
        resolvedAddress: "1.1.1.1",
        availableAddressCount: 1,
        connectDurationMs: 20,
        tlsDurationMs: null,
        totalDurationMs: 50,
        redirectCount: 0,
        finalOrigin: `https://${fqdn}`,
      })),
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "infrastructure-failure",
      }),
    );
  });

  it("turns DIRECT resolver disagreement into a circuit-worthy failure", async () => {
    const { executor } = harness({
      probeDirect: vi.fn(async () => ({
        direction: "direct" as const,
        category: "infrastructure_error" as const,
        transportSuccess: false,
        httpStatus: null,
        resolvedAddress: null,
        availableAddressCount: 0,
        connectDurationMs: null,
        tlsDurationMs: null,
        totalDurationMs: 50,
        redirectCount: 0,
        finalOrigin: `https://${fqdn}`,
      })),
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "infrastructure-failure",
      }),
    );
  });

  it("fails closed when the bounded coverage snapshot changes during the probe pair", async () => {
    const readCoverage = vi.fn(() => ({
      status: "uncovered" as const,
      match: null,
      incompleteSourceIds: [],
    }));
    const { executor, probeDirect, probeProxy } = harness({
      createCoverageSnapshot: () => ({
        readCoverage,
        isCurrent: () => false,
      }),
    });

    await expect(executor.execute(candidate, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining<Partial<DomainValidationSchedulerError>>({
        category: "coverage-failure",
      }),
    );
    expect(readCoverage).toHaveBeenCalledTimes(1);
    expect(probeDirect).toHaveBeenCalledTimes(1);
    expect(probeProxy).toHaveBeenCalledTimes(1);
  });
});
