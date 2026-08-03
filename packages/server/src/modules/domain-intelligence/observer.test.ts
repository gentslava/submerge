import { describe, expect, it } from "vitest";
import type { MihomoConnection, MihomoLogFrame } from "../../clients/mihomo.js";
import {
  canReconcileObservations,
  fingerprintObservation,
  normalizeObservedFqdn,
  observationFromConnection,
  observationFromLogFrame,
} from "./observer.js";

function frame(overrides: Partial<MihomoLogFrame> = {}): MihomoLogFrame {
  return {
    level: "info",
    message:
      "[TCP] 192.168.1.40:53120 --> example.com:443 match DomainSuffix(example) using DIRECT",
    fields: { host: "example.com", network: "tcp" },
    ...overrides,
  };
}

function connection(overrides: Partial<MihomoConnection> = {}): MihomoConnection {
  return {
    id: "opaque-connection-id",
    metadata: {
      network: "tcp",
      host: "example.com",
      destinationIP: "203.0.113.10",
      destinationPort: "443",
      sourceIP: "192.0.2.10",
      process: "",
    },
    upload: 0,
    download: 0,
    start: "2026-08-03T08:15:01.000Z",
    chains: [],
    ...overrides,
  };
}

describe("domain observation normalization", () => {
  it("normalizes case, one trailing dot, and IDNA to ASCII", () => {
    expect(normalizeObservedFqdn("  BÜCHER.Example.  ")).toBe("xn--bcher-kva.example");
  });

  it.each([
    "",
    "localhost",
    "printer.lan",
    "service.local",
    "router.home.arpa",
    "1.0.0.127.in-addr.arpa",
    "b.a.ip6.arpa",
    "192.0.2.1",
    "127.1",
    "01.01.01.01",
    "0x7f.0.0.1",
    "[2001:db8::1]",
    "bad_label.example",
    "double-dot..example",
    "trailing-two.example..",
    "example.com/path",
    "example.com?query=value",
    "example.com#fragment",
    "%65xample.com",
    "foo%2ebar.com",
    "foo\\bar.com",
    "exam\nple.com",
  ])("rejects an invalid or local domain observation: %s", (value) => {
    expect(normalizeObservedFqdn(value)).toBeNull();
  });
});

