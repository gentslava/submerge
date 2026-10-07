export const uuid = "c95bd59f-c878-4629-a361-8217ef57ddef";
export const publicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const xrayOutbound = {
  protocol: "vless",
  tag: "proxy",
  settings: {
    vnext: [
      {
        address: "203.0.113.1",
        port: 443,
        users: [{ id: uuid, encryption: "none", flow: "xtls-rprx-vision" }],
      },
    ],
  },
  streamSettings: {
    network: "tcp",
    security: "reality",
    realitySettings: {
      fingerprint: "chrome",
      publicKey,
      serverName: "example.com",
      shortId: "0123456789abcdef",
      spiderX: "/",
    },
  },
  mux: { enabled: false, concurrency: -1 },
};
export const xrayConfig = {
  remarks: "My single node",
  dns: { servers: ["https://cloudflare-dns.com/dns-query"] },
  inbounds: [{ port: 10808, protocol: "socks" }],
  outbounds: [
    xrayOutbound,
    { protocol: "freedom", tag: "direct" },
    { protocol: "blackhole", tag: "block" },
  ],
  routing: { rules: [{ domain: ["geosite:private"], outboundTag: "direct" }] },
};
