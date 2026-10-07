import { describe, expect, it } from "vitest";
import { publicKey, uuid, xrayConfig, xrayOutbound } from "./single-node.fixture.js";
import { parseSingleNodeConfig } from "./single-node.js";

describe("single-node config", () => {
  it("preserves Xray WebSocket host ahead of a conflicting legacy Host header", () => {
    const node = parseSingleNodeConfig(
      JSON.stringify({
        ...xrayOutbound,
        streamSettings: {
          method: "websocket",
          wsSettings: {
            host: "cdn.example.com",
            path: "/proxy",
            headers: { Host: "wrong.example.com", "X-Test": "keep" },
          },
        },
      }),
    );
    expect(node["ws-opts"]).toEqual({
      path: "/proxy",
      headers: { Host: "cdn.example.com", "X-Test": "keep" },
    });
  });

  it.each([{ multiMode: true }, { authority: "cdn.example.com" }])(
    "rejects incompatible Xray gRPC options %j",
    (options) => {
      expect(() =>
        parseSingleNodeConfig(
          JSON.stringify({
            ...xrayOutbound,
            streamSettings: {
              network: "grpc",
              grpcSettings: { serviceName: "node", ...options },
            },
          }),
        ),
      ).toThrow(/gRPC/);
    },
  );

  it.each(["client_certificate", "client_key", "certificate", "certificate_public_key_sha256"])(
    "rejects unsupported sing-box TLS %s instead of dropping authentication",
    (option) => {
      expect(() =>
        parseSingleNodeConfig(
          JSON.stringify({
            type: "vless",
            tag: "TLS",
            server: "example.com",
            server_port: 443,
            uuid,
            tls: { enabled: true, [option]: ["synthetic-value"] },
          }),
        ),
      ).toThrow(/TLS/);
    },
  );
  it.each(["ws", "websocket", "grpc"])("uses Xray method %s ahead of network", (method) => {
    const node = parseSingleNodeConfig(
      JSON.stringify({
        ...xrayOutbound,
        streamSettings: {
          network: "tcp",
          method,
          wsSettings: { path: "/socket" },
          grpcSettings: { serviceName: "service" },
        },
      }),
    );
    expect(node.network).toBe(method === "websocket" ? "ws" : method);
    if (method === "grpc") expect(node["grpc-opts"]).toEqual({ "grpc-service-name": "service" });
    else expect(node["ws-opts"]).toMatchObject({ path: "/socket" });
  });

  it("rejects unsupported Xray method instead of defaulting to TCP", () => {
    expect(() =>
      parseSingleNodeConfig(
        JSON.stringify({ ...xrayOutbound, streamSettings: { method: "xhttp", network: "tcp" } }),
      ),
    ).toThrow(/транспорт/);
  });
  it("accepts a bare flow-style YAML proxy", () => {
    expect(
      parseSingleNodeConfig(
        "{name: Node, type: trojan, server: example.com, port: 443, password: secret}",
      ),
    ).toMatchObject({ name: "Node", type: "trojan", password: "secret" });
  });

  const wgKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  it("imports exactly one native WireGuard peer and normalizes its endpoint", () => {
    const peer = {
      server: "203.0.113.1",
      port: 51820,
      "public-key": wgKey,
      "allowed-ips": ["0.0.0.0/0", "::/0"],
    };
    const node = parseSingleNodeConfig(
      JSON.stringify({
        name: "WG",
        type: "wireguard",
        ip: "10.0.0.2/32",
        "private-key": wgKey,
        peers: [peer],
      }),
    );
    expect(node).toMatchObject({ server: peer.server, port: peer.port, peers: [peer] });
  });

  it.each([
    [{ name: "WG", type: "wireguard", server: "example.com", port: 51820 }, /WireGuard/],
    [
      {
        name: "WG",
        type: "wireguard",
        ip: "10.0.0.2",
        server: "example.com",
        port: 51820,
        "private-key": "bad",
        "public-key": wgKey,
      },
      /WireGuard/,
    ],
    [
      {
        name: "WG",
        type: "wireguard",
        ip: "bad",
        server: "example.com",
        port: 51820,
        "private-key": wgKey,
        "public-key": wgKey,
      },
      /WireGuard/,
    ],
    [
      {
        name: "WG",
        type: "wireguard",
        ip: "10.0.0.2",
        "private-key": wgKey,
        peers: [{ server: "example.com", port: 51820, "public-key": wgKey }],
      },
      /allowed-ips/,
    ],
    [
      { name: "WG", type: "wireguard", ip: "10.0.0.2", "private-key": wgKey, peers: [{}, {}] },
      /ровно один/,
    ],
  ])("rejects incomplete or multiple-peer native WireGuard %#", (value, message) => {
    expect(() => parseSingleNodeConfig(JSON.stringify(value))).toThrow(message);
  });
  it("accepts flattened Xray Trojan settings and preserves arbitrary password characters", () => {
    const password = "  <secret> with spaces  ";
    const node = parseSingleNodeConfig(
      JSON.stringify({
        protocol: "trojan",
        tag: "Trojan",
        settings: { address: "example.com", port: 443, password },
        streamSettings: {
          network: "tcp",
          security: "tls",
          tlsSettings: { serverName: "sni.example.com" },
          tcpSettings: {},
        },
      }),
    );
    expect(node).toMatchObject({ type: "trojan", password, tls: true, sni: "sni.example.com" });
  });

  it("preserves a native Shadowsocks password containing angle brackets", () => {
    const password = "secret<with>symbols";
    const node = parseSingleNodeConfig(
      JSON.stringify({
        name: "SS",
        type: "ss",
        server: "example.com",
        port: 443,
        cipher: "aes-128-gcm",
        password,
      }),
    );
    expect(node.password).toBe(password);
  });

  it("accepts default TCP settings but rejects a raw HTTP header it cannot convert", () => {
    expect(
      parseSingleNodeConfig(
        JSON.stringify({
          ...xrayOutbound,
          streamSettings: { ...xrayOutbound.streamSettings, tcpSettings: {} },
        }),
      ).network,
    ).toBe("tcp");
    expect(() =>
      parseSingleNodeConfig(
        JSON.stringify({
          ...xrayOutbound,
          streamSettings: { network: "raw", rawSettings: { header: { type: "http" } } },
        }),
      ),
    ).toThrow(/TCP header/);
  });

  it("rejects sing-box Shadowsocks plugins instead of dropping their wire protocol", () => {
    expect(() =>
      parseSingleNodeConfig(
        JSON.stringify({
          type: "shadowsocks",
          tag: "SS",
          server: "example.com",
          server_port: 443,
          method: "aes-128-gcm",
          password: "secret",
          plugin: "obfs-local",
          plugin_opts: "obfs=http;obfs-host=example.com",
        }),
      ),
    ).toThrow(/плагин/);
  });
  it("extracts only the VLESS Reality node from a full Xray config", () => {
    expect(parseSingleNodeConfig(JSON.stringify(xrayConfig))).toEqual({
      name: "My single node",
      type: "vless",
      server: "203.0.113.1",
      port: 443,
      uuid,
      flow: "xtls-rprx-vision",
      udp: true,
      network: "tcp",
      tls: true,
      servername: "example.com",
      "client-fingerprint": "chrome",
      "reality-opts": { "public-key": publicKey, "short-id": "0123456789abcdef" },
    });
  });

  it("accepts a bare Xray outbound and a one-profile JSON array", () => {
    expect(parseSingleNodeConfig(JSON.stringify(xrayOutbound)).name).toBe("proxy");
    expect(parseSingleNodeConfig(JSON.stringify([xrayConfig])).name).toBe("My single node");
  });

  it("accepts current flattened Xray VLESS settings and raw transport", () => {
    const settings = {
      address: "203.0.113.1",
      port: 443,
      id: uuid,
      encryption: "none",
      flow: "xtls-rprx-vision",
    };
    const node = parseSingleNodeConfig(
      JSON.stringify({
        ...xrayOutbound,
        settings,
        streamSettings: { ...xrayOutbound.streamSettings, network: "raw" },
      }),
    );
    expect(node.network).toBe("tcp");
    expect(node.uuid).toBe(uuid);
  });

  it("preserves sing-box TLS, Reality and WebSocket options", () => {
    const node = parseSingleNodeConfig(
      JSON.stringify({
        outbounds: [
          {
            type: "vless",
            tag: "SG",
            server: "example.com",
            server_port: 8443,
            uuid,
            flow: "xtls-rprx-vision",
            tls: {
              enabled: true,
              server_name: "sni.example.com",
              insecure: true,
              alpn: ["http/1.1"],
              utls: { enabled: true, fingerprint: "chrome" },
              reality: { enabled: true, public_key: publicKey, short_id: "abcd" },
            },
            transport: { type: "ws", path: "/proxy", headers: { Host: "cdn.example.com" } },
          },
          { type: "direct" },
          { type: "block" },
        ],
      }),
    );
    expect(node).toMatchObject({
      name: "SG",
      port: 8443,
      tls: true,
      network: "ws",
      "skip-cert-verify": true,
      alpn: ["http/1.1"],
      "ws-opts": { path: "/proxy", headers: { Host: "cdn.example.com" } },
    });
  });

  const native = {
    name: "Native",
    type: "vless",
    server: "example.com",
    port: 443,
    uuid,
    tls: true,
    "ws-opts": { path: "https://example.com/socket" },
  };
  it("accepts a bare mihomo JSON proxy and preserves protocol options", () => {
    expect(parseSingleNodeConfig(JSON.stringify(native))).toEqual(native);
  });
  it("accepts bare YAML and a one-proxy Clash config", () => {
    const yaml = `name: Native\ntype: vless\nserver: example.com\nport: 443\nuuid: ${uuid}\n`;
    expect(parseSingleNodeConfig(yaml)).toMatchObject({ name: "Native", type: "vless" });
    expect(parseSingleNodeConfig(`proxies:\n  - ${JSON.stringify(native)}\n`)).toEqual(native);
  });

  it.each([
    [{ outbounds: [xrayOutbound, xrayOutbound] }, /ровно один/],
    [{ outbounds: [xrayOutbound, { protocol: "socks" }] }, /ровно один/],
    [{ proxies: [native, { name: "Broken" }] }, /ровно один/],
    [
      {
        ...xrayOutbound,
        settings: { vnext: [xrayOutbound.settings.vnext[0], xrayOutbound.settings.vnext[0]] },
      },
      /ровно один/,
    ],
    [
      {
        ...xrayOutbound,
        settings: {
          vnext: [{ ...xrayOutbound.settings.vnext[0], users: [{ id: uuid }, { id: uuid }] }],
        },
      },
      /ровно один/,
    ],
    [{ outbounds: [{ protocol: "freedom" }, { protocol: "blackhole" }] }, /не найден/],
    [{ protocol: "unsupported" }, /Не поддерживается/],
    [{ ...native, port: 0 }, /порт/],
    [{ ...native, port: 65536 }, /порт/],
    [{ ...native, port: 443.5 }, /порт/],
    [{ ...native, server: "<替换为实际IP>" }, /адрес/],
    [{ ...native, uuid: "<替换为实际UUID>" }, /UUID/],
    [
      {
        ...xrayOutbound,
        settings: { vnext: [{ address: "example.com", port: "bad", users: [{ id: uuid }] }] },
      },
      /порт/,
    ],
    [
      {
        ...xrayOutbound,
        streamSettings: { ...xrayOutbound.streamSettings, realitySettings: { publicKey: "<key>" } },
      },
      /Reality/,
    ],
    [{ ...xrayOutbound, streamSettings: { network: "kcp" } }, /транспорт/],
    [{ ...native, "dialer-proxy": "Another node" }, /цепоч/],
    [{ type: "vless", server: "example.com", server_port: 443, uuid, detour: "other" }, /цепоч/],
    [{ type: "trojan", server: "example.com", server_port: 443 }, /пароль/],
    [null, /конфиг/],
  ])("rejects invalid or ambiguous input %#", (config, message) => {
    expect(() => parseSingleNodeConfig(JSON.stringify(config))).toThrow(message);
  });

  it("rejects malformed JSON instead of accepting it as YAML", () => {
    expect(() => parseSingleNodeConfig('{"outbounds": [')).toThrow(/JSON/);
  });
});
