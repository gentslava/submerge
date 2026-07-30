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

export interface FormattedConnectionRatePair {
  down: string;
  up: string;
  unit: "Б/с" | "КБ/с" | "МБ/с";
}

// Pick one unit for both directions so a row remains directly comparable. Precision
// decreases before rounding would grow the numeric slot, keeping live updates compact.
export function formatConnectionRatePair(rate: Rate): FormattedConnectionRatePair {
  const magnitude = Math.max(0, rate.down, rate.up);
  const scale =
    magnitude >= 1_048_576
      ? { divisor: 1_048_576, unit: "МБ/с" as const }
      : magnitude >= 1_024
        ? { divisor: 1_024, unit: "КБ/с" as const }
        : { divisor: 1, unit: "Б/с" as const };

  return {
    down: formatScaledRate(rate.down, scale.divisor),
    up: formatScaledRate(rate.up, scale.divisor),
    unit: scale.unit,
  };
}

function formatScaledRate(bytesPerSec: number, divisor: number): string {
  if (bytesPerSec <= 0) return divisor === 1 ? "0" : "0.00";
  const value = bytesPerSec / divisor;
  if (divisor === 1) return value < 1 ? "<1" : value.toFixed(0);
  if (value < 0.01) return "<0.01";
  if (value < 9.995) return value.toFixed(2);
  if (value < 99.95) return value.toFixed(1);
  return value.toFixed(0);
}
