import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseAmneziaVpnLink, parseWireguardConf } from "./wireguard.js";

const AWG_CONF = `[Interface]
PrivateKey = QPfJjCBp1htdPan2YGZp6N4H0O/5YBsO3+XtyHrY43I=
Address = 10.8.2.2/32
DNS = 1.1.1.1, 1.0.0.1
Jc = 7
Jmin = 50
Jmax = 1000
S1 = 86
S2 = 118
H1 = 1987912497
H2 = 1060324821
H3 = 1565009321
H4 = 290779217

[Peer]
PublicKey = Euk1dzwOLFiEsOkqJThaU8KWteBezAbOAFGs9XdVZQw=
PresharedKey = AQnQf1z/atmH0hNudbMqFZyXBWMqcXOxpPT1hcpjKX8=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 194.41.113.64:443
PersistentKeepalive = 25`;

describe("parseWireguardConf", () => {
  it("maps an AmneziaWG .conf to a mihomo wireguard proxy", () => {
    const p = parseWireguardConf(AWG_CONF) as Record<string, unknown>;
    expect(p).toMatchObject({
      name: "AmneziaWG 194.41.113.64",
      type: "wireguard",
      "private-key": "QPfJjCBp1htdPan2YGZp6N4H0O/5YBsO3+XtyHrY43I=",
      ip: "10.8.2.2",
      server: "194.41.113.64",
      port: 443,
      "public-key": "Euk1dzwOLFiEsOkqJThaU8KWteBezAbOAFGs9XdVZQw=",
      "pre-shared-key": "AQnQf1z/atmH0hNudbMqFZyXBWMqcXOxpPT1hcpjKX8=",
      "persistent-keepalive": 25,
      udp: true,
    });
    expect(p.dns).toEqual(["1.1.1.1", "1.0.0.1"]);
    expect(p["allowed-ips"]).toEqual(["0.0.0.0/0", "::/0"]);
    expect(p["amnezia-wg-option"]).toEqual({
      jc: 7,
      jmin: 50,
      jmax: 1000,
      s1: 86,
      s2: 118,
      h1: 1987912497,
      h2: 1060324821,
      h3: 1565009321,
      h4: 290779217,
    });
  });

  it("plain WireGuard (no AWG params) → no amnezia-wg-option", () => {
    const conf = AWG_CONF.replace(/^(Jc|Jmin|Jmax|S1|S2|H1|H2|H3|H4) =.*$/gm, "").replace(
      /\n{2,}/g,
      "\n\n",
    );
    const p = parseWireguardConf(conf) as Record<string, unknown>;
    expect(p.type).toBe("wireguard");
    expect(p["amnezia-wg-option"]).toBeUndefined();
    expect(p.name).toBe("WireGuard 194.41.113.64");
  });

  it("uses a #_Name / # Name comment for the node name when present", () => {
    const named = AWG_CONF.replace("[Peer]", "#_Name = Berlin\n[Peer]");
    expect(parseWireguardConf(named).name).toBe("Berlin");
  });

  it("throws on a non-wireguard blob", () => {
    expect(() => parseWireguardConf("not a conf")).toThrow();
  });
});

function makeVpnLink(obj: unknown): string {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const body = deflateSync(json);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return `vpn://${Buffer.concat([head, body]).toString("base64url")}`;
}

describe("parseAmneziaVpnLink", () => {
  it("config_version 1 with an embedded WG .conf → wireguard proxy", () => {
    const conf =
      "[Interface]\nPrivateKey = k\nJc = 7\n[Peer]\nPublicKey = pk\nEndpoint = 1.2.3.4:443\n";
    const link = makeVpnLink({
      config_version: 1,
      containers: [{ container: "amnezia-awg", awg: { last_config: conf } }],
    });
    const p = parseAmneziaVpnLink(link) as Record<string, unknown>;
    expect(p.type).toBe("wireguard");
    expect(p.server).toBe("1.2.3.4");
    expect(p.port).toBe(443);
    expect(p["amnezia-wg-option"]).toBeDefined();
  });

  it("prefers the container's display name over the .conf endpoint default", () => {
    const conf = "[Interface]\nPrivateKey = k\n[Peer]\nPublicKey = pk\nEndpoint = 1.2.3.4:443\n";
    const link = makeVpnLink({
      config_version: 1,
      name: "Berlin",
      containers: [{ awg: { last_config: conf } }],
    });
    expect(parseAmneziaVpnLink(link).name).toBe("Berlin");
  });

  it("config_version 2 (hosted 'amnezia-free') is rejected with a clear message", () => {
    const link = makeVpnLink({
      config_version: 2,
      api_config: { service_protocol: "awg", service_type: "amnezia-free" },
      auth_data: { api_key: "x" },
    });
    expect(() => parseAmneziaVpnLink(link)).toThrow(/hosted|not yet|Free|API/i);
  });
});
