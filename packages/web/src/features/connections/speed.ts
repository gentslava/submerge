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

// КБ/с with enough precision for low rates and a compact, stable footprint for high rates.
// Thresholds keep the numeric part at roughly the same width as precision is shed.
export function toKilobytesPerSecond(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "0.00";
  const kilobytesPerSecond = bytesPerSec / 1_024;
  if (kilobytesPerSecond < 0.01) return "<0.01";
  if (kilobytesPerSecond < 9.995) return kilobytesPerSecond.toFixed(2);
  if (kilobytesPerSecond < 99.95) return kilobytesPerSecond.toFixed(1);
  return kilobytesPerSecond.toFixed(0);
}
