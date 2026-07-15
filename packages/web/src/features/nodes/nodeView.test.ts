import type { NodeItem, Source } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatRate,
  groupNodes,
  latencyClass,
  latencyLabel,
  realNodes,
  securityBadge,
  serverCountLabel,
  transportBadge,
  typeBadges,
} from "./nodeView";

function src(over: Partial<Source>): Source {
  return {
    id: 1,
    kind: "sub",
    value: "https://x",
    label: "Sub",
    hwid: false,
    enabled: true,
    sortOrder: 0,
    proxies: [],
    updatedAt: "",
    createdAt: "",
    ...over,
  } as Source;
}

function node(name: string): NodeItem {
  return { name, type: "vless", delay: 47, history: [] };
}

describe("nodeView", () => {
  it("classifies latency", () => {
    expect(latencyClass(null)).toBe("idle");
    expect(latencyClass(0)).toBe("timeout");
    expect(latencyClass(330)).toBe("online");
    expect(latencyClass(500)).toBe("slow");
    expect(latencyClass(610)).toBe("slow");
  });
  it("labels latency", () => {
    expect(latencyLabel(null)).toBe("— ms");
    expect(latencyLabel(0)).toBe("timeout");
    expect(latencyLabel(330)).toBe("330 ms");
  });
  it("filters pseudo modes from real nodes", () => {
    const nodes = realNodes([
      { name: "AUTO", type: "URLTest", delay: null, history: [] },
      { name: "NL-1", type: "vless", delay: 47, history: [] },
      { name: "DIRECT", type: "Direct", delay: null, history: [] },
    ]);
    expect(nodes.map((n) => n.name)).toEqual(["NL-1"]);
  });

  it("groups nodes by source proxies and bins orphans under Прочие", () => {
    const sources: Source[] = [
      src({
        id: 1,
        label: "Opengate",
        sortOrder: 1,
        proxies: [
          { name: "nl-1", type: "vless", server: "s", port: 1 },
          { name: "de-1", type: "vless", server: "s", port: 1 },
        ],
      }),
      src({
        id: 2,
        label: "SurfVPN",
        sortOrder: 0,
        proxies: [{ name: "sg-1", type: "vless", server: "s", port: 1 }],
      }),
    ];
    const groups = groupNodes([node("nl-1"), node("de-1"), node("sg-1"), node("lonely")], sources);

    // sorted by sortOrder: SurfVPN (0) before Opengate (1)
    expect(groups.map((g) => g.label)).toEqual(["SurfVPN", "Opengate", "Прочие"]);
    expect(groups[0]?.nodes.map((n) => n.name)).toEqual(["sg-1"]);
    expect(groups[1]?.nodes.map((n) => n.name)).toEqual(["nl-1", "de-1"]);
    expect(groups[2]?.nodes.map((n) => n.name)).toEqual(["lonely"]);
  });

  it("omits sources with no matching nodes and the Прочие group when none orphaned", () => {
    const sources: Source[] = [
      src({ id: 1, label: "Empty", proxies: [{ name: "ghost", type: "x", server: "s", port: 1 }] }),
      src({ id: 2, label: "Real", proxies: [{ name: "nl-1", type: "x", server: "s", port: 1 }] }),
    ];
    const groups = groupNodes([node("nl-1")], sources);
    expect(groups.map((g) => g.label)).toEqual(["Real"]);
  });

  it("omits a disabled source when its nodes also belong to an enabled source", () => {
    const sources: Source[] = [
      src({
        id: 1,
        label: "Enabled Remnawave",
        enabled: true,
        sortOrder: 0,
        proxies: [{ name: "nl-1", type: "vless", server: "s", port: 1 }],
      }),
      src({
        id: 2,
        label: "Disabled Remnawave",
        enabled: false,
        sortOrder: 1,
        proxies: [{ name: "nl-1", type: "vless", server: "s", port: 1 }],
      }),
    ];

    const groups = groupNodes([node("nl-1")], sources);

    expect(groups.map((g) => g.label)).toEqual(["Enabled Remnawave"]);
  });

  it("does not expose a stale live node owned only by a disabled source as Прочие", () => {
    const sources: Source[] = [
      src({
        id: 1,
        label: "Disabled Remnawave",
        enabled: false,
        proxies: [{ name: "nl-1", type: "vless", server: "s", port: 1 }],
      }),
    ];

    expect(groupNodes([node("nl-1")], sources)).toEqual([]);
  });

  it("keeps a genuinely unknown live node under Прочие", () => {
    const groups = groupNodes([node("external")], [src({ enabled: false, proxies: [] })]);

    expect(groups.map((group) => group.label)).toEqual(["Прочие"]);
    expect(groups[0]?.nodes.map((item) => item.name)).toEqual(["external"]);
  });

  it("does not assign a shared node to two enabled sources", () => {
    const sources: Source[] = [
      src({
        id: 1,
        label: "First source",
        sortOrder: 0,
        proxies: [{ name: "nl-1", type: "vless", server: "s", port: 1 }],
      }),
      src({
        id: 2,
        label: "Second source",
        sortOrder: 1,
        proxies: [
          { name: "nl-1", type: "vless", server: "s", port: 1 },
          { name: "de-1", type: "vless", server: "s", port: 1 },
        ],
      }),
    ];

    const groups = groupNodes([node("nl-1"), node("de-1")], sources);

    expect(groups.map((g) => g.nodes.map((n) => n.name))).toEqual([["nl-1"], ["de-1"]]);
  });

  it("derives the transport badge, defaulting to TCP when network is omitted", () => {
    const n = (over: Partial<NodeItem>): NodeItem => ({ ...node("x"), ...over });
    expect(transportBadge(n({ network: "ws", security: "tls" }))).toBe("WS");
    expect(transportBadge(n({ network: "grpc", security: "none" }))).toBe("GRPC");
    expect(transportBadge(n({ network: "tcp" }))).toBe("TCP");
    expect(transportBadge(n({ security: "reality" }))).toBe("TCP"); // clash omits network for tcp
    expect(transportBadge(n({ security: "none" }))).toBe("TCP");
    expect(transportBadge(node("x"))).toBeNull(); // neither known (e.g. group)
    expect(transportBadge({ ...node("x"), type: "hysteria2" })).toBe("QUIC");
    expect(transportBadge({ ...node("x"), type: "Tuic" })).toBe("QUIC");
    expect(transportBadge({ ...node("x"), type: "hysteria2", network: "ws" })).toBe("WS"); // network wins
    expect(transportBadge({ ...node("x"), type: "wireguard" })).toBe("UDP");
    expect(transportBadge({ ...node("x"), type: "wireguard", network: "udp" })).toBe("UDP");
  });

  it("derives the security badge, omitting none/unknown", () => {
    const n = (over: Partial<NodeItem>): NodeItem => ({ ...node("x"), ...over });
    expect(securityBadge(n({ security: "reality" }))).toBe("Reality");
    expect(securityBadge(n({ security: "tls" }))).toBe("TLS");
    expect(securityBadge(n({ security: "none" }))).toBeNull();
    expect(securityBadge(n({ security: "amneziawg" }))).toBe("AmneziaWG");
    expect(securityBadge(node("x"))).toBeNull();
  });

  it("builds type badges as protocol · transport · security", () => {
    expect(typeBadges({ ...node("x"), security: "reality" })).toEqual(["VLESS", "TCP", "Reality"]);
    expect(typeBadges({ ...node("x"), network: "ws", security: "tls" })).toEqual([
      "VLESS",
      "WS",
      "TLS",
    ]);
    expect(typeBadges({ ...node("x"), network: "tcp", security: "none" })).toEqual([
      "VLESS",
      "TCP",
    ]);
    expect(typeBadges(node("x"))).toEqual(["VLESS"]); // group/unknown → protocol only
    expect(typeBadges({ ...node("x"), type: "wireguard", security: "amneziawg" })).toEqual([
      "WIREGUARD",
      "UDP",
      "AmneziaWG",
    ]);
    expect(typeBadges({ ...node("x"), type: "wireguard", security: "none" })).toEqual([
      "WIREGUARD",
      "UDP",
    ]);
  });

  it("formats traffic rates per second", () => {
    expect(formatRate(0)).toBe("0 Б/с");
    expect(formatRate(512)).toBe("512 Б/с");
    expect(formatRate(1536)).toBe("1.5 КБ/с");
    expect(formatRate(5 * 1024 * 1024)).toBe("5.0 МБ/с");
  });

  it("formats cumulative byte totals", () => {
    expect(formatBytes(0)).toBe("0 Б");
    expect(formatBytes(900)).toBe("900 Б");
    expect(formatBytes(1536)).toBe("1.5 КБ");
    expect(formatBytes(9_019_431_321)).toBe("8.4 ГБ");
  });

  it("pluralizes the group server count in Russian", () => {
    expect(serverCountLabel(1)).toBe("1 сервер");
    expect(serverCountLabel(2)).toBe("2 сервера");
    expect(serverCountLabel(4)).toBe("4 сервера");
    expect(serverCountLabel(5)).toBe("5 серверов");
    expect(serverCountLabel(7)).toBe("7 серверов");
    expect(serverCountLabel(11)).toBe("11 серверов");
    expect(serverCountLabel(21)).toBe("21 сервер");
  });
});
