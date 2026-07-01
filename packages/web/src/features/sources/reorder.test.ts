import type { Source } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { reorderSourcesList } from "./reorder";

const src = (id: number): Source =>
  ({ id, kind: "sub", value: `v${id}`, label: `s${id}` }) as Source;

describe("reorderSourcesList", () => {
  const list = [src(1), src(2), src(3), src(4)];

  it("moves an item down to the drop target's position", () => {
    expect(reorderSourcesList(list, 1, 3).map((s) => s.id)).toEqual([2, 3, 1, 4]);
  });

  it("moves an item up to the drop target's position", () => {
    expect(reorderSourcesList(list, 4, 2).map((s) => s.id)).toEqual([1, 4, 2, 3]);
  });

  it("returns the list unchanged when active === over", () => {
    expect(reorderSourcesList(list, 2, 2)).toBe(list);
  });

  it("returns the list unchanged when an id is not found", () => {
    expect(reorderSourcesList(list, 1, 99)).toBe(list);
  });
});
