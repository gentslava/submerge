import type { LookupOneOptions } from "node:dns";
import { EventEmitter } from "node:events";
import type {
  ClientRequest,
  RequestOptions as HttpRequestOptions,
  IncomingMessage,
} from "node:http";
import {
  Agent as HttpsAgent,
  globalAgent as httpsGlobalAgent,
  type RequestOptions,
} from "node:https";
import { PassThrough } from "node:stream";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { errors as undiciErrors } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  buildValidationProxyAgentOptions,
  createProxyResolver,
  type PinnedHopRequest,
  type PinnedHopResult,
  type PinnedRequestFactory,
  probeDirectHttps,
  probeProxyHttps,
  requestPinnedHttps,
  requestPinnedProxyHttps,
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

describe("requestPinnedProxyHttps", () => {
  it("authenticates CONNECT to the pinned IP, proves its route, and preserves SNI and Host", async () => {
    let connectOptions: HttpRequestOptions | undefined;
    let tlsOptions: ConnectionOptions | undefined;
    let httpsOptions: RequestOptions | undefined;
    const events: string[] = [];
    const times = [0, 10, 50, 57, 70];
    const tunnelSocket = new EventEmitter() as EventEmitter & { destroy(): void };
    tunnelSocket.destroy = () => undefined;
    const secureSocket = new EventEmitter() as EventEmitter & { destroy(): void };
    secureSocket.destroy = () => undefined;

    const result = await requestPinnedProxyHttps(
      {
        target: new URL("https://api.service.example/private?discard=1"),
        address: "8.8.8.8",
        family: 4,
        connectTimeoutMs: 100,
        totalTimeoutMs: 200,
        proxy: {
          endpoint: "http://mihomo:7891",
          username: "submerge-domain-validation",
          password: "a".repeat(43),
        },
        proveRoute: async ({ address, port }) => {
          events.push(`proof:${address}:${port}`);
        },
      },
      {
        nowImpl: () => times.shift() ?? 70,
        connectRequest: (options) => {
          connectOptions = options;
          const request = new EventEmitter() as EventEmitter & {
            destroy(): void;
            end(): void;
          };
          request.destroy = () => undefined;
          request.end = () => {
            queueMicrotask(() => {
              events.push("connect");
              request.emit("connect", { statusCode: 200 }, tunnelSocket, Buffer.alloc(0));
            });
          };
          return request as unknown as ClientRequest;
        },
        tlsConnect: (options) => {
          tlsOptions = options;
          events.push("tls");
          queueMicrotask(() => secureSocket.emit("secureConnect"));
          return secureSocket as unknown as TLSSocket;
        },
        httpsRequest: (options, onResponse) => {
          httpsOptions = options;
          const request = new EventEmitter() as EventEmitter & {
            destroy(): void;
            end(): void;
          };
          request.destroy = () => undefined;
          request.end = () => {
            queueMicrotask(() => {
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
        },
      },
    );

    expect(result).toMatchObject({
      kind: "response",
      statusCode: 403,
      connectDurationMs: 10,
      tlsDurationMs: 7,
      totalDurationMs: 70,
    });
    expect(connectOptions).toMatchObject({
      protocol: "http:",
      hostname: "mihomo",
      port: 7891,
      method: "CONNECT",
      path: "8.8.8.8:443",
      headers: {
        Host: "8.8.8.8:443",
        "Proxy-Authorization": `Basic ${Buffer.from(
          `submerge-domain-validation:${"a".repeat(43)}`,
        ).toString("base64")}`,
      },
    });
    expect(events).toEqual(["connect", "proof:8.8.8.8:443", "tls"]);
    expect(tlsOptions).toMatchObject({
      socket: tunnelSocket,
      servername: "api.service.example",
      rejectUnauthorized: true,
    });
    expect(httpsOptions).toMatchObject({
      hostname: "api.service.example",
      servername: "api.service.example",
      path: "/private?discard=1",
      headers: { Host: "api.service.example", Connection: "close" },
    });
    expect(httpsOptions).not.toHaveProperty("createConnection");
    expect(httpsOptions?.agent).toBeInstanceOf(HttpsAgent);
    expect(httpsOptions?.agent).not.toBe(httpsGlobalAgent);
    const pinnedAgent = httpsOptions?.agent as HttpsAgent;
    expect(pinnedAgent.keepAlive).toBe(false);
    expect(pinnedAgent.maxSockets).toBe(1);
    expect(pinnedAgent.createConnection({} as never, () => undefined)).toBe(secureSocket);
    expect(JSON.stringify(result)).not.toContain("submerge-domain-validation");
    expect(JSON.stringify(result)).not.toContain("discard");
  });

  it.each([403, 407])(
    "classifies proxy authentication HTTP %s without opening TLS",
    async (proxyStatus) => {
      let openedTls = false;
      const result = await requestPinnedProxyHttps(
        {
          target: new URL("https://api.service.example/"),
          address: "8.8.8.8",
          family: 4,
          connectTimeoutMs: 100,
          totalTimeoutMs: 200,
          proxy: {
            endpoint: "http://mihomo:7891",
            username: "submerge-domain-validation",
            password: "a".repeat(43),
          },
          proveRoute: async () => undefined,
        },
        {
          connectRequest: () => {
            const request = new EventEmitter() as EventEmitter & {
              destroy(): void;
              end(): void;
            };
            request.destroy = () => undefined;
            request.end = () =>
              queueMicrotask(() =>
                request.emit(
                  "connect",
                  { statusCode: proxyStatus },
                  new PassThrough(),
                  Buffer.alloc(0),
                ),
              );
            return request as unknown as ClientRequest;
          },
          tlsConnect: () => {
            openedTls = true;
            return new PassThrough() as TLSSocket;
          },
          httpsRequest: () => {
            throw new Error("HTTPS must not start after rejected proxy authentication");
          },
        },
      );

      expect(result).toMatchObject({ kind: "failure", category: "proxy_auth_failure" });
      expect(openedTls).toBe(false);
    },
  );

  it("fails closed when the open tunnel cannot prove its forced route", async () => {
    const result = await requestPinnedProxyHttps(
      {
        target: new URL("https://api.service.example/"),
        address: "8.8.8.8",
        family: 4,
        connectTimeoutMs: 100,
        totalTimeoutMs: 200,
        proxy: {
          endpoint: "http://mihomo:7891",
          username: "submerge-domain-validation",
          password: "a".repeat(43),
        },
        proveRoute: async () => {
          throw new Error("wrong route");
        },
      },
      {
        connectRequest: () => {
          const request = new EventEmitter() as EventEmitter & {
            destroy(): void;
            end(): void;
          };
          request.destroy = () => undefined;
          request.end = () =>
            queueMicrotask(() =>
              request.emit("connect", { statusCode: 200 }, new PassThrough(), Buffer.alloc(0)),
            );
          return request as unknown as ClientRequest;
        },
        tlsConnect: () => {
          throw new Error("TLS must not start before route proof");
        },
        httpsRequest: () => {
          throw new Error("HTTPS must not start before route proof");
        },
      },
    );

    expect(result).toMatchObject({ kind: "failure", category: "route_proof_failure" });
  });

  it("aborts pending route proof when its hop times out", async () => {
    let proofAborted = false;
    const result = await requestPinnedProxyHttps(
      {
        target: new URL("https://api.service.example/"),
        address: "8.8.8.8",
        family: 4,
        connectTimeoutMs: 5,
        totalTimeoutMs: 50,
        proxy: {
          endpoint: "http://mihomo:7891",
          username: "submerge-domain-validation",
          password: "a".repeat(43),
        },
        proveRoute: async ({ signal }) =>
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                proofAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
      {
        connectRequest: () => {
          const request = new EventEmitter() as EventEmitter & {
            destroy(): void;
            end(): void;
          };
          request.destroy = () => undefined;
          request.end = () =>
            queueMicrotask(() =>
              request.emit("connect", { statusCode: 200 }, new PassThrough(), Buffer.alloc(0)),
            );
          return request as unknown as ClientRequest;
        },
        tlsConnect: () => {
          throw new Error("TLS must not start while route proof is pending");
        },
      },
    );

    expect(result).toMatchObject({ kind: "failure", category: "route_proof_failure" });
    expect(proofAborted).toBe(true);
  });

  it("does not settle a timed-out hop before route-proof cleanup settles", async () => {
    let proofAborted = false;
    let releaseProof: (() => void) | undefined;
    let tlsStarted = false;
    const pending = requestPinnedProxyHttps(
      {
        target: new URL("https://api.service.example/"),
        address: "8.8.8.8",
        family: 4,
        connectTimeoutMs: 5,
        totalTimeoutMs: 50,
        proxy: {
          endpoint: "http://mihomo:7891",
          username: "submerge-domain-validation",
          password: "a".repeat(43),
        },
        proveRoute: ({ signal }) =>
          new Promise<void>((resolve) => {
            releaseProof = resolve;
            signal?.addEventListener(
              "abort",
              () => {
                proofAborted = true;
              },
              { once: true },
            );
          }),
      },
      {
        connectRequest: () => {
          const request = new EventEmitter() as EventEmitter & {
            destroy(): void;
            end(): void;
          };
          request.destroy = () => undefined;
          request.end = () =>
            queueMicrotask(() =>
              request.emit("connect", { statusCode: 200 }, new PassThrough(), Buffer.alloc(0)),
            );
          return request as unknown as ClientRequest;
        },
        tlsConnect: () => {
          tlsStarted = true;
          return new PassThrough() as TLSSocket;
        },
      },
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(proofAborted).toBe(true));
    expect(settled).toBe(false);
    expect(tlsStarted).toBe(false);

    releaseProof?.();
    await expect(pending).resolves.toMatchObject({
      kind: "failure",
      category: "route_proof_failure",
    });
    expect(tlsStarted).toBe(false);
  });

  it("cannot miss cancellation that happens while the CONNECT request is created", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    let ended = false;
    let destroyed = false;

    const pending = requestPinnedProxyHttps(
      {
        target: new URL("https://api.service.example/"),
        address: "8.8.8.8",
        family: 4,
        connectTimeoutMs: 100,
        totalTimeoutMs: 200,
        signal: controller.signal,
        proxy: {
          endpoint: "http://mihomo:7891",
          username: "submerge-domain-validation",
          password: "a".repeat(43),
        },
        proveRoute: async () => undefined,
      },
      {
        connectRequest: () => {
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
        },
      },
    );

    await expect(pending).rejects.toBe(reason);
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
      availableAddressCount: 1,
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

  it("distinguishes a common resolver outage from a destination DNS failure", async () => {
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
            status: "failed",
            publicAddressCount: 0,
            rejectedAnswerCount: 0,
          },
          {
            resolverId: "resolver-2",
            status: "failed",
            publicAddressCount: 0,
            rejectedAnswerCount: 0,
          },
        ],
      }),
      requestPinnedImpl: async () => hopResponse(200),
    });

    expect(result).toMatchObject({
      category: "infrastructure_error",
      transportSuccess: false,
    });
  });

  it.each(["resolved", "negative"] as const)(
    "treats mixed %s/failed resolver quorum as infrastructure failure",
    async (firstStatus) => {
      const result = await probeDirectHttps("api.service.example", {
        resolverUrls: ["https://resolver.example/dns-query"],
        resolverQuorum: 2,
        resolveImpl: async () => ({
          status: "quorum-failed",
          quorumRequired: 2,
          quorumReached: firstStatus === "resolved" ? 1 : 0,
          addresses:
            firstStatus === "resolved"
              ? [
                  {
                    address: "8.8.8.8",
                    family: 4 as const,
                    resolverIds: ["resolver-1"],
                  },
                ]
              : [],
          outcomes: [
            {
              resolverId: "resolver-1",
              status: firstStatus,
              publicAddressCount: firstStatus === "resolved" ? 1 : 0,
              rejectedAnswerCount: 0,
            },
            {
              resolverId: "resolver-2",
              status: "failed",
              publicAddressCount: 0,
              rejectedAnswerCount: 0,
            },
          ],
        }),
        requestPinnedImpl: async () => hopResponse(200),
      });

      expect(result).toMatchObject({
        category: "infrastructure_error",
        transportSuccess: false,
      });
    },
  );

  it("treats resolved/negative resolver disagreement as infrastructure failure", async () => {
    let requests = 0;
    const result = await probeDirectHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 2,
      resolveImpl: async () => ({
        status: "quorum-failed",
        quorumRequired: 2,
        quorumReached: 1,
        addresses: [
          {
            address: "8.8.8.8",
            family: 4,
            resolverIds: ["resolver-1"],
          },
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
            status: "negative",
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

    expect(result).toMatchObject({
      category: "infrastructure_error",
      transportSuccess: false,
    });
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
    expect(result).toMatchObject({
      category: "http_response",
      resolvedAddress: "1.1.1.1",
      availableAddressCount: 2,
    });

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
      availableAddressCount: 0,
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

describe("probeProxyHttps", () => {
  it("rejects a structurally valid endpoint outside the validated runtime topology", async () => {
    const proxyResolverFactory = vi.fn(() => ({
      fetchImpl: async () => new Response(),
      close: async () => undefined,
    }));

    await expect(
      probeProxyHttps("api.service.example", {
        resolverUrls: ["https://resolver.example/dns-query"],
        resolverQuorum: 1,
        proxy: {
          endpoint: "http://collector.example:7891",
          username: "submerge-domain-validation",
          password: "a".repeat(43),
        },
        proxyResolverFactory,
        prepareRouteProof: async () => async () => undefined,
      }),
    ).rejects.toThrow("invalid validation proxy configuration");
    expect(proxyResolverFactory).not.toHaveBeenCalled();
  });

  it("builds the production DNS proxy dispatcher with auth and forced tunneling", () => {
    expect(
      buildValidationProxyAgentOptions({
        endpoint: "http://mihomo:7891",
        username: "submerge-domain-validation",
        password: "a".repeat(43),
      }),
    ).toEqual({
      uri: "http://mihomo:7891/",
      token: `Basic ${Buffer.from(`submerge-domain-validation:${"a".repeat(43)}`).toString(
        "base64",
      )}`,
      proxyTunnel: true,
    });
  });

  it.each([403, 407])(
    "maps the production ProxyAgent %s shape to a safe typed failure",
    async (statusCode) => {
      const destroy = vi.fn(async () => undefined);
      const dispatcher = { destroy };
      const createDispatcher = vi.fn(() => dispatcher);
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: new undiciErrors.RequestAbortedError(
            `Proxy response (${statusCode}) !== 200 when HTTP Tunneling`,
          ),
        });
      });
      const auth = {
        endpoint: "http://mihomo:7891",
        username: "submerge-domain-validation",
        password: "a".repeat(43),
      };
      const resolver = createProxyResolver(auth, { createDispatcher, fetchImpl });

      await expect(
        resolver.fetchImpl(new URL("https://resolver.example/dns-query")),
      ).rejects.toThrow("fetch failed");
      expect(resolver.failureCategory?.()).toBe("proxy_auth_failure");
      expect(createDispatcher).toHaveBeenCalledWith(buildValidationProxyAgentOptions(auth));
      await resolver.close();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it("surfaces a DNS-path proxy auth rejection and never starts the target CONNECT", async () => {
    const requestPinnedImpl = vi.fn(async () => hopResponse(200));
    const result = await probeProxyHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      proxy: {
        endpoint: "http://mihomo:7891",
        username: "submerge-domain-validation",
        password: "a".repeat(43),
      },
      proxyResolverFactory: () => ({
        fetchImpl: async () => {
          throw new Error("safe mock rejection");
        },
        failureCategory: () => "proxy_auth_failure",
        close: async () => undefined,
      }),
      requestPinnedImpl,
      prepareRouteProof: async () => async () => undefined,
    });

    expect(result).toMatchObject({
      direction: "proxy",
      category: "proxy_auth_failure",
      transportSuccess: false,
    });
    expect(requestPinnedImpl).not.toHaveBeenCalled();
  });

  it("uses the forced listener for resolver traffic and safely re-proves every redirect", async () => {
    const resolverFetch = async () => new Response();
    const closeResolver = vi.fn(async () => undefined);
    const proof = vi.fn(async () => undefined);
    const prepareRouteProof = vi.fn(async () => proof);
    const requests: PinnedHopRequest[] = [];
    let resolutionCount = 0;

    const result = await probeProxyHttps("api.service.example", {
      resolverUrls: ["https://resolver.example/dns-query"],
      resolverQuorum: 1,
      proxy: {
        endpoint: "http://mihomo:7891",
        username: "submerge-domain-validation",
        password: "a".repeat(43),
      },
      proxyResolverFactory: (proxy) => {
        expect(proxy.endpoint).toBe("http://mihomo:7891/");
        return { fetchImpl: resolverFetch, close: closeResolver };
      },
      resolveImpl: async (fqdn, _resolvers, options) => {
        expect(options.fetchImpl).toBe(resolverFetch);
        resolutionCount += 1;
        return fqdn === "api.service.example" ? resolved("8.8.8.8") : resolved("1.1.1.1");
      },
      prepareRouteProof,
      requestPinnedImpl: async (request) => {
        requests.push(request);
        await request.proveRoute({ address: request.address, port: 443, signal: request.signal });
        return requests.length === 1
          ? hopResponse(302, "https://next.example/path?discarded=1")
          : hopResponse(429);
      },
    });

    expect(resolutionCount).toBe(2);
    expect(prepareRouteProof).toHaveBeenCalledTimes(2);
    expect(proof).toHaveBeenCalledTimes(2);
    expect(requests.map(({ target, address }) => [target.hostname, address])).toEqual([
      ["api.service.example", "8.8.8.8"],
      ["next.example", "1.1.1.1"],
    ]);
    expect(result).toMatchObject({
      direction: "proxy",
      category: "http_response",
      transportSuccess: true,
      httpStatus: 429,
      redirectCount: 1,
      finalOrigin: "https://next.example",
    });
    expect(closeResolver).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("discarded");
    expect(JSON.stringify(result)).not.toContain("a".repeat(43));
  });
});
