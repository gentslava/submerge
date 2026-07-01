import type { NodeItem, NodeView } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { pickBest, selectableNames } from "./controller.js";

const node = (name: string, delay: number | null = null): NodeItem => ({
  name,
  type: "vless",
  delay,
  history: [],
});

const view = (names: string[], autoNow: string | null = null): NodeView => ({
  now: "AUTO",
  autoNow,
  all: names.map((n) => node(n)),
});

describe("selectableNames", () => {
  it("drops pseudo groups (AUTO/PROXY/DIRECT/REJECT/GLOBAL)", () => {
    expect(selectableNames(view(["AUTO", "A", "DIRECT", "B", "REJECT"]))).toEqual(["A", "B"]);
  });
});

describe("pickBest", () => {
  it("fastest: picks the lowest-latency reachable node", async () => {
    const delays: Record<string, number | null> = { A: 120, B: 40, C: null };
    const probe = async (name: string) => delays[name] ?? null;
    expect(await pickBest(["A", "B", "C"], "u", "fastest", probe)).toBe("B");
  });
  it("fastest: falls back to the first name when all probes fail", async () => {
    const probe = async () => null;
    expect(await pickBest(["A", "B"], "u", "fastest", probe)).toBe("A");
  });
  it("lowest-loss: ranks by success count over samples, then latency", async () => {
    // A: 1/3 ok (fast when ok); B: 3/3 ok (slower). B wins on reliability.
    const seq: Record<string, (number | null)[]> = {
      A: [10, null, null],
      B: [80, 80, 80],
    };
    const idx: Record<string, number> = { A: 0, B: 0 };
    const probe = async (name: string) => {
      const arr = seq[name] as (number | null)[];
      const i = idx[name] as number;
      idx[name] = i + 1;
      return arr[i] ?? null;
    };
    expect(await pickBest(["A", "B"], "u", "lowest-loss", probe, 3)).toBe("B");
  });
  it("returns null for an empty candidate list", async () => {
    expect(await pickBest([], "u", "fastest", async () => 1)).toBeNull();
  });
});
