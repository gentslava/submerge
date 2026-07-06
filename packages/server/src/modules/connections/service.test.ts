import { describe, expect, it } from "vitest";
import type { MihomoConnection } from "../../clients/mihomo.js";
import { toConnectionItem } from "./service.js";

const base: MihomoConnection = {
  id: "c1",
  metadata: {
    network: "tcp",
    host: "youtube.com",
    destinationIP: "142.250.1.1",
    destinationPort: "443",
    sourceIP: "192.168.1.9",
    process: "",
  },
  upload: 100,
  download: 200,
  start: "2026-07-06T20:00:00Z",
  chains: ["nl-ams-01", "AUTO"],
};

describe("toConnectionItem", () => {
  it("maps the outbound node from chains[0] and keeps cumulative bytes", () => {
    const item = toConnectionItem(base);
    expect(item.node).toBe("nl-ams-01");
    expect(item.up).toBe(100);
    expect(item.down).toBe(200);
    expect(item.start).toBe("2026-07-06T20:00:00Z");
  });

  it("falls back ИСТОЧНИК to sourceIP when process is empty", () => {
    expect(toConnectionItem(base).source).toBe("192.168.1.9");
  });

  it("prefers the process name when mihomo resolved it", () => {
    const item = toConnectionItem({ ...base, metadata: { ...base.metadata, process: "Vivaldi" } });
    expect(item.source).toBe("Vivaldi");
  });

  it("falls back host to destinationIP when host is empty", () => {
    const item = toConnectionItem({ ...base, metadata: { ...base.metadata, host: "" } });
    expect(item.host).toBe("142.250.1.1");
  });

  it("normalizes network to tcp/udp and defaults an empty chain to ''", () => {
    const udp = toConnectionItem({
      ...base,
      metadata: { ...base.metadata, network: "UDP" },
      chains: [],
    });
    expect(udp.network).toBe("udp");
    expect(udp.node).toBe("");
    const weird = toConnectionItem({ ...base, metadata: { ...base.metadata, network: "" } });
    expect(weird.network).toBe("tcp");
  });
});
