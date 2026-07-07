import type { Channel, ChannelPolicy, NodeItem, NodeView } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { ChannelController, pickBest, selectableNames, toGroupView } from "./controller.js";

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

describe("toGroupView", () => {
  const proxies = (): ProxiesResponse["proxies"] => ({
    "ch-media": { name: "ch-media", type: "selector", now: "A", all: ["A", "B"], history: [] },
    A: { name: "A", type: "vless", history: [{ time: "t1", delay: 120 }] },
    // A timeout (delay 0) in the last measurement collapses to null delay — this
    // helper intentionally does not preserve the timeout-vs-unmeasured distinction
    // that toNodeView keeps for the UI; the controller only needs a truthy/absent
    // health signal.
    B: { name: "B", type: "vless", history: [{ time: "t1", delay: 0 }] },
  });

  it("normalizes an arbitrary group's members with now/autoNow/delay/history", () => {
    expect(toGroupView(proxies(), "ch-media")).toEqual({
      now: "A",
      autoNow: "A",
      all: [
        { name: "A", type: "vless", delay: 120, history: [120] },
        { name: "B", type: "vless", delay: null, history: [0] },
      ],
    });
  });

  it("returns an empty view for a group that doesn't exist or has no members", () => {
    expect(toGroupView(proxies(), "ch-missing")).toEqual({ now: null, autoNow: null, all: [] });
  });

  it("reads the per-URL history for the given test URL, falling back to the shared one", () => {
    const px: ProxiesResponse["proxies"] = {
      "ch-x": { name: "ch-x", type: "selector", now: "A", all: ["A", "B"], history: [] },
      A: {
        name: "A",
        type: "vless",
        history: [{ time: "t", delay: 999 }], // shared: a stale probe on another URL
        extra: { "https://u": { alive: true, history: [{ time: "t", delay: 120 }] } },
      },
      // No extra for B → fall back to the shared history.
      B: { name: "B", type: "vless", history: [{ time: "t", delay: 55 }] },
    };
    expect(toGroupView(px, "ch-x", "https://u")).toEqual({
      now: "A",
      autoNow: "A",
      all: [
        { name: "A", type: "vless", delay: 120, history: [120] },
        { name: "B", type: "vless", delay: 55, history: [55] },
      ],
    });
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
  selectedGroups: string[];
  clearedGroups: string[];
  reasons: { reason: string; at: number }[];
  setClock: (t: number) => void;
  setProbe: (fn: (name: string) => number | null) => void;
}

function harness(policy: ChannelPolicy, group = "AUTO"): Harness {
  let clock = 0;
  let probeFn: (name: string) => number | null = () => 50;
  const selected: string[] = [];
  const selectedGroups: string[] = [];
  const clearedGroups: string[] = [];
  const reasons: { reason: string; at: number }[] = [];
  const ctrl = new ChannelController({
    readChannel: () => channel(policy),
    group,
    probe: async (name) => probeFn(name),
    select: async (g, name) => {
      selectedGroups.push(g);
      selected.push(name);
    },
    clearFixed: async (g) => {
      clearedGroups.push(g);
    },
    persistReason: (reason, at) => reasons.push({ reason, at }),
    now: () => clock,
  });
  return {
    ctrl,
    selected,
    selectedGroups,
    clearedGroups,
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

  it("selects into the channel's configured group, not a hardcoded AUTO", async () => {
    const h = harness(stickyPolicy(), "ch-media");
    h.setProbe((n) => (n === "B" ? 20 : 90));
    await h.ctrl.tick(view(["AUTO", "A", "B"], null));
    expect(h.selectedGroups).toEqual(["ch-media"]);
    expect(h.selected).toEqual(["B"]);
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

  it("never clears a fixed pin — sticky manages its own selection", async () => {
    const h = harness(stickyPolicy());
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"), "A");
    expect(h.clearedGroups).toEqual([]); // clearing is speed-only
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

  it("clears a leftover fixed pin so the url-test group resumes racing", async () => {
    const h = harness(speedPolicy());
    const v: NodeView = { now: "AUTO", autoNow: "A", all: [node("A", 180), node("B", 40)] };
    // The group is fixed to A (a pin left over from a prior manual/sticky session).
    await h.ctrl.tick(v, "A");
    expect(h.clearedGroups).toEqual(["AUTO"]);
    expect(h.reasons.at(-1)?.reason).toContain("unpinned A");
    expect(h.selected.length).toBe(0); // never selects — only unpins
  });

  it("does not record a passive delta on the same tick it clears a pin", async () => {
    const h = harness(speedPolicy());
    // autoNow is B but the group is still fixed to A: clearing takes priority, and
    // the move is recorded next tick (once the race actually resumes), not now.
    await h.ctrl.tick({ now: "AUTO", autoNow: "B", all: [node("A", 180), node("B", 40)] }, "A");
    expect(h.clearedGroups).toEqual(["AUTO"]);
    expect(h.reasons.at(-1)?.reason).toContain("unpinned A");
    expect(h.reasons.at(-1)?.reason).not.toContain("→");
  });

  it("clears the channel's configured group, not a hardcoded AUTO", async () => {
    const h = harness(speedPolicy(), "ch-media");
    await h.ctrl.tick({ now: "AUTO", autoNow: "A", all: [node("A", 40)] }, "A");
    expect(h.clearedGroups).toEqual(["ch-media"]);
  });

  it("does not re-clear or re-log a pin that persists across ticks (store-selected cache)", async () => {
    const h = harness(speedPolicy());
    const v: NodeView = { now: "AUTO", autoNow: "A", all: [node("A", 180), node("B", 40)] };
    // mihomo keeps reporting the same fixed pin on every poll (a stubborn cache).
    await h.ctrl.tick(v, "A");
    await h.ctrl.tick(v, "A");
    await h.ctrl.tick(v, "A");
    expect(h.clearedGroups).toEqual(["AUTO"]); // cleared exactly once
    expect(h.reasons.filter((r) => r.reason.includes("unpinned")).length).toBe(1);
  });

  it("handles a genuinely new pin after the group has raced freely again", async () => {
    const h = harness(speedPolicy());
    const nodes = [node("A", 180), node("B", 40)];
    await h.ctrl.tick({ now: "AUTO", autoNow: "A", all: nodes }, "A"); // clear A
    await h.ctrl.tick({ now: "AUTO", autoNow: "B", all: nodes }, null); // racing freely
    await h.ctrl.tick({ now: "AUTO", autoNow: "B", all: nodes }, "B"); // new pin B
    expect(h.clearedGroups).toEqual(["AUTO", "AUTO"]);
    expect(h.reasons.filter((r) => r.reason.includes("unpinned")).length).toBe(2);
  });
});

describe("ChannelController optimal", () => {
  const optimalPolicy = (
    over: Partial<Extract<ChannelPolicy, { kind: "optimal" }>> = {},
  ): ChannelPolicy => ({
    kind: "optimal",
    testUrl: "https://probe",
    intervalSec: 60,
    toleranceMs: 50,
    ...over,
  });

  // Build a group view from an autoNow + a name→delay map (null = miss/timeout).
  const vw = (autoNow: string | null, delays: Record<string, number | null>): NodeView => ({
    now: "AUTO",
    autoNow,
    all: Object.entries(delays).map(([name, d]) => node(name, d)),
  });

  it("initially picks the lowest effective-latency node", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw(null, { A: 200, B: 40 }));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("initial");
  });

  it("holds the active node while a challenger's lead stays within tolerance", async () => {
    const h = harness(optimalPolicy({ toleranceMs: 50 }));
    // A active, B faster by 20 ms — under the 50 ms margin → no switch.
    await h.ctrl.tick(vw("A", { A: 100, B: 80 }));
    expect(h.selected.length).toBe(0);
  });

  it("switches once a challenger beats the active node by more than tolerance", async () => {
    const h = harness(optimalPolicy({ toleranceMs: 50 }));
    await h.ctrl.tick(vw("A", { A: 200, B: 100 })); // 100 ms lead > 50 ms margin
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("A → B");
  });

  it("penalizes a flaky node: a solid slower node out-competes a fast-but-dropping one", async () => {
    // intervalSec=300 → EWMA α=0.5 (fast, deterministic convergence). B always up at
    // 120 ms; A fast (40 ms) but then keeps missing, so its success EWMA decays and its
    // effective latency (40 / success) climbs above B's.
    const h = harness(optimalPolicy({ intervalSec: 300, toleranceMs: 10 }));
    await h.ctrl.tick(vw(null, { A: 40, B: 120 })); // t=0: initial pick A (eff 40 < 120)
    expect(h.selected.at(-1)).toBe("A");
    h.setClock(300_000);
    await h.ctrl.tick(vw("A", { A: null, B: 120 })); // A miss → success 0.5, eff 80 < 120
    expect(h.selected.at(-1)).toBe("A"); // still A
    h.setClock(600_000);
    await h.ctrl.tick(vw("A", { A: null, B: 120 })); // A miss → success 0.25, eff 160 > 120
    expect(h.selected.at(-1)).toBe("B"); // now B out-competes flaky A
  });

  it("reset() clears the EWMA window so a stale penalty doesn't carry over", async () => {
    const h = harness(optimalPolicy({ intervalSec: 300, toleranceMs: 50 }));
    await h.ctrl.tick(vw(null, { A: 100, B: 100 })); // pick A (tie → first)
    h.setClock(300_000);
    await h.ctrl.tick(vw("A", { A: 100, B: null })); // B miss → success 0.5
    h.setClock(600_000);
    await h.ctrl.tick(vw("A", { A: 100, B: null })); // B miss → success 0.25 (eff 400)
    const beforeReset = h.selected.length;

    h.ctrl.reset(); // wipes per-node EWMA

    h.setClock(900_000);
    // Fresh window: B healthy at 40 ms (eff 40) beats A 100 by 60 > 50 → switch.
    // Without reset, B's decayed success would keep its effective latency above A's.
    await h.ctrl.tick(vw("A", { A: 100, B: 40 }));
    expect(h.selected.length).toBe(beforeReset + 1);
    expect(h.selected.at(-1)).toBe("B");
  });

  it("holds the active node when no candidate has a measurement yet (no NaN-driven switch)", async () => {
    const h = harness(optimalPolicy());
    // Both unmeasured → eff +∞; active B valid → activeEff − bestEff is NaN, never > tol.
    await h.ctrl.tick(vw("B", { A: null, B: null }));
    expect(h.selected.length).toBe(0);
  });

  it("re-picks when the active node is no longer among the candidates", async () => {
    const h = harness(optimalPolicy());
    // Active "Z" isn't in the view → treated as no valid pin → initial pick of the best.
    await h.ctrl.tick(vw("Z", { A: 100, B: 40 }));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("initial");
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

  it("never clears a fixed pin — a manual channel's own selection is intentional", async () => {
    const h = harness(manualPolicy("hold"));
    // Even though the group reports a fixed pin, manual must not touch it: the pin
    // IS the policy's intent. Clearing only ever happens under the speed policy.
    await h.ctrl.tick(view(["AUTO", "A", "B"], "A"), "A");
    expect(h.clearedGroups).toEqual([]);
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
