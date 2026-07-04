import {
  type Channel,
  type ChannelPolicy,
  type DecisionEntry,
  type NodeItem,
  type NodeView,
  PSEUDO_NODE_SET,
} from "@submerge/shared";
import type { ProxiesResponse } from "../../clients/mihomo.js";
import { policyProbe } from "./service.js";

// The real exit nodes a channel can pin, in view order.
export function selectableNames(view: NodeView): string[] {
  return view.all.map((n) => n.name).filter((n) => !PSEUDO_NODE_SET.has(n));
}

// Probe one candidate `samples` times; return { ok, latency } where ok is the
// number of successful probes and latency is the mean of successful probes
// (Infinity if none succeeded).
async function score(
  name: string,
  url: string,
  samples: number,
  probe: (name: string, url: string) => Promise<number | null>,
): Promise<{ ok: number; latency: number }> {
  let ok = 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const d = await probe(name, url);
    if (d != null && d > 0) {
      ok++;
      sum += d;
    }
  }
  return { ok, latency: ok > 0 ? sum / ok : Number.POSITIVE_INFINITY };
}

// Pick the best candidate. `fastest` = one probe each, lowest latency. `lowest-loss`
// = `samples` probes each, ranked by success count then mean latency. Falls back to
// the first name if every candidate is unreachable (best-effort — never returns a
// name outside `names`). Returns null only for an empty list.
export async function pickBest(
  names: string[],
  url: string,
  criterion: "fastest" | "lowest-loss",
  probe: (name: string, url: string) => Promise<number | null>,
  samples = 3,
): Promise<string | null> {
  if (names.length === 0) return null;
  const n = criterion === "lowest-loss" ? samples : 1;
  let best: string | null = null;
  let bestOk = -1;
  let bestLatency = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const s = await score(name, url, n, probe);
    if (s.ok > bestOk || (s.ok === bestOk && s.latency < bestLatency)) {
      best = name;
      bestOk = s.ok;
      bestLatency = s.latency;
    }
  }
  // Every candidate failed (bestOk === 0) → keep the deterministic first choice.
  return best ?? (names[0] as string);
}

export interface ControllerDeps {
  readChannel: () => Channel;
  // The mihomo select-group this channel pins into (e.g. "AUTO" for the default
  // channel, "ch-<id>" for a routed channel with its own group).
  group: string;
  probe: (name: string, url: string) => Promise<number | null>; // null = timeout/unreachable
  select: (group: string, name: string) => Promise<void>;
  persistReason: (reason: string, at: number) => void;
  now: () => number;
  ringSize?: number;
}

// Normalize an arbitrary mihomo select group into a NodeView. Unlike `toNodeView`
// (nodes/service.ts), this is intentionally minimal: the controller only reads
// `autoNow` (the group's current selection) and `selectableNames(view)` (member
// names + delay for pickBest) — no collapsed-group/meta/udp handling needed here.
export function toGroupView(proxies: ProxiesResponse["proxies"], group: string): NodeView {
  const g = proxies[group];
  if (!g?.all) return { now: null, autoNow: null, all: [] };
  const all: NodeItem[] = g.all.map((name) => {
    const info = proxies[name];
    const last = info?.history.at(-1);
    return {
      name,
      type: info?.type ?? "unknown",
      delay: last && last.delay > 0 ? last.delay : null,
      history: (info?.history ?? []).map((h) => h.delay),
    };
  });
  return { now: g.now ?? null, autoNow: g.now ?? null, all };
}

export class ChannelController {
  private failures = 0;
  private heldSince: number | null = null;
  // -Infinity (not 0) so the very first tick always runs the health check,
  // even when the injected clock also starts at 0 (as in tests).
  private lastCheck = Number.NEGATIVE_INFINITY;
  private lastSpeedNow: string | null = null;
  private log: DecisionEntry[] = [];

  constructor(private deps: ControllerDeps) {}

  recent(): DecisionEntry[] {
    return [...this.log].reverse(); // newest first
  }

  // Clear only the transient control state — not the decision log. Call this when
  // the channel's policy changes at runtime (e.g. channels.setPolicy) so stale state
  // from the previous policy session doesn't leak into the new one: a leftover
  // `heldSince` could misfire `maxHoldHours`, a leftover `failures` count could
  // shorten the next failover, and a stale `lastCheck` could skip the first check.
  reset(): void {
    this.failures = 0;
    this.heldSince = null;
    this.lastCheck = Number.NEGATIVE_INFINITY;
    this.lastSpeedNow = null;
  }

  protected record(entry: DecisionEntry): void {
    this.log.push(entry);
    const cap = this.deps.ringSize ?? 20;
    if (this.log.length > cap) this.log.splice(0, this.log.length - cap);
    this.deps.persistReason(entry.reason, entry.at);
  }

