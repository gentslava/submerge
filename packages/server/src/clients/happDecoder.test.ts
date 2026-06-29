import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHapp } from "./happDecoder.js";

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
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        expect(url).toContain("/decode");
        sentBody = JSON.parse(String(init?.body));
        return json({ ok: true, url: "https://ex.com/s", body: "proxies:\n  - {}" });
      }),
    );
    const res = await decodeHapp("happ://crypt5/abc", true);
    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://ex.com/s");
    expect(sentBody).toEqual({ link: "happ://crypt5/abc", hwid: true });
  });

  it("throws when the decoder reports ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => json({ ok: false, error: "expired" })),
    );
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/expired/);
  });

  it("throws a clear error when the decoder is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    await expect(decodeHapp("happ://crypt5/abc", false)).rejects.toThrow(/happ-decoder/);
  });
});
