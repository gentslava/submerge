import type { ConnectionItem } from "@submerge/shared";

export interface Rate {
  up: number; // bytes/second
  down: number;
}

// Per-connection instantaneous rate from two cumulative-byte snapshots keyed by id.
// mihomo reports `up`/`down` as monotonic totals, so speed = Δbytes / Δt. A connection
// absent from the previous snapshot (or a non-positive dt) yields 0 — no fake spike on
// first sight, and counter resets (mihomo restart → smaller value) clamp to 0.
export function deriveSpeeds(
  prev: Map<string, { up: number; down: number }>,
  curr: readonly ConnectionItem[],
  dtMs: number,
): Map<string, Rate> {
  const out = new Map<string, Rate>();
  if (dtMs <= 0) return out;
  const perSec = 1000 / dtMs;
  for (const c of curr) {
    const p = prev.get(c.id);
    if (!p) {
      out.set(c.id, { up: 0, down: 0 });
      continue;
    }
    const up = Math.max(0, c.up - p.up) * perSec;
    const down = Math.max(0, c.down - p.down) * perSec;
    out.set(c.id, { up, down });
  }
  return out;
}

// Fixed МБ/с with two decimals, matching the mockup's "↓ 5.30  ↑ 0.04".
export function toMbps(bytesPerSec: number): string {
  return (bytesPerSec / 1_048_576).toFixed(2);
}
