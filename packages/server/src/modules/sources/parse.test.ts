import { describe, expect, it } from "vitest";
import { detectKind, extractSubUrl, parseProxiesFromText, parseVless } from "./parse.js";

describe("extractSubUrl", () => {
  it("returns a plain https url as-is", () => {
    expect(extractSubUrl("https://ex.com/sub")).toBe("https://ex.com/sub");
  });
  it("extracts ?url= from a client deep-link", () => {
    expect(extractSubUrl("clash://install-config?url=https%3A%2F%2Fex.com%2Fs")).toBe(
      "https://ex.com/s",
    );
  });
  it("extracts an embedded url from incy/happ-add style links", () => {
    expect(extractSubUrl("happ://add/https://ex.com/s")).toBe("https://ex.com/s");
  });
  it("returns null when there is no url", () => {
    expect(extractSubUrl("vless://uuid@host:443")).toBeNull();
  });
});

describe("detectKind", () => {
  it("detects vless", () => expect(detectKind("vless://u@h:443")).toBe("vless"));
  it("detects encrypted happ", () => expect(detectKind("happ://crypt5/abc")).toBe("happ"));
  it("detects a subscription url", () => expect(detectKind("https://ex.com/sub")).toBe("sub"));
  it("detects a client deep-link as sub", () =>
    expect(detectKind("clash://install-config?url=https%3A%2F%2Fex.com%2Fs")).toBe("sub"));
  it("throws on an empty string", () => expect(() => detectKind("")).toThrow());
  it("rejects non-vless single nodes", () =>
    expect(() => detectKind("trojan://x@h:443")).toThrow());
});

describe("parseVless", () => {
  it("parses a reality tcp node", () => {
    const p = parseVless(
      "vless://11111111-1111-1111-1111-111111111111@ex.com:443?security=reality&type=tcp&sni=deepl.com&pbk=KEY&sid=SID&flow=xtls-rprx-vision&fp=chrome#NL",
    );
    expect(p).toMatchObject({
      name: "NL",
      type: "vless",
      server: "ex.com",
      port: 443,
      uuid: "11111111-1111-1111-1111-111111111111",
      tls: true,
      servername: "deepl.com",
      flow: "xtls-rprx-vision",
      "client-fingerprint": "chrome",
    });
    expect((p as Record<string, unknown>)["reality-opts"]).toEqual({
      "public-key": "KEY",
      "short-id": "SID",
    });
  });
  it("parses a ws node with host header and default name", () => {
    const p = parseVless(
      "vless://uuid@ex.com:8443?security=tls&type=ws&host=cdn.ex.com&path=%2Fws",
    );
    expect(p.name).toBe("ex.com:8443");
    expect(p.network).toBe("ws");
    expect((p as Record<string, unknown>)["ws-opts"]).toEqual({
      path: "/ws",
      headers: { Host: "cdn.ex.com" },
    });
  });
  it("throws when the uuid is missing", () => {
    expect(() => parseVless("vless://@ex.com:443")).toThrow();
  });
});

describe("parseProxiesFromText", () => {
  it("parses clash/mihomo yaml", () => {
    const yaml = "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n";
    const out = parseProxiesFromText(yaml);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("A");
  });
  it("parses a v2ray/xray vnext outbound", () => {
    const json = JSON.stringify({
      remarks: "R",
      outbounds: [
        {
          protocol: "vless",
          settings: {
            vnext: [
              { address: "ex.com", port: 443, users: [{ id: "u", flow: "xtls-rprx-vision" }] },
            ],
          },
          streamSettings: {
            network: "tcp",
            security: "reality",
            realitySettings: { publicKey: "K", shortId: "S", serverName: "sni" },
          },
        },
      ],
    });
    const out = parseProxiesFromText(json);
    expect(out[0]).toMatchObject({ name: "R", server: "ex.com", port: 443, uuid: "u", tls: true });
  });
  it("parses a sing-box vless outbound", () => {
    const json = JSON.stringify({
      outbounds: [
        {
          type: "vless",
          tag: "SB",
          server: "ex.com",
          server_port: 443,
          uuid: "u",
          tls: { enabled: true, server_name: "sni" },
        },
      ],
    });
    const out = parseProxiesFromText(json);
    expect(out[0]).toMatchObject({
      name: "SB",
      server: "ex.com",
      port: 443,
      uuid: "u",
      tls: true,
      servername: "sni",
    });
  });
  it("parses a base64 list of vless links", () => {
    const list = "vless://u@ex.com:443#A\nvless://u@ex.com:8443#B";
    const b64 = Buffer.from(list, "utf8").toString("base64");
    const out = parseProxiesFromText(b64);
    expect(out.map((p) => p.name)).toEqual(["A", "B"]);
  });
  it("returns an empty array for unrecognized text", () => {
    expect(parseProxiesFromText("not a subscription")).toEqual([]);
  });
});
