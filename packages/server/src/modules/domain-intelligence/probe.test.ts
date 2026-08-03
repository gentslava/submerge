import type { LookupOneOptions } from "node:dns";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type PinnedHopRequest,
  type PinnedHopResult,
  type PinnedRequestFactory,
  probeDirectHttps,
  requestPinnedHttps,
} from "./probe.js";
import type { PublicResolutionResult } from "./resolver.js";

function resolved(address: string, rejectedAnswerCount = 0): PublicResolutionResult {
  const family = address.includes(":") ? 6 : 4;
  return {
    status: "resolved",
    quorumRequired: 1,
    quorumReached: 1,
    addresses: [{ address, family, resolverIds: ["resolver-1"] }],
    outcomes: [
      {
        resolverId: "resolver-1",
        status: "resolved",
        publicAddressCount: 1,
        rejectedAnswerCount,
      },
    ],
  };
}

function hopResponse(statusCode: number, location: string | null = null): PinnedHopResult {
  return {
    kind: "response",
    statusCode,
    location,
    locationRejected: false,
    connectDurationMs: 3,
    tlsDurationMs: 5,
    totalDurationMs: 11,
  };
}

describe("requestPinnedHttps", () => {
  it("pins the TCP lookup while preserving the original SNI and Host", async () => {
    let captured: RequestOptions | undefined;
    const requestImpl: PinnedRequestFactory = (options, onResponse) => {
      captured = options;
      const request = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(): void;
      };
      request.destroy = (error) => {
        if (error) queueMicrotask(() => request.emit("error", error));
      };
      request.end = () => {
        queueMicrotask(() => {
          const socket = new EventEmitter();
          request.emit("socket", socket);
          socket.emit("connect");
          socket.emit("secureConnect");
          const response = new PassThrough() as PassThrough & {
            headers: IncomingMessage["headers"];
            statusCode: number;
          };
          response.headers = {};
          response.statusCode = 403;
          onResponse(response as IncomingMessage);
        });
      };
      return request as unknown as ClientRequest;
    };

    await expect(
      requestPinnedHttps(
        {
          target: new URL("https://api.service.example/private?transient=1"),
          address: "8.8.8.8",
          family: 4,
          connectTimeoutMs: 100,
          totalTimeoutMs: 200,
        },
        requestImpl,
      ),
    ).resolves.toMatchObject({ kind: "response", statusCode: 403, locationRejected: false });

    expect(captured).toMatchObject({
      protocol: "https:",
      hostname: "api.service.example",
      servername: "api.service.example",
      method: "GET",
      path: "/private?transient=1",
      agent: false,
      rejectUnauthorized: true,
      headers: {
        Host: "api.service.example",
        Accept: "*/*",
        Connection: "close",
      },
    });
    expect(captured?.headers).not.toHaveProperty("Authorization");
    expect(captured?.headers).not.toHaveProperty("Cookie");

    const lookup = captured?.lookup as typeof import("node:dns")["lookup"] | undefined;
    expect(lookup).toBeTypeOf("function");
    await new Promise<void>((resolveLookup, rejectLookup) => {
      lookup?.("api.service.example", {} as LookupOneOptions, (error, address, family) => {
        if (error) return rejectLookup(error);
        expect(address).toBe("8.8.8.8");
        expect(family).toBe(4);
        resolveLookup();
      });
    });
  });

  it("classifies a timeout after TCP connect as a TLS timeout", async () => {
    const requestImpl: PinnedRequestFactory = (_options, _onResponse) => {
      const request = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(): void;
      };
      request.destroy = (error) => {
        if (error) queueMicrotask(() => request.emit("error", error));
      };
      request.end = () => {
        queueMicrotask(() => {
          const socket = new EventEmitter();
          request.emit("socket", socket);
          socket.emit("connect");
        });
      };
      return request as unknown as ClientRequest;
    };

    await expect(
      requestPinnedHttps(
        {
          target: new URL("https://api.service.example/"),
          address: "8.8.8.8",
          family: 4,
          connectTimeoutMs: 5,
          totalTimeoutMs: 50,
        },
        requestImpl,
      ),
    ).resolves.toMatchObject({ kind: "failure", category: "tls_timeout" });
  });

  it("classifies a reset after TLS but before headers as a connection reset", async () => {
    const requestImpl: PinnedRequestFactory = (_options, _onResponse) => {
      const request = new EventEmitter() as EventEmitter & {
        destroy(error?: Error): void;
        end(): void;
      };
      request.destroy = () => {};
      request.end = () => {
        queueMicrotask(() => {
          const socket = new EventEmitter();
          request.emit("socket", socket);
          socket.emit("connect");
          socket.emit("secureConnect");
          request.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
        });
      };
      return request as unknown as ClientRequest;
    };

    await expect(
      requestPinnedHttps(
        {
          target: new URL("https://api.service.example/"),
          address: "8.8.8.8",
          family: 4,
          connectTimeoutMs: 50,
          totalTimeoutMs: 100,
        },
        requestImpl,
      ),
    ).resolves.toMatchObject({
      kind: "failure",
      category: "connection_reset_before_http",
    });
  });

  it("cannot miss cancellation that happens while the request is created", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    let ended = false;
    let destroyed = false;
    const requestImpl: PinnedRequestFactory = () => {
      const request = new EventEmitter() as EventEmitter & {
        destroy(): void;
        end(): void;
      };
      request.destroy = () => {
        destroyed = true;
      };
      request.end = () => {
        ended = true;
      };
      controller.abort(reason);
      return request as unknown as ClientRequest;
    };

    await expect(
      requestPinnedHttps(
        {
          target: new URL("https://api.service.example/"),
          address: "8.8.8.8",
          family: 4,
          connectTimeoutMs: 50,
          totalTimeoutMs: 100,
          signal: controller.signal,
        },
        requestImpl,
      ),
    ).rejects.toBe(reason);
    expect(ended).toBe(false);
    expect(destroyed).toBe(true);
  });
});

