import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeAllConnections,
  closeConnection,
  getConnections,
  getDelay,
  getProxies,
  getTotals,
  openLogStream,
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

afterEach(() => {
  vi.unstubAllGlobals();
  setMihomoSecret("");
});

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
