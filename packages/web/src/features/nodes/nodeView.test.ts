import type { NodeItem, Source } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatRate,
  groupNodes,
  latencyClass,
  latencyLabel,
  splitNodes,
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
  return { name, type: "vless", delay: 47 };
}

describe("nodeView", () => {
  it("classifies latency", () => {
    expect(latencyClass(null)).toBe("idle");
    expect(latencyClass(0)).toBe("timeout");
    expect(latencyClass(47)).toBe("online");
    expect(latencyClass(100)).toBe("slow");
    expect(latencyClass(210)).toBe("slow");
  });
  it("labels latency", () => {
    expect(latencyLabel(null)).toBe("— ms");
    expect(latencyLabel(0)).toBe("timeout");
    expect(latencyLabel(47)).toBe("47 ms");
  });
  it("separates pseudo modes from real nodes", () => {
    const { modes, nodes } = splitNodes([
      { name: "AUTO", type: "URLTest", delay: null },
      { name: "NL-1", type: "vless", delay: 47 },
      { name: "DIRECT", type: "Direct", delay: null },
    ]);
    expect(modes.map((m) => m.name)).toEqual(["AUTO", "DIRECT"]);
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
});