describe("probeDirectHttps", () => {
  it("resolves and pins every redirect independently without persisting its URL", async () => {
    const resolvedHosts: string[] = [];
    const requests: PinnedHopRequest[] = [];
    const times = [0, 22];
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      resolveImpl: async (fqdn) => {
        resolvedHosts.push(fqdn);
        return fqdn === "api.service.example" ? resolved("8.8.8.8") : resolved("1.1.1.1");
      },
      requestPinnedImpl: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? hopResponse(302, "https://next.example/path?secret=discarded#fragment")
          : hopResponse(404);
      },
      nowImpl: () => times.shift() ?? 22,
    });

    expect(resolvedHosts).toEqual(["api.service.example", "next.example"]);
    expect(requests.map(({ target, address }) => [target.hostname, address])).toEqual([
      ["api.service.example", "8.8.8.8"],
      ["next.example", "1.1.1.1"],
    ]);
    expect(result).toEqual({
      direction: "direct",
      category: "http_response",
      transportSuccess: true,
      httpStatus: 404,
      resolvedAddress: "1.1.1.1",
      connectDurationMs: 6,
      tlsDurationMs: 10,
      totalDurationMs: 22,
      redirectCount: 1,
      finalOrigin: "https://next.example",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("/path");
  });

  it("rejects non-HTTPS and credentialed redirects before resolving or connecting", async () => {
    for (const location of [
      "http://public.example/",
      "https://user:password@public.example/",
      "https://127.0.0.1/",
    ]) {
      let resolutions = 0;
      let requests = 0;
      const result = await probeDirectHttps("api.service.example", {
        resolverUrls: ["https://resolver.example/dns-query"],
        resolverQuorum: 1,
        resolveImpl: async () => {
          resolutions += 1;
          return resolved("8.8.8.8");
        },
        requestPinnedImpl: async () => {
          requests += 1;
          return hopResponse(302, location);
        },
      });

      expect(result).toMatchObject({
        category: "unsafe_redirect",
        transportSuccess: false,
        redirectCount: 0,
      });
      expect(resolutions).toBe(1);
      expect(requests).toBe(1);
    }
  });

  it("blocks a hop when DNS returned any non-global address", async () => {
    let requests = 0;
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      resolveImpl: async () => resolved("8.8.8.8", 1),
      requestPinnedImpl: async () => {
        requests += 1;
        return hopResponse(200);
      },
    });

    expect(result).toMatchObject({
      category: "unsafe_address",
      transportSuccess: false,
      resolvedAddress: null,
    });
    expect(requests).toBe(0);
  });

  it("classifies unsafe DNS answers before a failed quorum", async () => {
    let requests = 0;
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 2,
      resolveImpl: async () => ({
        status: "quorum-failed",
        quorumRequired: 2,
        quorumReached: 0,
        addresses: [],
        outcomes: [
          {
            resolverId: "resolver-1",
            status: "unsafe",
            publicAddressCount: 0,
            rejectedAnswerCount: 2,
          },
          {
            resolverId: "resolver-2",
            status: "failed",
            publicAddressCount: 0,
            rejectedAnswerCount: 0,
          },
        ],
      }),
      requestPinnedImpl: async () => {
        requests += 1;
        return hopResponse(200);
      },
    });

    expect(result).toMatchObject({ category: "unsafe_address", transportSuccess: false });
    expect(requests).toBe(0);
  });

  it("skips IPv6 until egress is verified and rotates usable addresses by attempt", async () => {
    const addresses: PublicResolutionResult = {
      ...resolved("8.8.8.8"),
      addresses: [
        {
          address: "2606:4700:4700::1111",
          family: 6,
          resolverIds: ["resolver-1"],
        },
        { address: "8.8.8.8", family: 4, resolverIds: ["resolver-1"] },
        { address: "1.1.1.1", family: 4, resolverIds: ["resolver-2"] },
      ],
    };
    const selected: string[] = [];
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      addressSelectionIndex: 1,
      resolveImpl: async () => addresses,
      requestPinnedImpl: async (request) => {
        selected.push(request.address);
        return hopResponse(200);
      },
    });

    expect(selected).toEqual(["1.1.1.1"]);
    expect(result).toMatchObject({ category: "http_response", resolvedAddress: "1.1.1.1" });

    const ipv6Only = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      resolveImpl: async () => resolved("2606:4700:4700::1111"),
      requestPinnedImpl: async () => hopResponse(200),
    });
    expect(ipv6Only).toMatchObject({
      category: "ipv6_unavailable",
      transportSuccess: false,
      resolvedAddress: null,
    });
  });

  it("rejects an oversized redirect header instead of treating it as success", async () => {
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      resolveImpl: async () => resolved("8.8.8.8"),
      requestPinnedImpl: async () => ({
        ...hopResponse(302),
        locationRejected: true,
      }),
    });

    expect(result).toMatchObject({
      category: "unsafe_redirect",
      transportSuccess: false,
      httpStatus: 302,
    });
  });

  it("bounds the complete attempt while external resolution is pending", async () => {
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      connectTimeoutMs: 2,
      totalTimeoutMs: 5,
      resolveImpl: async (_fqdn, _resolvers, options) =>
        await new Promise<PublicResolutionResult>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
      requestPinnedImpl: async () => hopResponse(200),
    });

    expect(result).toMatchObject({
      category: "total_timeout",
      transportSuccess: false,
      resolvedAddress: null,
    });
  });

  it.each([401, 403, 404, 429])("treats HTTP %s as transport success", async (statusCode) => {
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      resolveImpl: async () => resolved("8.8.8.8"),
      requestPinnedImpl: async () => hopResponse(statusCode),
    });

    expect(result).toMatchObject({
      category: "http_response",
      transportSuccess: true,
      httpStatus: statusCode,
    });
  });
});
