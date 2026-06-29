import { afterEach, describe, expect, it, vi } from "vitest";
import { getDelay, getProxies, reloadConfig, selectProxy, streamTraffic } from "./mihomo.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(handler));
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

afterEach(() => vi.unstubAllGlobals());

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
});
