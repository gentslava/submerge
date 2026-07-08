import { PSEUDO_NODE_SET } from "@submerge/shared";
import { getConnections } from "../../clients/mihomo.js";
import type { Db } from "../../db/client.js";
import { getNodeBandwidth, setNodeBandwidth } from "./bandwidth.js";

// Previous /connections snapshot: connection id → cumulative download bytes, and
// the poll timestamp. Module-level (the live hub is a singleton) so successive
// polls can diff. Reset implicitly when mihomo restarts (ids/counters reset →
// negative deltas are dropped below).
let prevBytes = new Map<string, number>();
let prevAt = 0;

// Skip anything that isn't a real exit node: mihomo's built-in policies/groups
// (DIRECT/REJECT/AUTO/PROXY/PROBE…) and our channel groups (ch-<id>).
function isRealNode(name: string): boolean {
  return name.length > 0 && !PSEUDO_NODE_SET.has(name) && !name.startsWith("ch-");
}

// Passive throughput (Phase 4c, variant b): diff /connections against the previous
// poll to get each exit node's current download rate, and cache the PEAK observed
// per node. This is REAL USAGE, not link capacity — a node only gets a value once
// it has actually carried traffic, and idle-but-fast nodes stay uncached (→ the
// highest-bandwidth criterion falls back to fastest for them). The on-demand speed
// test gives a truer, controlled number and overwrites this. Best-effort: any
// mihomo error just skips this poll.
export async function recordPassiveBandwidth(db: Db, now: number): Promise<void> {
  let conns: Awaited<ReturnType<typeof getConnections>>;
  try {
    conns = await getConnections();
  } catch {
    return;
  }

  const curBytes = new Map<string, number>();
  const perNodeDelta = new Map<string, number>();
  const elapsedSec = prevAt > 0 ? (now - prevAt) / 1000 : 0;

  for (const c of conns) {
    curBytes.set(c.id, c.download);
    const node = c.chains[0] ?? "";
    if (!isRealNode(node)) continue;
    const before = prevBytes.get(c.id);
    // Only diff connections seen last poll; a brand-new or reset connection
    // contributes nothing this round (avoids counting its full cumulative total).
    if (before === undefined) continue;
    const delta = c.download - before;
    if (delta > 0) perNodeDelta.set(node, (perNodeDelta.get(node) ?? 0) + delta);
  }

  if (elapsedSec > 0) {
    for (const [node, bytes] of perNodeDelta) {
      const mbps = (bytes * 8) / 1e6 / elapsedSec;
      // Keep the peak observed usage (a truer capacity hint than a single noisy
      // interval), but compare against the FRESH peak only — once the stored peak
      // ages out (BANDWIDTH_MAX_AGE_MS) it reads as absent, so a new sample resets
      // it rather than being dwarfed by a long-stale high. testedAt tracks the peak.
      if (mbps > (getNodeBandwidth(db, node, now) ?? 0)) setNodeBandwidth(db, node, mbps, now);
    }
  }

  prevBytes = curBytes;
  prevAt = now;
}
