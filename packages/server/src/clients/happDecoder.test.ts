import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHapp } from "./happDecoder.js";

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

describe("happDecoder client", () => {
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
