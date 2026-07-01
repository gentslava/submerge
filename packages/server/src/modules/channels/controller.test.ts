import type { Channel, ChannelPolicy, NodeItem, NodeView } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import { ChannelController, pickBest, selectableNames } from "./controller.js";

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

const stickyPolicy = (
  over: Partial<Extract<ChannelPolicy, { kind: "sticky" }>> = {},
): ChannelPolicy => ({
  kind: "sticky",
  testUrl: "https://probe",
  intervalSec: 60,
  failureThreshold: 3,
  maxHoldHours: null,
  initialCriterion: "fastest",
  ...over,
});

const channel = (policy: ChannelPolicy): Channel => ({
  id: "default",
  name: "Default",
  priority: 0,
  enabled: true,
  isDefault: true,
  policy,
  matcher: { presets: [], domains: [] },
  lastReason: null,
  lastReasonAt: null,
});

interface Harness {
  ctrl: ChannelController;
  selected: string[];
  reasons: { reason: string; at: number }[];
  setClock: (t: number) => void;
  setProbe: (fn: (name: string) => number | null) => void;
}

function harness(policy: ChannelPolicy): Harness {
  let clock = 0;
  let probeFn: (name: string) => number | null = () => 50;
  const selected: string[] = [];
  const reasons: { reason: string; at: number }[] = [];
  const ctrl = new ChannelController({
    readChannel: () => channel(policy),
    probe: async (name) => probeFn(name),
    select: async (_group, name) => {
      selected.push(name);
    },
    persistReason: (reason, at) => reasons.push({ reason, at }),
    now: () => clock,
  });
  return {
    ctrl,
    selected,
    reasons,
    setClock: (t) => {
      clock = t;
    },
    setProbe: (fn) => {
      probeFn = fn;
    },
  };
}

describe("ChannelController sticky", () => {
  it("pins a best node on the first tick when AUTO points nowhere valid", async () => {
    const h = harness(stickyPolicy());
    h.setProbe((n) => (n === "B" ? 20 : 90));
    await h.ctrl.tick(view(["AUTO", "A", "B", "DIRECT"], null));
    expect(h.selected).toEqual(["B"]); // fastest
    expect(h.reasons.at(-1)?.reason).toContain("initial");
  });

  it("holds a healthy pinned node — no switch across many ticks", async () => {
    const h = harness(stickyPolicy());
    h.setProbe(() => 30); // always healthy
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A (in-candidate)
    const afterAdopt = h.selected.length;
    for (let i = 1; i <= 10; i++) {
      h.setClock(i * 60_000);
      await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    }
    expect(h.selected.length).toBe(afterAdopt); // never switched away
  });

  it("switches only after failureThreshold consecutive failures", async () => {
    const h = harness(stickyPolicy({ failureThreshold: 3 }));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A
    const base = h.selected.length;
    // A now dead, B healthy.
    h.setProbe((n) => (n === "A" ? null : 25));
    for (let i = 1; i <= 2; i++) {
      h.setClock(i * 60_000);
      await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    }
    expect(h.selected.length).toBe(base); // 2 failures < threshold: still holding
    h.setClock(3 * 60_000);
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("×3");
  });

  it("throttles health checks to intervalSec (a failure within the interval does not count)", async () => {
    const h = harness(stickyPolicy({ failureThreshold: 1, intervalSec: 60 }));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A at t=0
    const base = h.selected.length;
    h.setProbe((n) => (n === "A" ? null : 25));
    h.setClock(30_000); // < interval: skipped
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.length).toBe(base); // not checked yet
    h.setClock(60_000); // interval elapsed: one failure, threshold 1 → switch
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.at(-1)).toBe("B");
  });

  it("re-picks after maxHoldHours even while healthy", async () => {
    const h = harness(stickyPolicy({ maxHoldHours: 1 }));
    h.setProbe((n) => (n === "B" ? 10 : 90)); // B fastest
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A at t=0
    h.setClock(60 * 60_000 + 60_000); // > 1h later
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("max-hold");
  });
});

