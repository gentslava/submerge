import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSubscription, ingestSource } from "./ingest.js";

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
    const proxies = await fetchSubscription("https://ex.com/sub", false);
    expect(proxies[0]?.name).toBe("A");
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
    expect(res.label).toContain("happ");
    expect(res.proxies[0]?.name).toBe("H");
  });
});