  // Apply a decision: select the node in mihomo (only if it actually changes),
  // reset the hold window, and record the reason. The reason is always recorded
  // — even when `to` equals `from` — so callers can call this unconditionally
  // and still get a decision logged without issuing a redundant mihomo select.
  protected async apply(
    channelId: string,
    from: string | null,
    to: string,
    reason: string,
    at: number,
  ): Promise<void> {
    if (to !== from) await this.deps.select(this.deps.group, to);
    this.heldSince = at;
    this.record({ at, channelId, from, to, reason });
  }

  async tick(view: NodeView): Promise<void> {
    const channel = this.deps.readChannel();
    const policy = channel.policy;
    if (policy.kind === "speed") {
      this.tickSpeed(view, channel.id); // Task 4
      return;
    }
    // Active policies (sticky/manual) health-check on the channel's own cadence,
    // not every poll — throttle to intervalSec (1 s slack for poll jitter).
    const { url, intervalSec } = policyProbe(policy);
    const t = this.deps.now();
    if (t - this.lastCheck < intervalSec * 1000 - 1000) return;
    this.lastCheck = t;
    if (policy.kind === "manual") {
      await this.tickManual(view, channel.id, policy, url, t); // Task 4
      return;
    }
    await this.tickSticky(view, channel.id, policy, url, t);
  }

  private async tickSticky(
    view: NodeView,
    channelId: string,
    policy: Extract<ChannelPolicy, { kind: "sticky" }>,
    url: string,
    at: number,
  ): Promise<void> {
    const candidates = selectableNames(view);
    if (candidates.length === 0) return;
    const active = view.autoNow;

    // No valid pin yet → choose the best node and pin it.
    if (!active || !candidates.includes(active)) {
      const best = await pickBest(candidates, url, policy.initialCriterion, this.deps.probe);
      if (best) await this.apply(channelId, active, best, `initial pick: ${best}`, at);
      this.failures = 0;
      return;
    }

    // Adopt a pre-existing valid pin without switching (start its hold window).
    if (this.heldSince === null) this.heldSince = at;

    // Forced refresh after max-hold, even while healthy.
    if (policy.maxHoldHours != null && at - this.heldSince >= policy.maxHoldHours * 3_600_000) {
      const best = await pickBest(candidates, url, policy.initialCriterion, this.deps.probe);
      if (best && best !== active) {
        await this.apply(channelId, active, best, `max-hold ${policy.maxHoldHours}h reached`, at);
        this.failures = 0;
        return;
      }
      this.heldSince = at; // same node stayed best — reset the window, keep holding
    }

    // Health-check the pinned node; count consecutive failures.
    const d = await this.deps.probe(active, url);
    if (d == null || d <= 0) this.failures++;
    else this.failures = 0;

    if (this.failures >= policy.failureThreshold) {
      const others = candidates.filter((c) => c !== active);
      const best =
        (await pickBest(others, url, policy.initialCriterion, this.deps.probe)) ?? active;
      await this.apply(channelId, active, best, `${active} failed ×${this.failures}`, at);
      this.failures = 0;
    }
  }

  // Passive: mihomo's url-test owns the switch; we only record WHY it moved.
  private tickSpeed(view: NodeView, channelId: string): void {
    const active = view.autoNow;
    if (this.lastSpeedNow && active && active !== this.lastSpeedNow) {
      const to = view.all.find((n) => n.name === active);
      const from = view.all.find((n) => n.name === this.lastSpeedNow);
      const delta =
        to?.delay != null && from?.delay != null ? ` (${to.delay} vs ${from.delay} ms)` : "";
      const at = this.deps.now();
      this.record({
        at,
        channelId,
        from: this.lastSpeedNow,
        to: active,
        reason: `faster: ${this.lastSpeedNow} → ${active}${delta}`,
      });
    }
    if (active) this.lastSpeedNow = active;
  }

  // Active: keep AUTO pinned to the chosen node; optionally fall back if it's down.
  private async tickManual(
    view: NodeView,
    channelId: string,
    policy: Extract<ChannelPolicy, { kind: "manual" }>,
    url: string,
    at: number,
  ): Promise<void> {
    const active = view.autoNow;
    const pin = policy.pinnedNode;
    const candidates = selectableNames(view);
    if (policy.onFailure === "fallback") {
      const d = await this.deps.probe(pin, url);
      if (d == null || d <= 0) {
        const others = candidates.filter((c) => c !== pin);
        const best = await pickBest(others, url, "fastest", this.deps.probe);
        if (best) {
          // apply() always records the fallback reason; it only re-issues the
          // mihomo select when `best` differs from the currently active node.
          await this.apply(channelId, active, best, `${pin} down; fell back to ${best}`, at);
          return;
        }
      }
    }
    if (active !== pin) await this.apply(channelId, active, pin, `pinned ${pin}`, at);
  }
}
