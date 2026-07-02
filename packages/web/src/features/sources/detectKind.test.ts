import { describe, expect, it } from "vitest";
import { detectKindHint } from "./detectKind";

describe("detectKindHint", () => {
  it("detects kinds for the type badge", () => {
    expect(detectKindHint("vless://u@h:443")).toBe("vless");
    expect(detectKindHint("happ://crypt5/x")).toBe("happ");
    expect(detectKindHint("https://ex.com/sub")).toBe("sub");
    expect(detectKindHint("clash://install?url=x")).toBe("sub");
    expect(detectKindHint("")).toBe("unknown");
  });

  it("detects vless case-insensitively", () => {
    expect(detectKindHint("VLESS://abc")).toBe("vless");
  });

  it("detects the non-vless single-link protocols (not just 'sub')", () => {
    expect(detectKindHint("hysteria2://p@h:443")).toBe("hysteria2");
    expect(detectKindHint("hy2://p@h:443")).toBe("hysteria2"); // alias
    expect(detectKindHint("vmess://base64")).toBe("vmess");
    expect(detectKindHint("trojan://p@h:443")).toBe("trojan");
    expect(detectKindHint("ss://base64@h:8388")).toBe("ss");
    expect(detectKindHint("tuic://u:p@h:443")).toBe("tuic");
  });

  it("still treats other schemes / deep-links as sub", () => {
    expect(detectKindHint("ssr://x")).toBe("sub");
    expect(detectKindHint("clash://install?url=x")).toBe("sub");
  });

  it("detects wireguard / amneziawg configs", () => {
    expect(detectKindHint("[Interface]\nPrivateKey = x\nJc=7\n[Peer]\n")).toBe("amneziawg");
    expect(detectKindHint("[Interface]\nPrivateKey = x\n[Peer]\n")).toBe("wireguard");
    expect(detectKindHint("vpn://AAAA")).toBe("amneziawg");
  });
});
