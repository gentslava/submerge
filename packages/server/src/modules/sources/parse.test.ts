import { sourceKindSchema } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import {
  detectKind,
  detectKindSafe,
  extractSubUrl,
  parseHysteria2,
  parseProxiesFromText,
  parseShadowsocks,
  parseSingleLink,
  parseTrojan,
  parseTuic,
  parseVless,
  parseVmess,
} from "./parse.js";

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
  it("detects a non-crypt happ:// without an embedded url as happ", () =>
    expect(detectKind("happ://import/abc")).toBe("happ"));
  it("throws on an empty string", () => expect(() => detectKind("")).toThrow());
  it("rejects unsupported single nodes", () => expect(() => detectKind("ssr://xxx")).toThrow());
});

describe("parseSingleLink", () => {
  it("dispatches vless:// to parseVless", () => {
    const p = parseSingleLink("vless://uuid@ex.com:443?type=tcp#N");
    expect(p.type).toBe("vless");
    expect(p.server).toBe("ex.com");
  });
  it("rejects an unsupported single-node scheme", () => {
    expect(() => parseSingleLink("ssr://whatever")).toThrow(/unsupported/i);
  });
});

describe("detectKind single links", () => {
  it("detects vless", () => expect(detectKind("vless://u@h:443")).toBe("vless"));
  it("still rejects a not-yet-supported single link with a clear message", () => {
    expect(() => detectKind("hysteria://p@h:443")).toThrow(/supported yet|subscription/i);
  });
});

