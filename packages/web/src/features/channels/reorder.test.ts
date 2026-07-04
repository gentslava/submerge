import { describe, expect, it } from "vitest";
import type { RouterOutputs } from "@/lib/trpc";
import { reorderChannelsList } from "./reorder";

type ChannelItem = RouterOutputs["channels"]["list"][number];
const ch = (id: string): ChannelItem => ({ id }) as ChannelItem;

describe("reorderChannelsList", () => {
  const list = [ch("ch1"), ch("ch2"), ch("ch3"), ch("ch4")];

  it("moves an item down to the drop target's position", () => {
    expect(reorderChannelsList(list, "ch1", "ch3").map((c) => c.id)).toEqual([
      "ch2",
      "ch3",
      "ch1",
      "ch4",
    ]);
  });

  it("moves an item up to the drop target's position", () => {
    expect(reorderChannelsList(list, "ch4", "ch2").map((c) => c.id)).toEqual([
      "ch1",
      "ch4",
      "ch2",
      "ch3",
    ]);
  });

  it("returns the list unchanged when active === over", () => {
    expect(reorderChannelsList(list, "ch2", "ch2")).toBe(list);
  });

  it("returns the list unchanged when an id is not found (e.g. dropped onto Default)", () => {
    expect(reorderChannelsList(list, "ch1", "default")).toBe(list);
  });
});
