import { type NodeView, PSEUDO_NODE_SET } from "@submerge/shared";
import type { ProxiesResponse } from "../clients/mihomo.js";

export interface ProberDeps {
  // getDelay(name, url) — the result is ignored here; mihomo records it into
  // the node's history, which the normal view/SSE path already surfaces.
  probe: (name: string, url: string) => Promise<unknown>;
  // The single user knob: «Интервал проверки» (+ its test URL) from the policy.
  getProbeConfig: () => { url: string; intervalSec: number };
  pulseMs: number; // internal pulse length (how often tick() runs)
  concurrency?: number; // hard cap per tick (default 10)
  now?: () => number;
}

// Gap-filling measurement loop (spec §4.1): keeps every real node's latency
// measurement fresher than «Интервал проверки». Only probes nodes WITHOUT a
// fresh measurement — under the speed policy mihomo's url-test keeps most
// nodes fresh and the prober fills the gaps (post-reload, select-policy nodes).
// A vanished name is forgotten only after a sustained absence: a mihomo reload
// can briefly return a partial /proxies snapshot, and pruning memory on that
// transient blip wiped exactly the values the last-known overlay exists to keep.
const MEMORY_GRACE_MS = 10 * 60_000;

export class Prober {
  private names: string[] = []; // rotation order
  private cursor = 0;
  private lastSeen = new Map<string, number>(); // mihomo's latest measurement time
  private lastDelay = new Map<string, number>(); // …and its value (survives reloads)
  private lastAttempt = new Map<string, number>(); // our latest probe attempt
  private lastInView = new Map<string, number>(); // when the name last appeared in a snapshot

  constructor(private readonly deps: ProberDeps) {}

  // Digest a /proxies snapshot: refresh the node set (rotation keeps its order,
  // new names append, vanished names drop) and each node's latest-measured time.
  observe(resp: ProxiesResponse): void {
    const now = (this.deps.now ?? Date.now)();
    const current = (resp.proxies.PROXY?.all ?? []).filter((n) => !PSEUDO_NODE_SET.has(n));
    const currentSet = new Set(current);
    // Rotation follows the snapshot instantly (self-heals on the next observe);
    // measurement memory is pruned lazily below, with the grace period.
    this.names = this.names.filter((n) => currentSet.has(n));
    for (const n of current) if (!this.names.includes(n)) this.names.push(n);
    if (this.cursor >= this.names.length) this.cursor = 0;
    for (const n of current) this.lastInView.set(n, now);
    for (const [k, seenAt] of [...this.lastInView]) {
      if (!currentSet.has(k) && now - seenAt > MEMORY_GRACE_MS) {
        this.lastInView.delete(k);
        this.lastSeen.delete(k);
        this.lastDelay.delete(k);
        this.lastAttempt.delete(k);
      }
    }
    for (const n of current) {
      const last = resp.proxies[n]?.history.at(-1);
      if (!last) continue; // empty history (e.g. right after a reload) — keep the memory
      const ms = Date.parse(last.time);
      if (Number.isFinite(ms)) this.lastSeen.set(n, ms);
      this.lastDelay.set(n, last.delay);
    }
  }

  // A mihomo reload wipes the engine's delay history, which used to blank every
  // node to «— ms» after any settings change. The panel remembers the last real
  // measurement itself: fill it into nodes the engine has no record for. Only
  // truly never-measured nodes stay null; fresh engine data always wins, and the
  // rolling sweep replaces these carried-over values within one check interval.
  fillLastKnown(view: NodeView): NodeView {
    return {
      ...view,
      all: view.all.map((n) => {
        if (n.delay !== null || n.history.length > 0) return n;
        const known = this.lastDelay.get(n.name);
        return known === undefined ? n : { ...n, delay: known };
      }),
    };
  }

  // Probe the next rolling batch of stale nodes. Batch size spreads a full
  // sweep across the check interval: ceil(total × pulse / interval), min 1,
  // capped by `concurrency` so a tiny interval can't burst 90 parallel probes.
  async tick(): Promise<void> {
    if (this.names.length === 0) return;
    const { url, intervalSec } = this.deps.getProbeConfig();
    const now = (this.deps.now ?? Date.now)();
    const staleMs = intervalSec * 1000;
    const isStale = (n: string) => {
      const seen = this.lastSeen.get(n) ?? Number.NEGATIVE_INFINITY;
      const tried = this.lastAttempt.get(n) ?? Number.NEGATIVE_INFINITY;
      return Math.max(seen, tried) <= now - staleMs;
    };
    const batch = Math.min(
      this.deps.concurrency ?? 10,
      Math.max(1, Math.ceil((this.names.length * this.deps.pulseMs) / staleMs)),
    );
    const picked: string[] = [];
    let lastOffset = -1;
    for (let step = 0; step < this.names.length && picked.length < batch; step++) {
      const idx = (this.cursor + step) % this.names.length;
      const name = this.names[idx] as string;
      if (isStale(name)) {
        picked.push(name);
        lastOffset = step;
      }
    }
    if (picked.length === 0) return;
    this.cursor = (this.cursor + lastOffset + 1) % this.names.length;
    // lastAttempt guards against hot-looping on dead nodes: a failed probe may
    // record nothing in mihomo, so without it the node would be re-probed every
    // pulse forever.
    for (const n of picked) this.lastAttempt.set(n, now);
    await Promise.allSettled(picked.map((n) => this.deps.probe(n, url)));
  }
}