describe("detectKindSafe", () => {
  it("returns a valid SourceKind for a subscription url", () => {
    const kind = detectKindSafe("https://ex.com/sub");
    expect(kind).toBe("sub");
    expect(sourceKindSchema.parse(kind)).toBe("sub");
  });
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

describe("parseHysteria2", () => {
  it("maps a hysteria2:// URI to a mihomo proxy", () => {
    const p = parseHysteria2(
      "hysteria2://pass@ex.com:443/?sni=real.ex.com&obfs=salamander&obfs-password=ob&insecure=1#DE",
    );
    expect(p).toMatchObject({
      name: "DE",
      type: "hysteria2",
      server: "ex.com",
      port: 443,
      password: "pass",
      sni: "real.ex.com",
      obfs: "salamander",
      "obfs-password": "ob",
      "skip-cert-verify": true,
    });
  });
  it("accepts the hy2:// alias and defaults the name to host:port", () => {
    const p = parseHysteria2("hy2://pw@ex.com:8443");
    expect(p.type).toBe("hysteria2");
    expect(p.name).toBe("ex.com:8443");
  });
  it("handles the real minimal shape: token auth, sni-only, spaced/cyrillic name", () => {
    const p = parseHysteria2(
      "hysteria2://abc123token@se.allgoodvpn.su:8443?sni=se.allgoodvpn.su#AllGood | Стокгольм (Hysteria2)",
    );
    expect(p).toMatchObject({
      type: "hysteria2",
      server: "se.allgoodvpn.su",
      port: 8443,
      password: "abc123token",
      sni: "se.allgoodvpn.su",
    });
    expect(p.name).toBe("AllGood | Стокгольм (Hysteria2)");
    expect((p as Record<string, unknown>)["skip-cert-verify"]).toBeUndefined();
    expect((p as Record<string, unknown>).obfs).toBeUndefined();
  });
  it("is reachable via detectKind + parseSingleLink", () => {
    expect(detectKind("hysteria2://pw@ex.com:443")).toBe("hysteria2");
    expect(parseSingleLink("hy2://pw@ex.com:443").type).toBe("hysteria2");
  });
  it("maps a sing-box hysteria2 outbound", () => {
    const { proxies } = parseProxiesFromText(
      JSON.stringify({
        outbounds: [
          {
            type: "hysteria2",
            tag: "HY",
            server: "ex.com",
            server_port: 443,
            password: "pw",
            obfs: { type: "salamander", password: "ob" },
            tls: { server_name: "ex.com", insecure: false },
          },
        ],
      }),
    );
    expect(proxies[0]).toMatchObject({
      type: "hysteria2",
      server: "ex.com",
      port: 443,
      password: "pw",
      obfs: "salamander",
    });
  });
});

describe("parseTrojan", () => {
  it("maps trojan://pass@host:port?sni=&type= to a mihomo proxy", () => {
    const p = parseTrojan("trojan://secret@ex.com:443?sni=ex.com&type=tcp#TR");
    expect(p).toMatchObject({
      name: "TR",
      type: "trojan",
      server: "ex.com",
      port: 443,
      password: "secret",
      sni: "ex.com",
      network: "tcp",
    });
  });
  it("is reachable via detectKind", () => {
    expect(detectKind("trojan://p@ex.com:443")).toBe("trojan");
  });
});

describe("parseVmess", () => {
  it("maps a vmess:// base64 JSON link", () => {
    const conf = {
      v: "2",
      ps: "VM",
      add: "ex.com",
      port: "443",
      id: "uuid-1",
      aid: "0",
      net: "ws",
      type: "none",
      host: "ex.com",
      path: "/ws",
      tls: "tls",
      sni: "ex.com",
    };
    const uri = `vmess://${Buffer.from(JSON.stringify(conf)).toString("base64")}`;
    const p = parseVmess(uri);
    expect(p).toMatchObject({
      name: "VM",
      type: "vmess",
      server: "ex.com",
      port: 443,
      uuid: "uuid-1",
      alterId: 0,
      cipher: "auto",
      network: "ws",
      tls: true,
      servername: "ex.com",
    });
    expect((p as Record<string, unknown>)["ws-opts"]).toEqual({
      path: "/ws",
      headers: { Host: "ex.com" },
    });
  });
  it("is reachable via detectKind", () => {
    const uri = `vmess://${Buffer.from(JSON.stringify({ add: "h", port: "1", id: "u" })).toString("base64")}`;
    expect(detectKind(uri)).toBe("vmess");
  });
  it("reads the scy cipher when present", () => {
    const conf = { ps: "VM", add: "ex.com", port: "443", id: "u", net: "tcp", scy: "aes-128-gcm" };
    const uri = `vmess://${Buffer.from(JSON.stringify(conf)).toString("base64")}`;
    expect(parseVmess(uri).cipher).toBe("aes-128-gcm");
  });
});

describe("parseShadowsocks", () => {
  it("maps a SIP002 ss:// link", () => {
    const userinfo = Buffer.from("aes-256-gcm:secret").toString("base64url");
    const p = parseShadowsocks(`ss://${userinfo}@ex.com:8388#SS`);
    expect(p).toMatchObject({
      name: "SS",
      type: "ss",
      server: "ex.com",
      port: 8388,
      cipher: "aes-256-gcm",
      password: "secret",
    });
  });
  it("is reachable via detectKind", () => {
    const userinfo = Buffer.from("aes-256-gcm:pw").toString("base64url");
    expect(detectKind(`ss://${userinfo}@ex.com:8388`)).toBe("ss");
  });
});

describe("parseTuic", () => {
  it("maps a tuic:// URI", () => {
    const p = parseTuic("tuic://uuid-1:secret@ex.com:443?sni=ex.com&congestion_control=bbr#TU");
    expect(p).toMatchObject({
      name: "TU",
      type: "tuic",
      server: "ex.com",
      port: 443,
      uuid: "uuid-1",
      password: "secret",
      sni: "ex.com",
      "congestion-controller": "bbr",
    });
  });
  it("is reachable via detectKind", () => {
    expect(detectKind("tuic://u:p@ex.com:443")).toBe("tuic");
  });
});

describe("parseProxiesFromText", () => {
  it("parses clash/mihomo yaml", () => {
    const yaml = "proxies:\n  - {name: A, type: vless, server: ex.com, port: 443, uuid: u}\n";
    const out = parseProxiesFromText(yaml).proxies;
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
    const out = parseProxiesFromText(json).proxies;
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
    const out = parseProxiesFromText(json).proxies;
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
    const out = parseProxiesFromText(b64).proxies;
    expect(out.map((p) => p.name)).toEqual(["A", "B"]);
  });
  it("returns an empty array for unrecognized text", () => {
    expect(parseProxiesFromText("not a subscription").proxies).toEqual([]);
  });
  it("skips malformed vless lines and keeps the valid ones", () => {
    expect(
      parseProxiesFromText("vless://bad\nvless://u@ex.com:443#A").proxies.map((p) => p.name),
    ).toEqual(["A"]);
  });
  it("defaults a missing JSON server_port instead of emitting NaN (would break mihomo config)", () => {
    const { proxies } = parseProxiesFromText(
      JSON.stringify({
        outbounds: [{ type: "hysteria2", tag: "HY", server: "ex.com", password: "pw" }], // no server_port
      }),
    );
    expect(proxies[0]?.port).toBe(443);
    expect(Number.isNaN(proxies[0]?.port)).toBe(false);
  });
});

describe("parseProxiesFromText skipped", () => {
  it("returns parsed proxies and a deduped list of skipped schemes", () => {
    const body = "vless://u@ex.com:443#A\nssr://xxx\nssr://yyy\n";
    const { proxies, skipped } = parseProxiesFromText(body);
    expect(proxies.map((p) => p.name)).toEqual(["A"]);
    expect(skipped).toEqual(["ssr"]);
  });
});
