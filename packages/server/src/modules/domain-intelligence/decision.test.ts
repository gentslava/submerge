import { describe, expect, it } from "vitest";
import type { CoverageResult } from "./coverage.js";
import {
  type CandidateEvidence,
  type DecisionPolicy,
  decideCandidate,
  type ValidationAttempt,
} from "./decision.js";
import { type DomainFilterPolicy, deriveDomainCandidate } from "./model.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
const FILTER_POLICY: DomainFilterPolicy = {
  excludedTlds: ["ru", "su", "xn--p1ai"],
  neverAddDomains: [],
  neverAddSuffixes: ["telemetry.example"],
  nonWidenableSuffixes: ["vercel.app"],
  telemetryPatterns: ["analytics"],
};
const POLICY: DecisionPolicy = {
  minimumConnectionCount: 3,
  directAttemptsRequired: 3,
  minimumAttemptSpacingMinutes: 120,
  validationWindowHours: 24,
  minimumProxySuccesses: 2,
  maximumProxyTransportFailures: 0,
};
const UNCOVERED: CoverageResult = {
  status: "uncovered",
  match: null,
  incompleteSourceIds: [],
};
let attemptSequence = 0;

function attempt(
  attemptedAt: number,
  overrides: Partial<ValidationAttempt> = {},
): ValidationAttempt {
  attemptSequence += 1;
  return {
    attemptId: `attempt-${attemptedAt}-${attemptSequence}`,
    attemptedAt,
    category: "connect_timeout",
    transportSuccess: false,
    httpStatus: null,
    resolvedAddress: "1.1.1.1",
    availableAddressCount: 1,
    finalOrigin: "https://api.service.example",
    ...overrides,
  };
}

function http(attemptedAt: number, httpStatus = 200): ValidationAttempt {
  return attempt(attemptedAt, {
    category: "http_response",
    transportSuccess: true,
    httpStatus,
  });
}

function confirmedEvidence(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  const candidate = deriveDomainCandidate("api.service.example", FILTER_POLICY, "site");
  if (!candidate) throw new Error("candidate fixture is invalid");
  const evidenceFqdn = overrides.fqdn ?? candidate.fqdn;
  return {
    fqdn: candidate.fqdn,
    connectionCount: 3,
    observationHealthy: true,
    filterPolicy: FILTER_POLICY,
    selectedScope: candidate.selectedScope,
    proposedRule: candidate.proposedRule,
    coverage: UNCOVERED,
    direct: [attempt(NOW - 23 * HOUR), attempt(NOW - 12 * HOUR), attempt(NOW - HOUR)].map(
      (item) => ({ ...item, finalOrigin: `https://${evidenceFqdn}` }),
    ),
    proxy: [http(NOW - 12 * HOUR, 401), http(NOW - HOUR, 429)].map((item) => ({
      ...item,
      finalOrigin: `https://${evidenceFqdn}`,
    })),
    ...overrides,
  };
}

