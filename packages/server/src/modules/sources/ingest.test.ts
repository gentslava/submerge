import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSubscription, ingestHapp, ingestSource } from "./ingest.js";

const text = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init });
afterEach(() => vi.unstubAllGlobals());

describe("fetchSubscription", () => {
  it("fetches and parses a clash-yaml subscription", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        text("proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n"),
      ),
    );
    const { proxies } = await fetchSubscription("https://ex.com/sub", false);
    expect(proxies[0]?.name).toBe("A");
  });

  it("parses subscription metadata from the response headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        text("proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n", {
          headers: {
            "profile-title": `base64:${Buffer.from("Opengate VPN", "utf8").toString("base64")}`,
            "subscription-userinfo": "upload=100; download=900; total=2000; expire=1834000000",
            "profile-update-interval": "6",
          },
        }),
      ),
    );
    const { info } = await fetchSubscription("https://ex.com/sub", false);
    expect(info.title).toBe("Opengate VPN");
    expect(info.used).toBe(1000);
    expect(info.total).toBe(2000);
    expect(info.expire).toBe(1834000000);
    expect(info.updateHours).toBe(6);
  });

  it("adds X-Hwid + X-Device-Os only when useHwid is true", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return text("proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n");
      }),
    );
    await fetchSubscription("https://ex.com/sub", false, "HW");
    await fetchSubscription("https://ex.com/sub", true, "HW");
    expect(seen[0]?.get("user-agent")).toBe("clash.meta");
    expect(seen[0]?.get("x-hwid")).toBeNull();
    expect(seen[1]?.get("x-hwid")).toBe("HW");
    expect(seen[1]?.get("x-device-os")).toBe("Android");
  });

  it("throws on a non-ok subscription response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => text("nope", { status: 503 })),
    );
    await expect(fetchSubscription("https://ex.com/sub", false)).rejects.toThrow(/HTTP 503/);
  });

  it("throws when the subscription has no nodes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => text("garbage with no nodes")),
    );
    await expect(fetchSubscription("https://ex.com/sub", false)).rejects.toThrow(/no nodes/i);
  });
});

describe("ingestSource", () => {
  it("ingests a single vless node", async () => {
    const res = await ingestSource("vless://u@ex.com:443?security=tls#NL", false);
    expect(res.kind).toBe("vless");
    expect(res.label).toBe("NL");
    expect(res.proxies).toHaveLength(1);
  });

  it("ingests a subscription url with the label set to the url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        text("proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n"),
      ),
    );
    const res = await ingestSource("https://ex.com/sub", false);
    expect(res.kind).toBe("sub");
    expect(res.label).toBe("https://ex.com/sub");
    expect(res.proxies).toHaveLength(1);
  });

  it("ingests inline pasted subscription text (no url)", async () => {
    const list = Buffer.from("vless://u@ex.com:443#A", "utf8").toString("base64");
    const res = await ingestSource(list, false);
    expect(res.kind).toBe("sub");
    expect(res.label).toBe("inline subscription");
    expect(res.proxies[0]?.name).toBe("A");
  });

  it("ingests happ:// via the decoder, deriving nodes from the decoded body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(
            JSON.stringify({
              ok: true,
              url: "https://ex.com/s",
              body: "proxies:\n  - {name: H, type: vless, server: ex.com, port: 443, uuid: u}\n",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const res = await ingestSource("happ://crypt5/abc", true, "HW");
    expect(res.kind).toBe("happ");
    expect(res.label).toContain("happ →");
    expect(res.proxies[0]?.name).toBe("H");
  });
});

describe("ingestHapp", () => {
  // Distinguish the two fetch targets by URL: /decode → happ-decoder (returns
  // decoder JSON), any other URL → the secondary subscription fetch.
  const stubFetch = (decoder: unknown, sub?: () => Response) =>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/decode"))
          return new Response(JSON.stringify(decoder), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (sub) return sub();
        throw new Error("unexpected secondary fetch");
      }),
    );

  it("falls back to the decoded url when the body is empty", async () => {
    stubFetch({ ok: true, url: "https://ex.com/s", body: "" }, () =>
      text("proxies:\n  - {name: F, type: vless, server: ex.com, port: 443, uuid: u}\n"),
    );
    const res = await ingestHapp("happ://crypt5/abc", true, "HW");
    expect(res.via).toBe("https://ex.com/s");
    expect(res.proxies[0]?.name).toBe("F");
  });

  it("throws an expired diagnostic when the decoded body has node markers but zero nodes", async () => {
    // "proxies: []" carries the proxies: marker (→ looksDecoded) yet parses to []; no url ⇒ no fallback.
    stubFetch({ ok: true, body: "proxies: []" });
    await expect(ingestHapp("happ://crypt5/abc", false)).rejects.toThrow(/expired/);
  });

  it("throws a format-not-recognized diagnostic for unrecognizable content", async () => {
    stubFetch({ ok: true, body: "totally-unrecognized-content" });
    await expect(ingestHapp("happ://crypt5/abc", false)).rejects.toThrow(/not recognized/);
  });

  it("swallows the fallback fetch error and rejects with a happ diagnostic", async () => {
    stubFetch({ ok: true, url: "https://ex.com/s", body: "" }, () => text("nope", { status: 503 }));
    await expect(ingestHapp("happ://crypt5/abc", false)).rejects.toThrow(/not recognized/);
    // The raw HTTP 503 from the fallback must not leak out.
    await expect(ingestHapp("happ://crypt5/abc", false)).rejects.not.toThrow(/HTTP 503/);
  });
});