describe("ChannelController speed (passive)", () => {
  const speedPolicy = (): ChannelPolicy => ({
    kind: "speed",
    testUrl: "https://probe",
    intervalSec: 30,
    toleranceMs: 50,
    reevaluateWhileHealthy: true,
  });

  it("records a reason when AUTO.now moves, with the delta", async () => {
    const h = harness(speedPolicy());
    const v1: NodeView = {
      now: "AUTO",
      autoNow: "A",
      all: [node("A", 180), node("B", 40)],
    };
    await h.ctrl.tick(v1); // establishes lastSpeedNow = A, no reason yet
    expect(h.reasons.length).toBe(0);
    await h.ctrl.tick({ ...v1, autoNow: "B" });
    expect(h.reasons.at(-1)?.reason).toContain("A → B");
    expect(h.reasons.at(-1)?.reason).toContain("40");
    expect(h.selected.length).toBe(0); // speed is passive: never calls select
  });
});

describe("ChannelController manual", () => {
  const manualPolicy = (onFailure: "hold" | "fallback"): ChannelPolicy => ({
    kind: "manual",
    pinnedNode: "A",
    onFailure,
  });

  it("selects the pinned node when AUTO points elsewhere", async () => {
    const h = harness(manualPolicy("hold"));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "B"));
    expect(h.selected.at(-1)).toBe("A");
  });

  it("falls back to another node when the pin is down and onFailure=fallback", async () => {
    const h = harness(manualPolicy("fallback"));
    h.setProbe((n) => (n === "A" ? null : 20));
    // AUTO currently sits on the dead pin "A": the fallback to "B" is a genuine
    // node change, so apply() must actually call select("B").
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("fell back");
  });
});

describe("ChannelController reset", () => {
  it("clears transient control state so the next tick re-adopts instead of misfiring max-hold", async () => {
    const h = harness(stickyPolicy({ maxHoldHours: 1 }));
    h.setProbe(() => 30); // always healthy
    // Adopt A and pin its hold window at t=0.
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    const afterAdopt = h.selected.length;

    // Advance close to (but under) maxHoldHours, then reset — this must drop
    // heldSince so the next tick starts a fresh hold window instead of treating
    // the policy-change moment as if the node had been held since t=0.
    h.setClock(59 * 60_000);
    h.ctrl.reset();

    // Jump past what would have been the max-hold deadline from the stale
    // heldSince (t=0 + 1h). If reset() didn't clear heldSince, this tick would
    // force a re-pick ("max-hold" reason). With state cleared, heldSince is
    // re-adopted fresh at this tick and no re-pick fires.
    h.setClock(61 * 60_000);
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.length).toBe(afterAdopt); // no extra select — stale hold window did not misfire
    expect(h.reasons.length).toBe(0); // no max-hold re-pick was recorded either
  });

  it("clears the failure counter so a single post-reset failure does not immediately switch", async () => {
    const h = harness(stickyPolicy({ failureThreshold: 3 }));
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A")); // adopt A
    const base = h.selected.length;

    // Accumulate 2 failures (below threshold 3).
    h.setProbe((n) => (n === "A" ? null : 25));
    h.setClock(60_000);
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    h.setClock(120_000);
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.length).toBe(base); // still holding, below threshold

    h.ctrl.reset();

    // One more failure right after reset must not switch — reset should have
    // zeroed the counter, so this is failure 1/3, not 3/3.
    h.setClock(180_000);
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"));
    expect(h.selected.length).toBe(base); // no switch: counter was cleared by reset
  });

  it("does not clear the decision log", async () => {
    const h = harness(stickyPolicy());
    // No valid pre-existing pin → this tick logs an "initial pick" decision.
    await h.ctrl.tick(view(["AUTO", "A", "B"], null));
    const before = h.ctrl.recent();
    expect(before.length).toBeGreaterThan(0);
    h.ctrl.reset();
    expect(h.ctrl.recent()).toEqual(before);
  });
});
