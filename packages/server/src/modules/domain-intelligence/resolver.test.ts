import { describe, expect, it } from "vitest";
import { canonicalPublicIpAddress, isPublicIpAddress, resolvePublicAddresses } from "./resolver.js";

describe("isPublicIpAddress", () => {
  it("returns one canonical identity for equivalent public IPv6 addresses", () => {
    expect(canonicalPublicIpAddress("2606:4700:4700:0:0:0:0:1111")).toBe("2606:4700:4700::1111");
    expect(canonicalPublicIpAddress("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
    expect(canonicalPublicIpAddress("10.0.0.1")).toBeNull();
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "192.0.0.9",
    "192.0.0.10",
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2001:1::1",
    "2001:3::1",
    "2001:4:112::1",
    "2001:20::1",
    "2001:30::1",
  ])("accepts a globally routable address: %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.2.1",
    "192.88.99.2",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001:2::1",
    "2001:1::4",
    "2001:5::1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff00::1",
    "5f00::1",
  ])("rejects a non-global address before connect: %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["", "example.com", "999.1.1.1", "fe80::1%eth0"])(
    "rejects a non-IP value: %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(false);
    },
  );
});

function dnsResponse(type: 1 | 28, addresses: string[], status = 0): Response {
  return Response.json({
    Status: status,
    Answer: addresses.map((data) => ({ name: "api.service.example.", type, TTL: 60, data })),
  });
}

