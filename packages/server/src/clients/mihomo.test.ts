import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
const destroyAgentMock = vi.hoisted(() => vi.fn(async () => undefined));
const proxyAgentMock = vi.hoisted(() =>
  vi.fn(function MockProxyAgent() {
    return { destroy: destroyAgentMock };
  }),
);

vi.mock("undici", () => ({
  ProxyAgent: proxyAgentMock,
  request: requestMock,
}));

import {
  closeAllConnections,
  closeConnection,
  getConnections,
  getDelay,
  getExternalIpTrace,
  getProxies,
  getRuntimeConfig,
  getTotals,
  getVersion,
  openLogStream,
  probeThroughProxy,
  reloadConfig,
  selectProxy,
  setMihomoSecret,
  streamTraffic,
} from "./mihomo.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(handler));
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

beforeEach(() => {
  requestMock.mockReset();
  destroyAgentMock.mockReset();
  destroyAgentMock.mockResolvedValue(undefined);
  proxyAgentMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setMihomoSecret("");
});

function proxyBody(chunks: string[], dump = vi.fn(async () => undefined)) {
  const encoder = new TextEncoder();
  return {
    dump,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield encoder.encode(chunk);
    },
  };
}

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("mihomo client", () => {
  it("parses /version and sends controller auth", async () => {
    setMihomoSecret("diagnostic-secret");
    mockFetch((url, init) => {
      expect(url).toMatch(/\/version$/);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer diagnostic-secret");
      return json({ version: "v1.19.12", meta: true });
    });

    await expect(getVersion()).resolves.toEqual({ version: "v1.19.12" });

    mockFetch(() => json({ version: 11912 }));
    await expect(getVersion()).rejects.toThrow();
  });

  it("parses nullable runtime config fields without inventing defaults", async () => {
    mockFetch(() =>
      json({ mode: "rule", dns: { enable: true }, ipv6: false, tun: { enable: false } }),
    );
    await expect(getRuntimeConfig()).resolves.toEqual({
      mode: "rule",
      dns: true,
      ipv6: false,
      tun: false,
    });

    mockFetch(() => json({}));
    await expect(getRuntimeConfig()).resolves.toEqual({
      mode: null,
      dns: null,
      ipv6: null,
      tun: null,
    });

    mockFetch(() => json({ dns: { enable: "yes" } }));
    await expect(getRuntimeConfig()).rejects.toThrow();
  });

  it("parses /proxies and sends the auth header", async () => {
    let seenAuth = "";
    mockFetch((url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      expect(url).toContain("/proxies");
      return json({
        proxies: { PROXY: { name: "PROXY", type: "Selector", now: "A", all: ["A"], history: [] } },
      });
    });
    const res = await getProxies();
    expect(res.proxies.PROXY?.now).toBe("A");
    expect(seenAuth).toMatch(/^Bearer/);
  });

  it("parses a delay response", async () => {
    mockFetch(() => json({ delay: 123 }));
    expect(await getDelay("A")).toEqual({ delay: 123 });
  });

  it("passes bounded delay options and composes a caller abort signal", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    mockFetch((url, init) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toContain("/proxies/A%2FB/delay");
      expect(parsed.searchParams.get("url")).toBe("https://example.com/control?a=1");
      expect(parsed.searchParams.get("timeout")).toBe("4321");
      expect(parsed.searchParams.get("expected")).toBe("200-399");
      seenSignal = init?.signal ?? undefined;
      return json({ delay: 42 });
    });

    await getDelay("A/B", "https://example.com/control?a=1", {
      timeoutMs: 4321,
      expected: "200-399",
      signal: controller.signal,
    });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(controller.signal);
    controller.abort();
    expect(seenSignal?.aborted).toBe(true);
  });

  it("reads a bounded Cloudflare trace only through the configured proxy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("direct fetch forbidden"))),
    );
    requestMock.mockResolvedValue({
      statusCode: 200,
      body: proxyBody(["fl=1\nip=185.107.56.42\nloc=NL\n", "colo=AMS\nunknown=value\n"]),
    });

    await expect(getExternalIpTrace()).resolves.toEqual({
      ip: "185.107.56.42",
      country: "NL",
      colo: "AMS",
    });
    expect(proxyAgentMock).toHaveBeenCalledWith(expect.stringMatching(/^http/));
    const [url, options] = requestMock.mock.calls[0] as [
      string | URL,
      { dispatcher: unknown; signal: AbortSignal },
    ];
    expect(String(url)).toBe("https://www.cloudflare.com/cdn-cgi/trace");
    expect(options.dispatcher).toBeTruthy();
    expect(options.signal.aborted).toBe(false);
    expect(destroyAgentMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing IP", "loc=NL\ncolo=AMS\n"],
    ["invalid IP", "ip=999.1.1.1\nloc=NL\n"],
    ["oversized body", `ip=185.107.56.42\nextra=${"x".repeat(9000)}`],
  ])("rejects a %s trace and still destroys the proxy agent", async (_name, body) => {
    requestMock.mockResolvedValue({ statusCode: 200, body: proxyBody([body]) });
    await expect(getExternalIpTrace()).rejects.toThrow();
    expect(destroyAgentMock).toHaveBeenCalledOnce();
  });

  it("returns any routed HTTP status, drains the body, and destroys the proxy agent", async () => {
    const dump = vi.fn(async () => undefined);
    requestMock.mockResolvedValue({ statusCode: 403, body: proxyBody([], dump) });

    await expect(probeThroughProxy("https://chatgpt.com/favicon.ico")).resolves.toEqual({
      status: 403,
    });
    expect(dump).toHaveBeenCalledOnce();
    const [dumpOptions] = dump.mock.calls[0] as [{ limit: number; signal: AbortSignal }];
    expect(dumpOptions.limit).toBe(8192);
    expect(dumpOptions.signal.aborted).toBe(false);
    expect(destroyAgentMock).toHaveBeenCalledOnce();
  });

  it("follows at most three redirects within one bounded probe and returns the final status", async () => {
    const dumps = Array.from({ length: 4 }, () => vi.fn(async () => undefined));
    requestMock
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: "/step-1" },
        body: proxyBody([], dumps[0]),
      })
      .mockResolvedValueOnce({
        statusCode: 301,
        headers: { location: "https://example.com/step-2" },
        body: proxyBody([], dumps[1]),
      })
      .mockResolvedValueOnce({
        statusCode: 307,
        headers: { location: "/step-3" },
        body: proxyBody([], dumps[2]),
      })
      .mockResolvedValueOnce({
        statusCode: 204,
        headers: {},
        body: proxyBody([], dumps[3]),
      });

    await expect(probeThroughProxy("https://example.com/start")).resolves.toEqual({ status: 204 });
    expect(requestMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://example.com/start",
      "https://example.com/step-1",
      "https://example.com/step-2",
      "https://example.com/step-3",
    ]);
    expect(dumps.every((dump) => dump.mock.calls.length === 1)).toBe(true);
    expect(destroyAgentMock).toHaveBeenCalledTimes(4);
  });

  it("stops after three redirects and reports the remaining redirect status", async () => {
    requestMock.mockResolvedValue({
      statusCode: 302,
      headers: { location: "/again" },
      body: proxyBody([]),
    });

    await expect(probeThroughProxy("https://example.com/start")).resolves.toEqual({ status: 302 });
    expect(requestMock).toHaveBeenCalledTimes(4);
    expect(destroyAgentMock).toHaveBeenCalledTimes(4);
  });

  it("propagates a caller abort to a routed probe and destroys the proxy agent", async () => {
    const controller = new AbortController();
    requestMock.mockImplementation(
      (_url, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );

    const pending = probeThroughProxy("https://example.com", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(destroyAgentMock).toHaveBeenCalledOnce();
  });

  it("uses the autonomous request timeout when no caller signal is supplied", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      requestMock.mockImplementation(
        (_url, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), {
              once: true,
            });
          }),
      );

      const pending = probeThroughProxy("https://example.com");
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      timeout.abort(new DOMException("deadline", "TimeoutError"));
      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      expect(destroyAgentMock).toHaveBeenCalledOnce();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects a negative delay response", async () => {
    mockFetch(() => json({ delay: -1 }));
    await expect(getDelay("A")).rejects.toThrow();
  });

  it("maps /connections totals to { up, down } and ignores the rest", async () => {
    mockFetch((url) => {
      expect(url).toContain("/connections");
      return json({ downloadTotal: 8400, uploadTotal: 1200, connections: [{ id: "x" }] });
    });
    expect(await getTotals()).toEqual({ up: 1200, down: 8400 });
  });

  it("parses the /connections array (defaults for missing fields)", async () => {
    mockFetch((url) => {
      expect(url).toContain("/connections");
      return json({
        downloadTotal: 10,
        uploadTotal: 5,
        connections: [
          {
            id: "c1",
            metadata: { network: "tcp", host: "youtube.com", sourceIP: "192.168.1.9" },
            upload: 100,
            download: 200,
            start: "2026-07-06T20:00:00Z",
            chains: ["nl-ams-01", "AUTO"],
          },
        ],
      });
    });
    const conns = await getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0]?.id).toBe("c1");
    expect(conns[0]?.chains[0]).toBe("nl-ams-01");
    expect(conns[0]?.metadata.process).toBe(""); // defaulted
  });

  it("normalizes an idle /connections null list to an empty snapshot", async () => {
    mockFetch((url) => {
      expect(url).toContain("/connections");
      return json({ downloadTotal: 0, uploadTotal: 0, connections: null });
    });
    await expect(getConnections()).resolves.toEqual([]);
  });

  it("closes a connection via DELETE and tolerates a 404", async () => {
    let method = "";
    let path = "";
    mockFetch((url, init) => {
      method = init?.method ?? "";
      path = url;
      return new Response(null, { status: 204 });
    });
    await closeConnection("c1");
    expect(method).toBe("DELETE");
    expect(path).toContain("/connections/c1");

    mockFetch(() => new Response(null, { status: 404 }));
    await expect(closeConnection("gone")).resolves.toBeUndefined();
  });

  it("closes all connections via DELETE /connections", async () => {
    let method = "";
    let path = "";
    mockFetch((url, init) => {
      method = init?.method ?? "";
      path = url;
      return new Response(null, { status: 204 });
    });
    await closeAllConnections();
    expect(method).toBe("DELETE");
    expect(path).toMatch(/\/connections$/);
  });

  it("throws on an error status", async () => {
    mockFetch(() => json({ message: "timeout" }, { status: 408 }));
    await expect(getDelay("A")).rejects.toThrow();
  });

  it("selects a proxy via PUT", async () => {
    let method = "";
    let body = "";
    mockFetch((_url, init) => {
      method = init?.method ?? "";
      body = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    });
    await selectProxy("PROXY", "A");
    expect(method).toBe("PUT");
    expect(JSON.parse(body)).toEqual({ name: "A" });
  });

  it("reloads the config via PUT /configs", async () => {
    let body = "";
    mockFetch((url, init) => {
      expect(url).toContain("/configs");
      body = String(init?.body ?? "");
      return new Response(null, { status: 204 });
    });
    await reloadConfig("/root/.config/mihomo/config.yaml");
    expect(JSON.parse(body)).toEqual({ path: "/root/.config/mihomo/config.yaml" });
  });

  it("throws when mihomo returns 500 on proxies", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    await expect(getProxies()).rejects.toThrow(/mihomo/i);
  });

  it("skips malformed NDJSON lines instead of killing the stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('{"up":1,"down":2}\nnot-json\n{"up":"oops"}\n{"up":3,"down":4}\n'));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const samples: Array<{ up: number; down: number }> = [];
    for await (const s of streamTraffic(new AbortController().signal)) samples.push(s);
    expect(samples).toEqual([
      { up: 1, down: 2 },
      { up: 3, down: 4 },
    ]);
  });

  it("throws after a run of consecutive unparseable frames (schema drift guard)", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        // 30+ consecutive wrong-shape frames = schema drift, not line noise
        for (let i = 0; i < 31; i++) c.enqueue(enc.encode('{"upload":1,"download":2}\n'));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const drain = async () => {
      for await (const _ of streamTraffic(new AbortController().signal)) {
        /* no samples expected */
      }
    };
    await expect(drain()).rejects.toThrow(/unparseable/i);
  });

  it("streams and parses NDJSON traffic samples", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('{"up":10,"down":20}\n{"up":5,'));
        c.enqueue(enc.encode('"down":7}\n'));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const samples: Array<{ up: number; down: number }> = [];
    for await (const s of streamTraffic(new AbortController().signal)) samples.push(s);
    expect(samples).toEqual([
      { up: 10, down: 20 },
      { up: 5, down: 7 },
    ]);
  });

  describe("structured log stream", () => {
    it("opens the info structured endpoint with the current secret and reconstructs split frames", async () => {
      setMihomoSecret("rotated-secret");
      mockFetch((url, init) => {
        expect(url).toMatch(/\/logs\?level=info&format=structured$/);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rotated-secret");
        return ndjsonResponse([
          '{"time":"15:33:24","level":"info","message":"connected","fields":[',
          '{"key":"host","value":"example.com"},{"key":"port","value":443},',
          '{"key":"authorization","value":"Bearer should-not-leak"},',
          '{"key":"nested","value":{"secret":true}}]}\n',
        ]);
      });

      const stream = await openLogStream(new AbortController().signal);
      const frames = [];
      for await (const frame of stream) frames.push(frame);

      expect(frames).toEqual([
        {
          level: "info",
          message: "connected",
          fields: { host: "example.com", port: 443 },
        },
      ]);
      expect(JSON.stringify(frames)).not.toContain("should-not-leak");
      expect(JSON.stringify(frames)).not.toContain("secret");
    });

    it.each(["warn", "warning"])("normalizes mihomo %s to warning", async (level) => {
      mockFetch(() =>
        ndjsonResponse([
          `${JSON.stringify({ time: "15:33:20", level, message: "slow", fields: [] })}\n`,
        ]),
      );
      const stream = await openLogStream(new AbortController().signal);
      const frames = [];
      for await (const frame of stream) frames.push(frame);
      expect(frames).toEqual([{ level: "warning", message: "slow", fields: {} }]);
    });

    it("redacts credentials and secret-bearing links from browser-visible messages", async () => {
      mockFetch(() =>
        ndjsonResponse([
          `${JSON.stringify({
            time: "15:33:20",
            level: "warning",
            message:
              "provider https://user:pass@example.com/sub/token?key=value Authorization=Bearer abc.def.ghi Proxy-Authorization: Basic dXNlcjpwYXNz secret=raw-secret vless://uuid@example.com:443#node",
            fields: [],
          })}\n`,
        ]),
      );
      const stream = await openLogStream(new AbortController().signal);
      const frames = [];
      for await (const frame of stream) frames.push(frame);

      const serialized = JSON.stringify(frames);
      expect(serialized).toContain("provider https://example.com/…");
      expect(serialized).not.toContain("user:pass");
      expect(serialized).not.toContain("/sub/token");
      expect(serialized).not.toContain("key=value");
      expect(serialized).not.toContain("abc.def.ghi");
      expect(serialized).not.toContain("dXNlcjpwYXNz");
      expect(serialized).not.toContain("raw-secret");
      expect(serialized).not.toContain("uuid@example.com");
    });

    it("keeps ordinary routing messages readable", async () => {
      const message = "[TCP] 192.168.1.40 → discord.com:443 via nl-ams-01";
      mockFetch(() =>
        ndjsonResponse([
          `${JSON.stringify({ time: "15:33:20", level: "info", message, fields: [] })}\n`,
        ]),
      );
      const stream = await openLogStream(new AbortController().signal);
      const frames = [];
      for await (const frame of stream) frames.push(frame);
      expect(frames[0]?.message).toBe(message);
    });

    it("skips isolated malformed structured frames", async () => {
      mockFetch(() =>
        ndjsonResponse([
          "not-json\n",
          '{"time":"15:33:21","level":"fatal","message":"wrong level","fields":[]}\n',
          '{"time":"15:33:22","level":"error","message":"timeout","fields":[]}\n',
        ]),
      );
      const stream = await openLogStream(new AbortController().signal);
      const frames = [];
      for await (const frame of stream) frames.push(frame);
      expect(frames).toEqual([{ level: "error", message: "timeout", fields: {} }]);
    });

    it("throws after 30 consecutive malformed structured frames", async () => {
      mockFetch(() => ndjsonResponse(Array.from({ length: 30 }, () => '{"level":"info"}\n')));
      const stream = await openLogStream(new AbortController().signal);
      const drain = async () => {
        for await (const _ of stream) {
          /* no valid frames expected */
        }
      };
      await expect(drain()).rejects.toThrow(/30 consecutive unparseable frames/i);
    });

    it.each([
      ["HTTP failure", new Response("boom", { status: 503 }), /HTTP 503/],
      ["missing body", new Response(null, { status: 200 }), /readable body/i],
    ])("rejects %s before returning a generator", async (_name, response, message) => {
      mockFetch(() => response);
      await expect(openLogStream(new AbortController().signal)).rejects.toThrow(message);
    });

    it("rejects cleanly when aborted before response headers", async () => {
      const controller = new AbortController();
      mockFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

      const opening = openLogStream(controller.signal);
      controller.abort();
      await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    });

    it("ends cleanly when aborted while waiting for a frame", async () => {
      const controller = new AbortController();
      mockFetch(
        (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                init?.signal?.addEventListener(
                  "abort",
                  () => streamController.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
            { status: 200 },
          ),
      );

      const stream = await openLogStream(controller.signal);
      const next = stream.next();
      controller.abort();
      await expect(next).resolves.toEqual({ done: true, value: undefined });
    });

    it("ends cleanly when aborted between frames", async () => {
      const controller = new AbortController();
      const encoder = new TextEncoder();
      mockFetch(
        (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(
                  encoder.encode(
                    '{"time":"15:33:24","level":"info","message":"one","fields":[]}\n',
                  ),
                );
                init?.signal?.addEventListener(
                  "abort",
                  () => streamController.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
            { status: 200 },
          ),
      );

      const stream = await openLogStream(controller.signal);
      await expect(stream.next()).resolves.toEqual({
        done: false,
        value: { level: "info", message: "one", fields: {} },
      });
      controller.abort();
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    });
  });
});
