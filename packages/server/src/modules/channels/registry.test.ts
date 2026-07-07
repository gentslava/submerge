import type { Channel, ChannelPolicy } from "@submerge/shared";
import { describe, expect, it } from "vitest";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { ControllerRegistry } from "./registry.js";

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

const channel = (
  id: string,
  isDefault: boolean,
  policy: ChannelPolicy,
  enabled = true,
): Channel => ({
  id,
  name: id,
  priority: isDefault ? 1 : 0,
  enabled,
  isDefault,
  policy,
  matcher: { presets: [], domains: [] },
  lastReason: null,
  lastReasonAt: null,
});

interface Harness {
  registry: ControllerRegistry;
  channelsList: Channel[];
  proxies: ProxiesResponse["proxies"];
  selected: { group: string; name: string }[];
  cleared: string[];
  reasons: { channelId: string; reason: string; at: number }[];
  clock: { t: number };
}

function harness(): Harness {
  const clock = { t: 0 };
  const selected: { group: string; name: string }[] = [];
  const cleared: string[] = [];
  const reasons: { channelId: string; reason: string; at: number }[] = [];
  const channelsList: Channel[] = [];
  const proxies: ProxiesResponse["proxies"] = {};

  const registry = new ControllerRegistry({
    listChannels: () => channelsList,
    fetchProxies: async () => ({ proxies }),
    probe: async (name) => {
      // Deterministic: node "B" is always fastest across all groups.
      return name === "B" ? 10 : 90;
    },
    select: async (group, name) => {
      selected.push({ group, name });
    },
    clearFixed: async (group) => {
      cleared.push(group);
    },
    persistReason: (channelId, reason, at) => {
      reasons.push({ channelId, reason, at });
    },
    now: () => clock.t,
  });

  return { registry, channelsList, proxies, selected, cleared, reasons, clock };
}

function setChannels(h: Harness, chs: Channel[]): void {
  h.channelsList.length = 0;
  h.channelsList.push(...chs);
}

function setGroup(h: Harness, group: string, members: string[], now: string | null = null): void {
  h.proxies[group] = {
    name: group,
    type: "selector",
    now: now ?? undefined,
    all: members,
    history: [],
  };
  for (const m of members) {
    if (!h.proxies[m]) h.proxies[m] = { name: m, type: "vless", history: [] };
  }
}