describe("decideCandidate", () => {
  it("confirms only spaced DIRECT failures with two stable PROXY HTTP responses", () => {
    const decision = decideCandidate(confirmedEvidence(), POLICY, NOW);

    expect(decision).toEqual({
      confidence: "high",
      status: "confirmed",
      reasons: [],
      windowStart: NOW - 24 * HOUR,
      evidence: {
        directQualifyingFailures: 3,
        directSpacedFailures: 3,
        directAddressDiversityRequired: false,
        directAddressDiversitySatisfied: true,
        proxyHttpSuccesses: 2,
        proxyTransportFailures: 0,
        proxyUncertainFailures: 0,
      },
    });
  });

  it("does not count repeated DIRECT failures outside the proposed exact rule", () => {
    const exactCandidate = deriveDomainCandidate("api.service.example", FILTER_POLICY, "exact");
    if (!exactCandidate) throw new Error("exact candidate fixture is invalid");
    const direct = [23, 12, 1].map((hoursAgo) =>
      attempt(NOW - hoursAgo * HOUR, {
        finalOrigin: "https://blocked.shared.example",
      }),
    );

    expect(
      decideCandidate(
        confirmedEvidence({
          selectedScope: exactCandidate.selectedScope,
          proposedRule: exactCandidate.proposedRule,
          direct,
        }),
        POLICY,
        NOW,
      ),
    ).toMatchObject({
      status: "pending",
      reasons: ["insufficient-direct-failures"],
      evidence: { directQualifyingFailures: 0 },
    });
  });

  it("counts a redirected DIRECT failure when the selected site rule covers that host", () => {
    const direct = [23, 12, 1].map((hoursAgo) =>
      attempt(NOW - hoursAgo * HOUR, {
        finalOrigin: "https://cdn.service.example",
      }),
    );

    expect(decideCandidate(confirmedEvidence({ direct }), POLICY, NOW)).toMatchObject({
      status: "confirmed",
      reasons: [],
      evidence: { directQualifyingFailures: 3 },
    });
  });

  it.each([401, 403, 404, 429])(
    "counts application HTTP %s as PROXY transport success",
    (status) => {
      const evidence = confirmedEvidence({
        proxy: [http(NOW - 3 * HOUR, status), http(NOW - HOUR, status)],
      });

      expect(decideCandidate(evidence, POLICY, NOW)).toMatchObject({
        status: "confirmed",
        evidence: { proxyHttpSuccesses: 2, proxyTransportFailures: 0 },
      });
    },
  );

  it.each([
    "connect_timeout",
    "tls_timeout",
    "tls_handshake_reset",
    "connection_reset_before_http",
    "dns_failure",
  ] as const)("counts %s as a qualifying DIRECT transport failure", (category) => {
    const direct = [23, 12, 1].map((hoursAgo) =>
      attempt(NOW - hoursAgo * HOUR, {
        category,
        resolvedAddress: category === "dns_failure" ? null : "1.1.1.1",
        availableAddressCount: category === "dns_failure" ? 0 : 1,
      }),
    );

    expect(decideCandidate(confirmedEvidence({ direct }), POLICY, NOW)).toMatchObject({
      status: "confirmed",
      evidence: { directQualifyingFailures: 3, directSpacedFailures: 3 },
    });
  });

  it("ignores attempts outside the trailing window and does not count non-qualifying failures", () => {
    const direct = [
      attempt(NOW - 25 * HOUR),
      attempt(NOW - 23 * HOUR),
      attempt(NOW - 12 * HOUR, { category: "network_error" }),
      attempt(NOW - HOUR),
    ];

    expect(decideCandidate(confirmedEvidence({ direct }), POLICY, NOW)).toMatchObject({
      status: "pending",
      reasons: ["insufficient-direct-failures"],
      evidence: { directQualifyingFailures: 2, directSpacedFailures: 2 },
    });
  });

  it("uses the maximum deterministically spaced DIRECT subset regardless of input order", () => {
    const direct = [
      attempt(NOW - HOUR),
      attempt(NOW - 5 * HOUR),
      attempt(NOW - 3 * HOUR),
      attempt(NOW - 4 * HOUR),
    ];
    const decision = decideCandidate(confirmedEvidence({ direct }), POLICY, NOW);
    const reversed = decideCandidate(
      confirmedEvidence({ direct: [...direct].reverse() }),
      POLICY,
      NOW,
    );

    expect(decision).toMatchObject({
      status: "confirmed",
      evidence: { directQualifyingFailures: 4, directSpacedFailures: 3 },
    });
    expect(reversed).toEqual(decision);
  });

  it("keeps a candidate pending when failures exist but are not sufficiently spaced", () => {
    const direct = [attempt(NOW - 5 * HOUR), attempt(NOW - 4 * HOUR), attempt(NOW - 3 * HOUR)];

    expect(decideCandidate(confirmedEvidence({ direct }), POLICY, NOW)).toMatchObject({
      status: "pending",
      reasons: ["direct-failures-not-spaced"],
      evidence: { directQualifyingFailures: 3, directSpacedFailures: 2 },
    });
  });

  it("includes the exact 24-hour boundary and accepts exact 120-minute spacing", () => {
    const direct = [attempt(NOW - 24 * HOUR), attempt(NOW - 22 * HOUR), attempt(NOW - 20 * HOUR)];

    expect(decideCandidate(confirmedEvidence({ direct }), POLICY, NOW)).toMatchObject({
      status: "confirmed",
      windowStart: NOW - 24 * HOUR,
      evidence: { directQualifyingFailures: 3, directSpacedFailures: 3 },
    });
  });

  it("requires distinct DIRECT addresses when resolver alternatives were available", () => {
    const sameAddress = confirmedEvidence({
      direct: [23, 12, 1].map((hoursAgo) =>
        attempt(NOW - hoursAgo * HOUR, { availableAddressCount: 2 }),
      ),
    });
    const diverse = confirmedEvidence({
      direct: [
        attempt(NOW - 23 * HOUR, {
          resolvedAddress: "1.1.1.1",
          availableAddressCount: 2,
        }),
        attempt(NOW - 12 * HOUR, {
          resolvedAddress: "8.8.8.8",
          availableAddressCount: 2,
        }),
        attempt(NOW - HOUR, { resolvedAddress: "1.1.1.1", availableAddressCount: 2 }),
      ],
    });

    expect(decideCandidate(sameAddress, POLICY, NOW)).toMatchObject({
      status: "pending",
      reasons: ["direct-address-diversity-missing"],
    });
    expect(decideCandidate(diverse, POLICY, NOW)).toMatchObject({
      status: "confirmed",
      evidence: {
        directAddressDiversityRequired: true,
        directAddressDiversitySatisfied: true,
      },
    });
  });

  it("finds a diverse spaced subset when the earliest greedy subset has only one address", () => {
    const direct = [
      attempt(NOW - 6 * HOUR, { resolvedAddress: "1.1.1.1", availableAddressCount: 2 }),
      attempt(NOW - 5 * HOUR, { resolvedAddress: "8.8.8.8", availableAddressCount: 2 }),
      attempt(NOW - 4 * HOUR, { resolvedAddress: "1.1.1.1", availableAddressCount: 2 }),
      attempt(NOW - 3 * HOUR, { resolvedAddress: "1.1.1.1", availableAddressCount: 2 }),
      attempt(NOW - 2 * HOUR, { resolvedAddress: "1.1.1.1", availableAddressCount: 2 }),
      attempt(NOW - HOUR, { resolvedAddress: "1.1.1.1", availableAddressCount: 2 }),
    ];
    const forward = decideCandidate(confirmedEvidence({ direct }), POLICY, NOW);
    const reversed = decideCandidate(
      confirmedEvidence({ direct: [...direct].reverse() }),
      POLICY,
      NOW,
    );

    expect(forward).toMatchObject({
      status: "confirmed",
      evidence: {
        directSpacedFailures: 3,
        directAddressDiversitySatisfied: true,
      },
    });
    expect(reversed).toEqual(forward);
  });

  it.each([
    "connect_timeout",
    "tls_timeout",
    "tls_handshake_reset",
    "connection_reset_before_http",
    "dns_failure",
  ] as const)("blocks confirmation when PROXY has a qualifying %s", (category) => {
    const proxy = [
      http(NOW - 12 * HOUR),
      http(NOW - HOUR),
      attempt(NOW - 2 * HOUR, {
        category,
        resolvedAddress: category === "dns_failure" ? null : "1.1.1.1",
        availableAddressCount: category === "dns_failure" ? 0 : 1,
      }),
    ];

    expect(decideCandidate(confirmedEvidence({ proxy }), POLICY, NOW)).toMatchObject({
      status: "blocked",
      reasons: ["proxy-unstable"],
      evidence: { proxyHttpSuccesses: 2, proxyTransportFailures: 1 },
    });
  });

  it("fails closed when PROXY evidence has an infrastructure or ambiguous failure", () => {
    const proxy = [
      http(NOW - 12 * HOUR),
      http(NOW - HOUR),
      attempt(NOW - 2 * HOUR, { category: "route_proof_failure" }),
    ];

    expect(decideCandidate(confirmedEvidence({ proxy }), POLICY, NOW)).toMatchObject({
      status: "blocked",
      reasons: ["proxy-evidence-uncertain"],
      evidence: { proxyUncertainFailures: 1 },
    });
  });

  it("persists independent blockers for observer health, count, coverage, and scope", () => {
    const evidence = confirmedEvidence();
    const decision = decideCandidate(
      {
        ...evidence,
        observationHealthy: false,
        connectionCount: 2,
        selectedScope: "exact",
        coverage: {
          status: "incomplete",
          match: null,
          incompleteSourceIds: ["provider:opaque"],
        },
      },
      POLICY,
      NOW,
    );

    expect(decision).toMatchObject({
      status: "blocked",
      reasons: [
        "observer-unhealthy",
        "insufficient-observations",
        "invalid-scope",
        "coverage-incomplete",
      ],
    });
  });

  it("blocks excluded and already-covered candidates even with otherwise sufficient evidence", () => {
    const excluded = deriveDomainCandidate("api.telemetry.example", FILTER_POLICY, "exact");
    if (!excluded) throw new Error("excluded fixture is invalid");
    const covered: CoverageResult = {
      status: "covered",
      match: {
        kind: "suffix",
        rule: "telemetry.example",
        sourceKind: "custom",
        sourceId: "custom",
      },
      incompleteSourceIds: [],
    };

    expect(
      decideCandidate(
        confirmedEvidence({
          fqdn: excluded.fqdn,
          selectedScope: excluded.selectedScope,
          proposedRule: excluded.proposedRule,
          coverage: covered,
        }),
        POLICY,
        NOW,
      ),
    ).toMatchObject({
      status: "blocked",
      reasons: ["candidate-excluded", "already-covered"],
    });
  });

  it("rejects policy values that weaken the hard safety thresholds", () => {
    const weakened: DecisionPolicy = {
      ...POLICY,
      directAttemptsRequired: 2,
      minimumAttemptSpacingMinutes: 60,
      validationWindowHours: 48,
      minimumProxySuccesses: 1,
      maximumProxyTransportFailures: 1,
    };

    expect(decideCandidate(confirmedEvidence(), weakened, NOW)).toMatchObject({
      status: "blocked",
      reasons: ["invalid-policy"],
    });
  });

  it("fails closed on inconsistent or future attempt facts", () => {
    const invalid = http(NOW + 1, 200);
    invalid.transportSuccess = false;

    expect(decideCandidate(confirmedEvidence({ proxy: [invalid] }), POLICY, NOW)).toMatchObject({
      status: "blocked",
      reasons: ["invalid-evidence"],
    });
  });

  it.each([
    attempt(NOW - HOUR, { httpStatus: 200 }),
    attempt(NOW - HOUR, {
      category: "dns_failure",
      resolvedAddress: "1.1.1.1",
      availableAddressCount: 1,
    }),
    attempt(NOW - HOUR, { resolvedAddress: "10.0.0.1" }),
    { ...http(NOW - HOUR, 200), resolvedAddress: null, availableAddressCount: 0 },
  ])("fails closed on malformed threshold-bearing attempt %#", (malformed) => {
    expect(decideCandidate(confirmedEvidence({ direct: [malformed] }), POLICY, NOW)).toMatchObject({
      status: "blocked",
      reasons: ["invalid-evidence"],
    });
  });

  it("canonicalizes equivalent IPv6 addresses before evaluating diversity", () => {
    const direct = [
      attempt(NOW - 23 * HOUR, {
        resolvedAddress: "2606:4700:4700::1111",
        availableAddressCount: 2,
      }),
      attempt(NOW - 12 * HOUR, {
        resolvedAddress: "2606:4700:4700:0:0:0:0:1111",
        availableAddressCount: 2,
      }),
      attempt(NOW - HOUR, {
        resolvedAddress: "2606:4700:4700::1111",
        availableAddressCount: 2,
      }),
    ];

    expect(decideCandidate(confirmedEvidence({ direct }), POLICY, NOW)).toMatchObject({
      status: "pending",
      reasons: ["direct-address-diversity-missing"],
    });
  });

  it("fails closed when an immutable attempt identity is duplicated", () => {
    const success = http(NOW - HOUR);

    expect(
      decideCandidate(confirmedEvidence({ proxy: [success, { ...success }] }), POLICY, NOW),
    ).toMatchObject({ status: "blocked", reasons: ["invalid-evidence"] });
  });

  it("rederives protected scope from the current filter policy", () => {
    const stale = deriveDomainCandidate(
      "api.googleapis.com",
      { ...FILTER_POLICY, nonWidenableSuffixes: [] },
      "site",
    );
    if (!stale) throw new Error("stale candidate fixture is invalid");

    expect(
      decideCandidate(
        confirmedEvidence({
          fqdn: stale.fqdn,
          filterPolicy: {
            ...FILTER_POLICY,
            nonWidenableSuffixes: ["googleapis.com"],
          },
          selectedScope: stale.selectedScope,
          proposedRule: stale.proposedRule,
        }),
        POLICY,
        NOW,
      ),
    ).toMatchObject({ status: "blocked", reasons: ["invalid-scope"] });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    "returns a serializable fail-closed result for invalid trusted time %s",
    (evaluatedAt) => {
      expect(decideCandidate(confirmedEvidence(), POLICY, evaluatedAt)).toMatchObject({
        status: "blocked",
        reasons: ["invalid-evidence"],
        windowStart: null,
      });
    },
  );

  it("rejects persisted attempts that are future-dated relative to the trusted clock", () => {
    const future = http(NOW + HOUR);
    expect(decideCandidate(confirmedEvidence({ proxy: [future] }), POLICY, NOW)).toMatchObject({
      status: "blocked",
      reasons: ["invalid-evidence"],
    });
  });
});