describe("resolvePublicAddresses", () => {
  it("requires resolver quorum and returns only opaque resolver identities", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      const resolver = url.hostname === "one.example" ? "one" : "two";
      return url.searchParams.get("type") === "A"
        ? dnsResponse(1, [resolver === "one" ? "8.8.8.8" : "1.1.1.1"])
        : dnsResponse(28, []);
    };

    await expect(
      resolvePublicAddresses(
        "api.service.example",
        ["https://one.example/dns-query", "https://two.example/dns-query"],
        { quorum: 2, fetchImpl },
      ),
    ).resolves.toEqual({
      status: "resolved",
      quorumRequired: 2,
      quorumReached: 2,
      addresses: [
        { address: "1.1.1.1", family: 4, resolverIds: ["resolver-2"] },
        { address: "8.8.8.8", family: 4, resolverIds: ["resolver-1"] },
      ],
      outcomes: [
        {
          resolverId: "resolver-1",
          status: "resolved",
          publicAddressCount: 1,
          rejectedAnswerCount: 0,
        },
        {
          resolverId: "resolver-2",
          status: "resolved",
          publicAddressCount: 1,
          rejectedAnswerCount: 0,
        },
      ],
    });
  });

  it("returns a deterministic quorum failure without leaking partial addresses", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.hostname === "broken.example") return new Response(null, { status: 503 });
      return url.searchParams.get("type") === "A"
        ? dnsResponse(1, ["8.8.4.4"])
        : dnsResponse(28, []);
    };

    await expect(
      resolvePublicAddresses(
        "api.service.example",
        ["https://broken.example/dns-query", "https://healthy.example/dns-query"],
        { quorum: 2, fetchImpl },
      ),
    ).resolves.toEqual({
      status: "quorum-failed",
      quorumRequired: 2,
      quorumReached: 1,
      addresses: [],
      outcomes: [
        {
          resolverId: "resolver-1",
          status: "failed",
          publicAddressCount: 0,
          rejectedAnswerCount: 0,
        },
        {
          resolverId: "resolver-2",
          status: "resolved",
          publicAddressCount: 1,
          rejectedAnswerCount: 0,
        },
      ],
    });
  });

  it("drops unsafe answers before returning connectable addresses", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const type = new URL(String(input)).searchParams.get("type");
      return type === "A"
        ? dnsResponse(1, ["192.168.1.100", "8.8.8.8", "203.0.113.10"])
        : dnsResponse(28, ["::1", "2606:4700:4700::1111"]);
    };

    await expect(
      resolvePublicAddresses("api.service.example", ["https://resolver.example/dns-query"], {
        quorum: 1,
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: "resolved",
      quorumRequired: 1,
      quorumReached: 1,
      addresses: [
        { address: "2606:4700:4700::1111", family: 6, resolverIds: ["resolver-1"] },
        { address: "8.8.8.8", family: 4, resolverIds: ["resolver-1"] },
      ],
      outcomes: [
        {
          resolverId: "resolver-1",
          status: "resolved",
          publicAddressCount: 2,
          rejectedAnswerCount: 3,
        },
      ],
    });
  });

  it("does not count a resolver with only non-global answers toward quorum", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> =>
      new URL(String(input)).searchParams.get("type") === "A"
        ? dnsResponse(1, ["127.0.0.1"])
        : dnsResponse(28, ["2001:db8::1"]);

    await expect(
      resolvePublicAddresses("api.service.example", ["https://resolver.example/dns-query"], {
        quorum: 1,
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      status: "quorum-failed",
      quorumReached: 0,
      addresses: [],
      outcomes: [{ status: "unsafe", rejectedAnswerCount: 2 }],
    });
  });

  it.each([
    ["NXDOMAIN", () => dnsResponse(1, [], 3), "negative"],
    ["SERVFAIL", () => dnsResponse(1, [], 2), "failed"],
    ["FORMERR", () => dnsResponse(1, [], 1), "failed"],
    ["REFUSED", () => dnsResponse(1, [], 5), "failed"],
    ["invalid JSON", () => new Response("not-json"), "failed"],
    ["invalid schema", () => Response.json({ Status: "0", Answer: [] }), "failed"],
  ] as const)("classifies %s responses", async (_name, response, status) => {
    const result = await resolvePublicAddresses(
      "api.service.example",
      ["https://resolver.example/dns-query"],
      { quorum: 1, fetchImpl: async () => response() },
    );

    expect(result).toMatchObject({
      status: "quorum-failed",
      outcomes: [{ status }],
    });
  });

  it("aggregates agreement without letting duplicate endpoints manufacture quorum", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> =>
      new URL(String(input)).searchParams.get("type") === "A"
        ? dnsResponse(1, ["8.8.8.8"])
        : dnsResponse(28, []);

    await expect(
      resolvePublicAddresses(
        "api.service.example",
        ["https://one.example/dns-query", "https://two.example/dns-query"],
        { quorum: 2, fetchImpl },
      ),
    ).resolves.toMatchObject({
      addresses: [{ address: "8.8.8.8", resolverIds: ["resolver-1", "resolver-2"] }],
    });

    for (const duplicateResolvers of [
      ["https://one.example/dns-query", "https://one.example/dns-query"],
      ["https://one.example/dns-query", "https://one.example./dns-query"],
      ["https://one.example/dns-query?a=1&b=2", "https://one.example/other-resource?b=2&a=1"],
    ]) {
      await expect(
        resolvePublicAddresses("api.service.example", duplicateResolvers, {
          quorum: 2,
          fetchImpl,
        }),
      ).rejects.toThrow("resolver quorum exceeds valid unique resolvers");
    }
  });

  it("rejects invalid resolver configuration before issuing a request", async () => {
    let calls = 0;
    await expect(
      resolvePublicAddresses(
        "api.service.example",
        ["http://resolver.example/dns-query", "https://user:secret@resolver.example/dns-query"],
        {
          quorum: 1,
          fetchImpl: async () => {
            calls += 1;
            return dnsResponse(1, ["8.8.8.8"]);
          },
        },
      ),
    ).rejects.toThrow("resolver quorum exceeds valid unique resolvers");
    expect(calls).toBe(0);
  });

  it.each([
    "https://127.0.0.1/dns-query",
    "https://10.0.0.1/dns-query",
    "https://[::1]/dns-query",
    "https://[fe80::1]/dns-query",
    "https://localhost/dns-query",
    "https://resolver.local/dns-query",
  ])("rejects a definitely non-external resolver endpoint: %s", async (endpoint) => {
    let calls = 0;
    await expect(
      resolvePublicAddresses("api.service.example", [endpoint], {
        quorum: 1,
        fetchImpl: async () => {
          calls += 1;
          return dnsResponse(1, ["8.8.8.8"]);
        },
      }),
    ).rejects.toThrow("resolver quorum exceeds valid unique resolvers");
    expect(calls).toBe(0);
  });

  it("disables fetch redirects and always supplies an internal deadline signal", async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      inits.push(init ?? {});
      return dnsResponse(1, []);
    };

    await resolvePublicAddresses("api.service.example", ["https://resolver.example/dns-query"], {
      quorum: 1,
      fetchImpl,
    });

    expect(inits).toHaveLength(2);
    expect(inits.every((init) => init.redirect === "error")).toBe(true);
    expect(inits.every((init) => init.signal instanceof AbortSignal)).toBe(true);
  });

  it("turns the internal resolver deadline into a quorum failure", async () => {
    const result = await resolvePublicAddresses(
      "api.service.example",
      ["https://resolver.example/dns-query"],
      {
        quorum: 1,
        timeoutMs: 5,
        fetchImpl: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
    );

    expect(result).toMatchObject({
      status: "quorum-failed",
      quorumReached: 0,
      outcomes: [{ status: "failed" }],
    });
  });

  it("caps resolver concurrency before issuing requests", async () => {
    let calls = 0;
    const resolvers = Array.from(
      { length: 5 },
      (_, index) => `https://resolver-${index}.example/dns-query`,
    );

    await expect(
      resolvePublicAddresses("api.service.example", resolvers, {
        quorum: 1,
        fetchImpl: async () => {
          calls += 1;
          return dnsResponse(1, ["8.8.8.8"]);
        },
      }),
    ).rejects.toThrow("too many external resolvers");
    expect(calls).toBe(0);
  });

  it("cancels non-OK resolver bodies", async () => {
    let cancellations = 0;
    const failedResponse = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancellations += 1;
          },
        }),
        { status: 503 },
      );

    await resolvePublicAddresses("api.service.example", ["https://resolver.example/dns-query"], {
      quorum: 1,
      fetchImpl: async () => failedResponse(),
    });
    expect(cancellations).toBe(2);
  });

  it("canonicalizes equivalent IPv6 answers before aggregating diversity", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.searchParams.get("type") === "A") return dnsResponse(1, []);
      return dnsResponse(28, [
        url.hostname === "one.example" ? "2606:4700:4700::1111" : "2606:4700:4700:0:0:0:0:1111",
      ]);
    };

    await expect(
      resolvePublicAddresses(
        "api.service.example",
        ["https://one.example/dns-query", "https://two.example/dns-query"],
        { quorum: 2, fetchImpl },
      ),
    ).resolves.toMatchObject({
      addresses: [
        {
          address: "2606:4700:4700::1111",
          resolverIds: ["resolver-1", "resolver-2"],
        },
      ],
    });
  });

  it("propagates cancellation instead of recording it as DNS failure", async () => {
    const controller = new AbortController();
    const reason = new Error("stop resolver");
    controller.abort(reason);

    await expect(
      resolvePublicAddresses("api.service.example", ["https://resolver.example/dns-query"], {
        quorum: 1,
        signal: controller.signal,
        fetchImpl: async (_input, init) => {
          throw init?.signal?.reason ?? new Error("missing abort");
        },
      }),
    ).rejects.toBe(reason);
  });

  it("cancels an oversized DNS body while streaming instead of buffering the remainder", async () => {
    let cancellations = 0;
    const oversizedResponse = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65_537));
          },
          cancel() {
            cancellations += 1;
          },
        }),
      );

    await expect(
      resolvePublicAddresses("api.service.example", ["https://resolver.example/dns-query"], {
        quorum: 1,
        fetchImpl: async () => oversizedResponse(),
      }),
    ).resolves.toMatchObject({
      status: "quorum-failed",
      outcomes: [{ status: "failed" }],
    });
    expect(cancellations).toBe(2);
  });
});
