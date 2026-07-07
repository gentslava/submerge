import {
  type Channel,
  type ChannelPolicy,
  type DecisionEntry,
  type NodeItem,
  type NodeView,
  OPTIMAL_EWMA_HALF_LIFE_SEC,
  OPTIMAL_SUCCESS_EPSILON,
  PSEUDO_NODE_SET,
} from "@submerge/shared";
import { historyForUrl, type ProxiesResponse } from "../../clients/mihomo.js";
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
  // Clear the group's manually-pinned ("fixed") member so a url-test group resumes
  // racing (DELETE /proxies/{group}). Only the speed policy needs this — see tickSpeed.
  clearFixed: (group: string) => Promise<void>;
  persistReason: (reason: string, at: number) => void;
  now: () => number;
  ringSize?: number;
}

// Normalize an arbitrary mihomo select group into a NodeView. Unlike `toNodeView`
// (nodes/service.ts), this is intentionally minimal: the controller only reads
// `autoNow` (the group's current selection) and `selectableNames(view)` (member
// names + delay for pickBest) — no collapsed-group/meta/udp handling needed here.
export function toGroupView(
  proxies: ProxiesResponse["proxies"],
  group: string,
  testUrl?: string,
): NodeView {
  const g = proxies[group];
  if (!g?.all) return { now: null, autoNow: null, all: [] };
  const all: NodeItem[] = g.all.map((name) => {
    const info = proxies[name];
    // Read the per-URL series the group actually decides on (falls back to the
    // shared history), so the decision-log delta matches the node cards.
    const h = historyForUrl(info, testUrl);
    const last = h.at(-1);
    return {
      name,
      type: info?.type ?? "unknown",
      delay: last && last.delay > 0 ? last.delay : null,
      history: h.map((e) => e.delay),
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
  // The fixed pin the speed policy has already unpinned + logged, so a pin that
  // stubbornly persists (e.g. mihomo's store-selected cache re-reporting `fixed`
  // after a successful DELETE) doesn't re-clear + re-log every poll. Reset to null
  // once the group is racing freely again (or on reset()), so a genuinely new pin
  // later is still handled. Cleared only AFTER a successful clearFixed, so a
  // thrown DELETE (swallowed by the registry) is retried on the next tick.
  private lastClearedFixed: string | null = null;
  // Per-node EWMA state for the `optimal` policy: smoothed latency (ms, over
  // successful probes) and smoothed success rate (0..1). Combined into an
  // "effective latency" score in tickOptimal. Cleared by reset() on a policy change.
  private optimalLatency = new Map<string, number>();
  private optimalSuccess = new Map<string, number>();
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
    this.lastClearedFixed = null;
    this.optimalLatency.clear();
    this.optimalSuccess.clear();
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

  // `fixed` is the group's manually-pinned member reported by mihomo (the
  // /proxies `fixed` field), or null when the group is racing freely. It only
  // matters to the speed policy — an accidental pin left over from a previous
  // manual/sticky session would otherwise silently freeze the latency race.
  async tick(view: NodeView, fixed: string | null = null): Promise<void> {
    const channel = this.deps.readChannel();
    const policy = channel.policy;
    if (policy.kind === "speed") {
      await this.tickSpeed(view, channel.id, fixed); // Task 4
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
    if (policy.kind === "optimal") {
      await this.tickOptimal(view, channel.id, policy, t);
      return;
    }
    await this.tickSticky(view, channel.id, policy, url, t);
  }

  // Active + statistics-driven: rank candidates by EWMA "effective latency"
  // (smoothed latency penalized by unreliability) and switch only when a challenger
  // beats the active node by more than `toleranceMs` on that smoothed number — so
  // momentary spikes don't cause the url-test flapping the passive `speed` policy has.
  // Latency samples come from the group view (kept fresh by the prober), so this adds
  // no probe traffic of its own. See docs/specs/2026-07-07-optimal-policy-design.md.
  private async tickOptimal(
    view: NodeView,
    channelId: string,
    policy: Extract<ChannelPolicy, { kind: "optimal" }>,
    at: number,
  ): Promise<void> {
    const candidates = selectableNames(view);
    if (candidates.length === 0) return;

    // EWMA smoothing factor from the check interval and a fixed half-life: a shorter
    // interval samples more often, so each sample weighs less to keep the ~5-min window.
    // (α is derived from intervalSec, not the actual tick spacing — tick() throttles to
    // ~intervalSec with 1 s slack on the 5 s poll grid, so the effective half-life drifts
    // slightly for tiny non-multiple intervals. Acceptable for a smoothing window.)
    const alpha = 1 - 2 ** (-policy.intervalSec / OPTIMAL_EWMA_HALF_LIFE_SEC);
    const delayOf = (name: string): number | null => {
      const item = view.all.find((n) => n.name === name);
      return item?.delay != null && item.delay > 0 ? item.delay : null;
    };
    const ewma = (prev: number | undefined, sample: number): number =>
      prev === undefined ? sample : prev + alpha * (sample - prev);

    for (const name of candidates) {
      const d = delayOf(name);
      this.optimalSuccess.set(name, ewma(this.optimalSuccess.get(name), d != null ? 1 : 0));
      // Only successful measurements move the latency EWMA; a miss ages success only.
      if (d != null) this.optimalLatency.set(name, ewma(this.optimalLatency.get(name), d));
    }

    // Effective latency = smoothed latency inflated by unreliability. A never-measured
    // node has no latency yet → +∞ so it's never chosen until it proves reachable.
    // Precompute once per candidate (the argmin + the reason both read it).
    const eff = new Map<string, number>();
    for (const name of candidates) {
      const lat = this.optimalLatency.get(name);
      eff.set(
        name,
        lat === undefined
          ? Number.POSITIVE_INFINITY
          : lat / Math.max(this.optimalSuccess.get(name) ?? 0, OPTIMAL_SUCCESS_EPSILON),
      );
    }
    const effOf = (name: string): number => eff.get(name) ?? Number.POSITIVE_INFINITY;
    // Round for the decision log; "∞" for a still-unmeasured node.
    const num = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : "∞");

    let best = candidates[0] as string;
    for (const name of candidates) if (effOf(name) < effOf(best)) best = name;

    const active = view.autoNow;
    if (!active || !candidates.includes(active)) {
      const suffix = Number.isFinite(effOf(best)) ? ` (${num(effOf(best))} ms eff)` : "";
      await this.apply(channelId, active, best, `initial pick: ${best}${suffix}`, at);
      return;
    }
    const activeEff = effOf(active);
    const bestEff = effOf(best);
    // Infinity − Infinity = NaN and NaN > tol is false, so an all-unmeasured tick
    // correctly holds the active node rather than switching on noise.
    if (best !== active && activeEff - bestEff > policy.toleranceMs) {
      await this.apply(
        channelId,
        active,
        best,
        `optimal: ${active} → ${best} (${num(bestEff)} vs ${num(activeEff)} ms eff)`,
        at,
      );
    }
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
  // The one active step: a speed channel must never stay pinned. Selecting a node
  // on a url-test group (as the manual/sticky policies do via select()) "fixes" it
  // in mihomo — it stops racing by latency until the pin is cleared or dies. So if
  // this group carries a leftover fixed pin (e.g. the channel was on `manual` and
  // then switched to `speed`), clear it here so the latency race resumes. Only
  // records once the clear actually succeeds (the registry swallows a throw), so a
  // transient mihomo error just retries next tick instead of spamming the log.
  private async tickSpeed(view: NodeView, channelId: string, fixed: string | null): Promise<void> {
    if (fixed) {
      // De-dupe: only clear + log the FIRST time we see a given pin. A throw from
      // clearFixed (swallowed upstream) leaves lastClearedFixed untouched → retried
      // next tick; a persistent pin that survives a successful DELETE is not re-logged.
      if (fixed !== this.lastClearedFixed) {
        await this.deps.clearFixed(this.deps.group);
        this.lastClearedFixed = fixed;
        this.record({
          at: this.deps.now(),
          channelId,
          from: fixed,
          to: fixed,
          reason: `unpinned ${fixed}; resuming latency race`,
        });
      }
      // Still pinned this tick → no meaningful latency-race delta to record below.
      return;
    }
    // Racing freely again: allow a future new pin to be handled.
    this.lastClearedFixed = null;
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
