import { PSEUDO_NODE_SET } from "@submerge/shared";
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
export class Prober {
  private names: string[] = []; // rotation order
  private cursor = 0;
  private lastSeen = new Map<string, number>(); // mihomo's latest measurement
  private lastAttempt = new Map<string, number>(); // our latest probe attempt

  constructor(private readonly deps: ProberDeps) {}

  // Digest a /proxies snapshot: refresh the node set (rotation keeps its order,
  // new names append, vanished names drop) and each node's latest-measured time.
  observe(resp: ProxiesResponse): void {
    const current = (resp.proxies.PROXY?.all ?? []).filter((n) => !PSEUDO_NODE_SET.has(n));
    const currentSet = new Set(current);
    this.names = this.names.filter((n) => currentSet.has(n));
    for (const n of current) if (!this.names.includes(n)) this.names.push(n);
    for (const k of [...this.lastSeen.keys()]) if (!currentSet.has(k)) this.lastSeen.delete(k);
    for (const k of [...this.lastAttempt.keys()])
      if (!currentSet.has(k)) this.lastAttempt.delete(k);
    if (this.cursor >= this.names.length) this.cursor = 0;
    for (const n of current) {
      const t = resp.proxies[n]?.history.at(-1)?.time;
      if (t) {
        const ms = Date.parse(t);
        if (Number.isFinite(ms)) this.lastSeen.set(n, ms);
      }
    }
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
      Math.max(2, Math.ceil((this.names.length * this.deps.pulseMs) / staleMs)),
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
