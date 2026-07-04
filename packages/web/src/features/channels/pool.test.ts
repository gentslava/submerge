import type { Channel, ChannelPoolMember } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import {
  channelGroupNames,
  hasNodeMember,
  hasSourceMember,
  poolGroupCaption,
  toggleNodePool,
  toggleSourcePool,
} from "./pool";

const src = (ref: string): ChannelPoolMember => ({ kind: "source", ref });
const node = (ref: string): ChannelPoolMember => ({ kind: "node", ref });

const channel = (overrides: Partial<Channel>): Channel => ({
  id: "ch1",
  name: "Streaming",
  priority: -1,
  enabled: true,
  isDefault: false,
  policy: { kind: "manual", pinnedNode: "X", onFailure: "hold" },
  matcher: { presets: [], domains: [] },
  lastReason: null,
  lastReasonAt: null,
  ...overrides,
});

describe("channelGroupNames", () => {
  it("maps the Default channel to AUTO", () => {
    expect(channelGroupNames([channel({ id: "default", isDefault: true })])).toEqual(
      new Set(["AUTO"]),
    );
  });

  it("maps a non-default channel to ch-<id>", () => {
    expect(channelGroupNames([channel({ id: "ch1", isDefault: false })])).toEqual(
      new Set(["ch-ch1"]),
    );
  });

  it("collects one name per channel, mixing Default and regular channels", () => {
    const names = channelGroupNames([
      channel({ id: "default", isDefault: true }),
      channel({ id: "ch1", isDefault: false }),
      channel({ id: "ch2", isDefault: false }),
    ]);
    expect(names).toEqual(new Set(["AUTO", "ch-ch1", "ch-ch2"]));
  });

  it("returns an empty set for no channels", () => {
    expect(channelGroupNames([])).toEqual(new Set());
  });
});

describe("hasSourceMember / hasNodeMember", () => {
  it("finds a source ref by id, independent of node refs", () => {
    const pool = [src("3"), node("nl-1")];
    expect(hasSourceMember(pool, 3)).toBe(true);
    expect(hasSourceMember(pool, 4)).toBe(false);
    expect(hasNodeMember(pool, "nl-1")).toBe(true);
    expect(hasNodeMember(pool, "de-1")).toBe(false);
  });
});

describe("toggleSourcePool", () => {
  it("adds the source ref when checked", () => {
    expect(toggleSourcePool([], 5, [], true)).toEqual([src("5")]);
  });

  it("removes the source ref when unchecked", () => {
    expect(toggleSourcePool([src("5"), node("nl-1")], 5, ["nl-1"], false)).toEqual([node("nl-1")]);
  });

  it("drops now-redundant per-node refs of that source when checking it", () => {
    const pool = [node("nl-1"), node("de-1"), node("other-source-node")];
    expect(toggleSourcePool(pool, 5, ["nl-1", "de-1"], true)).toEqual([
      node("other-source-node"),
      src("5"),
    ]);
  });

  it("is a no-op re-adding an already-present source ref", () => {
    expect(toggleSourcePool([src("5")], 5, [], true)).toEqual([src("5")]);
  });
});

describe("toggleNodePool", () => {
  it("adds the node ref when checked", () => {
    expect(toggleNodePool([], "nl-1", true)).toEqual([node("nl-1")]);
  });

  it("removes the node ref when unchecked", () => {
    expect(toggleNodePool([node("nl-1"), src("5")], "nl-1", false)).toEqual([src("5")]);
  });

  it("leaves other members untouched", () => {
    expect(toggleNodePool([node("de-1")], "nl-1", true)).toEqual([node("de-1"), node("nl-1")]);
  });
});

describe("poolGroupCaption", () => {
  it("labels an empty selection as none", () => {
    expect(poolGroupCaption(0, 3)).toBe("—");
  });

  it("labels a group with no nodes as none", () => {
    expect(poolGroupCaption(0, 0)).toBe("—");
  });

  it("labels a partial selection", () => {
    expect(poolGroupCaption(1, 2)).toBe("часть");
  });

  it("labels a full selection", () => {
    expect(poolGroupCaption(2, 2)).toBe("всё");
  });
});
