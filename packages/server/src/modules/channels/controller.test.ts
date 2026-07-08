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
  // The EWMA window is now sample-based (α = 1 − 2^(−1/8) ≈ 0.083), independent of
  // intervalSec — so intervalSec here only drives the tick throttle (10 s → advance the
  // clock by 10 000 ms between ticks). The switch margin is RELATIVE (10 % of the active
  // node's eff), not a fixed ms.
  const optimalPolicy = (
    over: Partial<Extract<ChannelPolicy, { kind: "optimal" }>> = {},
  ): ChannelPolicy => ({
    kind: "optimal",
    testUrl: "https://probe",
    intervalSec: 10,
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

  it("holds while a challenger's lead stays under the relative margin (< 10 %)", async () => {
    const h = harness(optimalPolicy());
    // B is 7.5 % faster (185 vs 200) — under the 10 % margin → no switch.
    await h.ctrl.tick(vw("A", { A: 200, B: 185 }));
    expect(h.selected.length).toBe(0);
  });

  it("proactively switches when a challenger beats the active node by the relative margin", async () => {
    const h = harness(optimalPolicy());
    // B is 15 % faster (170 vs 200) → over the 10 % margin → switch (no death needed).
    await h.ctrl.tick(vw("A", { A: 200, B: 170 }));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("A → B");
  });

  it("scales the margin with the fleet: a slow fleet needs a bigger absolute gap", async () => {
    // Slow fleet, 5 % gap (950 vs 1000) → held; 20 % gap (800 vs 1000) → switched. The same
    // 50 ms gap that would flap here is ignored — the margin is a %, not a fixed ms.
    const hold = harness(optimalPolicy());
    await hold.ctrl.tick(vw("A", { A: 1000, B: 950 }));
    expect(hold.selected.length).toBe(0);

    const move = harness(optimalPolicy());
    await move.ctrl.tick(vw("A", { A: 1000, B: 800 }));
    expect(move.selected.at(-1)).toBe("B");
  });

  it("penalizes a flaky challenger: a fast-but-dropping node does not displace a solid active one", async () => {
    // A active + solid (100 ms). B is raw-fast (50 ms) but drops a probe first, so its
    // success EWMA is low → effLatency(B) = 50 / max(success, ε) is inflated well above A,
    // and B never steals traffic. (The penalty is on the challenger; a failing ACTIVE node
    // is handled by the liveness / slow escapes instead.)
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 100, B: null })); // B miss → success 0
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: 100, B: 50 })); // B fast but success ≈ 0.08 → eff ≈ 600
    expect(h.selected.length).toBe(0);
  });

  it("slow-but-alive escape: leaves an active node that stays much slower than the best (no death)", async () => {
    // A and B start equal (200). A jumps to 320 (60 % worse) — proactive catches it on the
    // first tick via max(eff, raw); no need to wait for the 2-tick slow streak.
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 200, B: 200 }));
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: 320, B: 200 }));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("A → B");
  });

  it("slow-but-alive escape: moderate gap uses the 2-tick streak when challenger eff is inflated", async () => {
    // B is raw-fast but was flaky → high eff, so proactive (eff-based margin) holds while
    // the raw-to-raw slow escape (275 > 200 × 1.35) fires after 2 ticks.
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 200, B: null })); // B flaky → eff inflated later
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: 200, B: 200 }));
    h.setClock(20_000);
    await h.ctrl.tick(vw("A", { A: 275, B: 200 })); // slow tick 1
    expect(h.selected.length).toBe(0);
    h.setClock(30_000);
    await h.ctrl.tick(vw("A", { A: 275, B: 200 })); // slow tick 2 → switch
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("slow");
  });

  it("flees a huge spike immediately (proactive path, no 2-tick wait)", async () => {
    // A active + best; then one enormous spike (2878 vs B 300) lifts A's score past the 10 %
    // margin on the SAME tick → proactive switch fires at once (not the slow path).
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 300, B: 320 })); // A best → hold
    expect(h.selected.length).toBe(0);
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: 2878, B: 300 }));
    expect(h.selected.at(-1)).toBe("B");
  });

  it("switches when EWMA lags behind a moderate spike (good history, bad current ping)", async () => {
    // Fleet-speed gap from prod: A held at ~280 ms eff, then spikes to 358 ms raw while B
    // answers ~259 ms. activeEff is still low (good history) so the old margin never fired;
    // max(eff, raw) must see the spike and move on the first tick.
    const h = harness(optimalPolicy());
    for (let i = 0; i < 12; i++) {
      if (i > 0) h.setClock(i * 10_000);
      await h.ctrl.tick(vw("A", { A: 280, B: 265 }));
    }
    h.setClock(120_000);
    await h.ctrl.tick(vw("A", { A: 358, B: 259 }));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("A → B");
  });

  it("does not flap back the instant the abandoned node recovers", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 300, B: 320 }));
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: 2878, B: 300 })); // A → B
    expect(h.selected.at(-1)).toBe("B");
    const afterSwitch = h.selected.length;
    // A recovers to 300; B is now active at 300. A's eff is still elevated by the spike, so
    // it does NOT beat B by 10 % → no immediate flap back.
    h.setClock(20_000);
    await h.ctrl.tick(vw("B", { A: 300, B: 300 }));
    expect(h.selected.length).toBe(afterSwitch);
  });

  it("slow-but-alive debounces: a single slow tick between healthy ticks never switches", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 200, B: null }));
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: 200, B: 200 })); // B recovers but eff stays inflated
    h.setClock(20_000);
    await h.ctrl.tick(vw("A", { A: 275, B: 200 })); // slow tick 1
    h.setClock(30_000);
    await h.ctrl.tick(vw("A", { A: 200, B: 200 })); // healthy → resets the streak
    h.setClock(40_000);
    await h.ctrl.tick(vw("A", { A: 275, B: 200 })); // slow tick 1 again (not 2)
    expect(h.selected.length).toBe(0);
  });

  it("reset() clears the EWMA window so a stale penalty doesn't carry over", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 100, B: null })); // B miss → success 0
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: 100, B: null })); // B miss → still 0
    const beforeReset = h.selected.length;

    h.ctrl.reset(); // wipes per-node EWMA + counters

    h.setClock(20_000);
    // Fresh window: B seeds at 40 ms (eff 40) and beats A 100 by 60 % → switch. Without
    // reset, B's decayed success would keep its effective latency far above A's.
    await h.ctrl.tick(vw("A", { A: 100, B: 40 }));
    expect(h.selected.length).toBe(beforeReset + 1);
    expect(h.selected.at(-1)).toBe("B");
  });

  it("holds the active node when no candidate has a measurement yet (no NaN-driven switch)", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("B", { A: null, B: null }));
    expect(h.selected.length).toBe(0);
  });

  it("re-picks when the active node is no longer among the candidates", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("Z", { A: 100, B: 40 }));
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("initial");
  });

  it("flees a dead active node on the FIRST timeout (liveness failover)", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 100, B: 120 })); // A active + healthy, B worse → hold
    expect(h.selected.length).toBe(0);
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: null, B: 120 })); // A times out once → flee to reachable B
    expect(h.selected.at(-1)).toBe("B");
    expect(h.reasons.at(-1)?.reason).toContain("down");
  });

  it("holds when the active node times out but nothing else is reachable either", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 100, B: 120 }));
    h.setClock(10_000);
    await h.ctrl.tick(vw("A", { A: null, B: null }));
    expect(h.selected.length).toBe(0);
  });

  it("does not switch while the active node stays the best", async () => {
    const h = harness(optimalPolicy());
    await h.ctrl.tick(vw("A", { A: 100, B: 120 }));
    for (let i = 1; i <= 5; i++) {
      h.setClock(i * 10_000);
      await h.ctrl.tick(vw("A", { A: 100, B: 120 }));
    }
    expect(h.selected.length).toBe(0);
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
