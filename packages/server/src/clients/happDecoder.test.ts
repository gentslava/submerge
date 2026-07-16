import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHapp, healthHapp } from "./happDecoder.js";

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
  vi.restoreAllMocks();
});

describe("happDecoder client", () => {
  it("checks /health with GET and parses only {ok:true}", async () => {
    const caller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    mockFetch((url, init) => {
      expect(url).toMatch(/\/health$/);
      expect(init?.method ?? "GET").toBe("GET");
      seenSignal = init?.signal ?? undefined;
      return json({ ok: true, ignored: "field" });
    });

    await expect(healthHapp(caller.signal)).resolves.toEqual({ ok: true });
    expect(seenSignal).not.toBe(caller.signal);
    caller.abort();
    expect(seenSignal?.aborted).toBe(true);
  });

  it.each([
    ["ok:false", json({ ok: false })],
    ["malformed JSON", new Response("not-json", { status: 200 })],
    ["HTTP 500", json({ ok: true }, { status: 500 })],
  ])("rejects an invalid health response: %s", async (_name, response) => {
    mockFetch(() => response);
    await expect(healthHapp()).rejects.toThrow(/happ-decoder/i);
  });

  it("propagates caller abort during a health check", async () => {
    const controller = new AbortController();
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const pending = healthHapp(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the autonomous health timeout when no caller signal is supplied", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      mockFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

      const pending = healthHapp();
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      timeout.abort(new DOMException("deadline", "TimeoutError"));
      await expect(pending).rejects.toThrow(/happ-decoder health check/i);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects an unreachable health sidecar", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(healthHapp()).rejects.toThrow(/happ-decoder/i);
  });

  it("posts {link,hwid} and parses ok response", async () => {
    let sentBody: unknown;
    mockFetch((url, init) => {
      expect(url).toContain("/decode");
      sentBody = JSON.parse(String(init?.body));
      return json({ ok: true, url: "https://ex.com/s", body: "proxies:\n  - {}" });
    });
    const res = await decodeHapp("happ://crypt5/abc", true);
    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://ex.com/s");
    expect(sentBody).toEqual({ link: "happ://crypt5/abc", hwid: true });
  });

  it("throws when the decoder reports ok:false", async () => {
    mockFetch(() => json({ ok: false, error: "expired" }));
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/expired/);
  });

  it("throws a clear error when the decoder is unreachable", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/happ-decoder/);
  });

  it("throws a clear error when the response body is not JSON", async () => {
    mockFetch(() => new Response("not json", { status: 200 }));
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/happ-decoder/);
  });

  it("falls back to an HTTP-status message when ok:false has no error", async () => {
    mockFetch(() => json({ ok: false }, { status: 200 }));
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/HTTP 200/);
  });

  it("trims the link before sending", async () => {
    let sentBody: unknown;
    mockFetch((_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return json({ ok: true });
    });
    await decodeHapp("  happ://crypt5/abc  ", false);
    expect((sentBody as { link: string }).link).toBe("happ://crypt5/abc");
  });
});