describe("Mihomo observation adapter", () => {
  it("prefers structured host and network fields", () => {
    const observed = observationFromLogFrame(
      frame({
        message: "[UDP] 192.168.1.40:53120 --> 198.18.0.1:443 match Match using DIRECT",
        fields: { host: "Api.Service.Example.", network: "UDP" },
      }),
      1_722_500_101_000,
    );

    expect(observed).toEqual({
      fqdn: "api.service.example",
      observedAt: 1_722_500_101_000,
      transport: "udp",
      source: "mihomo-log",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    [
      "[TCP] 192.168.1.40:53120 --> docs.product.example:443 match DomainSuffix(example) using DIRECT",
      "tcp",
    ],
    [
      "[UDP] 198.18.0.1:53947 --> docs.product.example:443 doesn't match any rule using DIRECT",
      "udp",
    ],
    ["[TCP] 192.168.1.40 → docs.product.example:443 via nl-ams-01", "tcp"],
  ] as const)("parses a supported routing message: %s", (message, transport) => {
    const observed = observationFromLogFrame(frame({ message, fields: {} }), 1_722_500_101_000);
    expect(observed).toMatchObject({
      fqdn: "docs.product.example",
      transport,
      source: "mihomo-log",
    });
  });

  it.each([
    frame({ message: "ordinary informational message", fields: {} }),
    frame({
      message: "DNS lookup completed",
      fields: { host: "example.com", network: "udp" },
    }),
    frame({ message: "[TCP] malformed route", fields: {} }),
    frame({ message: "connected", fields: { host: "example.com" } }),
    frame({ fields: { host: "192.0.2.1", network: "tcp" } }),
    frame({ message: "connected", fields: { host: "example.com", network: "icmp" } }),
    frame({ fields: { host: "example.com", network: "udp" } }),
    frame({
      level: "warning",
      fields: { host: "example.com", network: "tcp" },
    }),
    frame({
      message: "[TCP] 192.168.1.40:53120 --> 192.0.2.1:443 match Match using DIRECT",
      fields: {},
    }),
  ])("ignores an unrelated or invalid log frame", (input) => {
    expect(observationFromLogFrame(input, 1_722_500_101_000)).toBeNull();
  });

  it("uses a valid connection start time for stable snapshot fingerprints", () => {
    const input = connection();
    const first = observationFromConnection(input, Date.parse("2026-08-03T08:20:00.000Z"));
    const second = observationFromConnection(input, Date.parse("2026-08-03T09:20:00.000Z"));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      fqdn: "example.com",
      observedAt: Date.parse("2026-08-03T08:15:01.000Z"),
      transport: "tcp",
      source: "connection-snapshot",
    });
    expect(JSON.stringify(first)).not.toContain(input.id);
  });

  it("falls back to the snapshot time when the connection start is invalid", () => {
    const observed = observationFromConnection(connection({ start: "not-a-date" }), 123_456);
    expect(observed?.observedAt).toBe(123_456);
  });

  it("falls back to the snapshot time when the connection start is in the future", () => {
    const observed = observationFromConnection(
      connection({ start: "2026-08-03T08:16:00.000Z" }),
      Date.parse("2026-08-03T08:15:00.000Z"),
    );
    expect(observed?.observedAt).toBe(Date.parse("2026-08-03T08:15:00.000Z"));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects an invalid observation timestamp: %s",
    (observedAt) => {
      expect(observationFromLogFrame(frame(), observedAt)).toBeNull();
      expect(observationFromConnection(connection(), observedAt)).toBeNull();
      expect(() => fingerprintObservation("example.com", "tcp", observedAt)).toThrow(RangeError);
    },
  );

  it("does not expose connection identity or client metadata", () => {
    const input = connection({
      id: "private-connection-id",
      metadata: {
        network: "tcp",
        host: "example.com",
        destinationIP: "private-destination-ip",
        destinationPort: "private-destination-port",
        sourceIP: "private-source-ip",
        process: "private-process",
      },
      chains: ["private-chain"],
    });

    const serialized = JSON.stringify(observationFromConnection(input, 1_722_500_101_000));
    for (const privateValue of [
      input.id,
      input.metadata.destinationIP,
      input.metadata.destinationPort,
      input.metadata.sourceIP,
      input.metadata.process,
      input.chains[0],
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("uses the same canonical fingerprint for log and snapshot sources", () => {
    const observedAt = Date.parse("2026-08-03T08:15:01.000Z");
    const fromLog = observationFromLogFrame(frame(), observedAt);
    const fromSnapshot = observationFromConnection(connection(), observedAt + 10_000);

    expect(fromLog?.fingerprint).toBe(fromSnapshot?.fingerprint);
    expect(fromLog?.fingerprint).toBe(fingerprintObservation("example.com", "tcp", observedAt));
  });

  it("reconciles cross-source observations split by an adjacent bucket boundary", () => {
    const fromSnapshot = observationFromConnection(
      connection({ start: new Date(29_999).toISOString() }),
      31_000,
    );
    const fromLog = observationFromLogFrame(frame(), 30_001);

    expect(fromLog?.fingerprint).not.toBe(fromSnapshot?.fingerprint);
    expect(fromLog && fromSnapshot && canReconcileObservations(fromLog, fromSnapshot)).toBe(true);
  });

  it("does not reconcile same-source or temporally distant observations", () => {
    const first = observationFromLogFrame(frame(), 30_001);
    const sameSource = observationFromLogFrame(frame(), 30_002);
    const distantSnapshot = observationFromConnection(
      connection({ start: new Date(90_001).toISOString() }),
      91_000,
    );

    expect(first && sameSource && canReconcileObservations(first, sameSource)).toBe(false);
    expect(first && distantSnapshot && canReconcileObservations(first, distantSnapshot)).toBe(
      false,
    );
  });
});
