import type { Proxy as ProxyConfig } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { proxyMeta, toNodeView } from "./service.js";

const resp: ProxiesResponse = {
  proxies: {
    PROXY: { name: "PROXY", type: "Selector", now: "NL-1", all: ["NL-1", "DE-2"], history: [] },
    AUTO: { name: "AUTO", type: "URLTest", now: "NL-1", all: ["NL-1", "DE-2"], history: [] },
    "NL-1": {
      name: "NL-1",
      type: "Vless",
      history: [
        { time: "t", delay: 0 },
        { time: "t", delay: 42 },
      ],
    },
    "DE-2": { name: "DE-2", type: "Vless", history: [{ time: "t", delay: 0 }] },
  },
};

describe("toNodeView", () => {
  it("maps the PROXY group to a NodeView with delays, history and autoNow", () => {
    const view = toNodeView(resp);
    expect(view.now).toBe("NL-1");
    expect(view.autoNow).toBe("NL-1");
    expect(view.all).toEqual([
      // timeouts (0) are KEPT in history (stability signal); last value drives delay
      { name: "NL-1", type: "Vless", delay: 42, history: [0, 42] },
      { name: "DE-2", type: "Vless", delay: null, history: [0] },
    ]);
  });

  it("returns an empty view when there is no PROXY group", () => {
    expect(toNodeView({ proxies: {} })).toEqual({ now: null, autoNow: null, all: [] });
  });

  it("joins transport/security from proxy meta onto the nodes", () => {
    const proxies: ProxyConfig[] = [
      { name: "NL-1", type: "vless", server: "s", port: 1, network: "ws", tls: true },
      {
        name: "DE-2",
        type: "vless",
        server: "s",
        port: 1,
        network: "tcp",
        tls: true,
        "reality-opts": { "public-key": "x" },
      },
    ] as ProxyConfig[];
    const view = toNodeView(resp, proxyMeta(proxies));
    expect(view.all).toEqual([
      { name: "NL-1", type: "Vless", delay: 42, history: [0, 42], network: "ws", security: "tls" },
      {
        name: "DE-2",
        type: "Vless",
        delay: null,
        history: [0],
        network: "tcp",
        security: "reality",
      },
    ]);
  });
});

describe("proxyMeta", () => {
  it("derives security from reality-opts > tls > none, keeps network, first name wins", () => {
    const proxies: ProxyConfig[] = [
      {
        name: "reality",
        type: "vless",
        server: "s",
        port: 1,
        network: "tcp",
        tls: true,
        "reality-opts": {},
      },
      { name: "tls", type: "vless", server: "s", port: 1, network: "ws", tls: true },
      { name: "plain", type: "vless", server: "s", port: 1, network: "tcp" },
      { name: "clash", type: "vless", server: "s", port: 1 }, // no network field
      { name: "reality", type: "vless", server: "s", port: 2, network: "grpc" }, // dupe: ignored
    ] as ProxyConfig[];
    const m = proxyMeta(proxies);
    expect(m.get("reality")).toEqual({ network: "tcp", security: "reality" });
    expect(m.get("tls")).toEqual({ network: "ws", security: "tls" });
    expect(m.get("plain")).toEqual({ network: "tcp", security: "none" });
    expect(m.get("clash")).toEqual({ security: "none" });
  });
});