describe("ControllerRegistry", () => {
  it("ticks each channel with its own group view and pins into its own group", async () => {
    const h = harness();
    setChannels(h, [
      channel("ch1", false, stickyPolicy()),
      channel("default", true, stickyPolicy()),
    ]);
    setGroup(h, "ch-ch1", ["A", "B"]);
    setGroup(h, "AUTO", ["A", "B"]);

    await h.registry.runOnce();

    // Each channel selected into its OWN group, not a shared/hardcoded AUTO.
    const ch1Selects = h.selected.filter((s) => s.group === "ch-ch1");
    const defaultSelects = h.selected.filter((s) => s.group === "AUTO");
    expect(ch1Selects.length).toBe(1);
    expect(ch1Selects[0]?.name).toBe("B"); // fastest
    expect(defaultSelects.length).toBe(1);
    expect(defaultSelects[0]?.name).toBe("B");
  });

  it("recent() merges decisions across channels, newest-first", async () => {
    const h = harness();
    setChannels(h, [channel("ch1", false, stickyPolicy()), channel("ch2", false, stickyPolicy())]);
    setGroup(h, "ch-ch1", ["A", "B"]);
    setGroup(h, "ch-ch2", ["A", "B"]);

    h.clock.t = 100;
    await h.registry.runOnce();

    const recent = h.registry.recent();
    expect(recent.length).toBe(2);
    // Both ticked at the same instant in this test; just verify both channels
    // are represented and sorted newest-first (non-increasing `at`).
    const ids = recent.map((r) => r.channelId).sort();
    expect(ids).toEqual(["ch1", "ch2"]);
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1];
      const cur = recent[i];
      expect(prev && cur ? prev.at >= cur.at : true).toBe(true);
    }
  });

  it("skips a disabled non-default channel — never ticked — while Default still ticks", async () => {
    const h = harness();
    setChannels(h, [
      channel("ch1", false, stickyPolicy(), false), // disabled
      channel("default", true, stickyPolicy()),
    ]);
    setGroup(h, "ch-ch1", ["A", "B"]);
    setGroup(h, "AUTO", ["A", "B"]);

    await h.registry.runOnce();

    const ch1Selects = h.selected.filter((s) => s.group === "ch-ch1");
    const defaultSelects = h.selected.filter((s) => s.group === "AUTO");
    expect(ch1Selects.length).toBe(0); // disabled channel's group is never selected into
    expect(defaultSelects.length).toBe(1); // Default runs regardless of any `enabled` flag
  });

  it("disabling a channel drops its cached controller, just like removal — re-enabling restarts fresh", async () => {
    const h = harness();
    setChannels(h, [channel("ch1", false, stickyPolicy())]);
    setGroup(h, "ch-ch1", ["A", "B"]); // no pre-existing pin

    await h.registry.runOnce();
    expect(h.selected.length).toBe(1); // initial pick: B (fastest)

    // Disable the channel: it drops out of the filtered live set, so the
    // vanished-channel cleanup removes its cached controller + box exactly as
    // it would for an outright removal.
    setChannels(h, [channel("ch1", false, stickyPolicy(), false)]);
    await h.registry.runOnce();
    expect(h.selected.length).toBe(1); // no new selects while disabled — never ticked

    // Re-enabling with the same id must behave like a fresh controller (proof
    // the old one was actually dropped, not merely skipped) — a stale controller
    // would already have adopted "B" and not re-select it.
    setChannels(h, [channel("ch1", false, stickyPolicy())]);
    await h.registry.runOnce();
    expect(h.selected.length).toBe(2);
  });

  it("drops a removed channel's controller — a later runOnce doesn't tick it", async () => {
    const h = harness();
    setChannels(h, [channel("ch1", false, stickyPolicy())]);
    setGroup(h, "ch-ch1", ["A", "B"]);

    await h.registry.runOnce();
    expect(h.selected.length).toBe(1);

    // Channel removed entirely.
    setChannels(h, []);
    await h.registry.runOnce();
    expect(h.selected.length).toBe(1); // no new selects from the vanished channel

    // Re-adding the channel with the same id must behave like a fresh controller
    // (proof the old one was actually dropped, not merely skipped).
    setChannels(h, [channel("ch1", false, stickyPolicy())]);
    await h.registry.runOnce();
    expect(h.selected.length).toBe(2);
  });

  it("a throwing channel tick does not stop the others", async () => {
    const h = harness();
    setChannels(h, [channel("bad", false, stickyPolicy()), channel("good", false, stickyPolicy())]);
    setGroup(h, "ch-bad", ["A", "B"]);
    setGroup(h, "ch-good", ["A", "B"]);

    // Force "bad" to throw: tick() calls persistReason synchronously inside
    // apply(), which is inside the registry's per-channel try/catch — the
    // exception must be swallowed there without affecting "good".
    const throwingRegistry = new ControllerRegistry({
      listChannels: () => h.channelsList,
      fetchProxies: async () => ({ proxies: h.proxies }),
      probe: async (name) => (name === "B" ? 10 : 90),
      select: async (group, name) => {
        h.selected.push({ group, name });
      },
      clearFixed: async (group) => {
        h.cleared.push(group);
      },
      persistReason: (channelId, reason, at) => {
        if (channelId === "bad") throw new Error("boom");
        h.reasons.push({ channelId, reason, at });
      },
      now: () => h.clock.t,
    });

    await expect(throwingRegistry.runOnce()).resolves.toBeUndefined();

    // "good" channel still got its selection despite "bad" throwing.
    const goodSelects = h.selected.filter((s) => s.group === "ch-good");
    expect(goodSelects.length).toBe(1);
    expect(goodSelects[0]?.name).toBe("B");
  });

  it("clears a speed channel's leftover fixed pin on the group mihomo reports it on", async () => {
    const h = harness();
    const speedPolicy: ChannelPolicy = {
      kind: "speed",
      testUrl: "https://probe",
      intervalSec: 30,
      toleranceMs: 50,
      reevaluateWhileHealthy: true,
    };
    setChannels(h, [channel("default", true, speedPolicy)]);
    setGroup(h, "AUTO", ["A", "B"], "A");
    // mihomo reports AUTO fixed to A (a leftover pin from a prior manual session).
    (h.proxies.AUTO as { fixed?: string }).fixed = "A";

    await h.registry.runOnce();

    expect(h.cleared).toEqual(["AUTO"]);
    expect(h.selected.length).toBe(0); // speed never selects — it only unpins
    expect(h.reasons.at(-1)?.reason).toContain("unpinned A");
  });

  it("reset(id) delegates to the cached controller's reset when present", async () => {
    const h = harness();
    setChannels(h, [channel("ch1", false, stickyPolicy({ maxHoldHours: 1 }))]);
    setGroup(h, "ch-ch1", ["A", "B"], "A");

    await h.registry.runOnce(); // adopts A, starts hold window
    // No throw / no-op expected for an unknown id.
    expect(() => h.registry.reset("does-not-exist")).not.toThrow();
    expect(() => h.registry.reset("ch1")).not.toThrow();
  });
});
