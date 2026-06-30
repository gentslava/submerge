interface LatencyChartProps {
  // Latency series (ms; 0 = timeout), oldest → newest — one bar per mihomo check.
  // Timeouts are kept and rendered as failure spikes.
  history: readonly number[];
  // Seconds between checks (the AUTO group's url-test interval) — drives the time axis,
  // since each bar is one check.
  checkInterval: number;
}

const TRACK_HEIGHT = 92;
const MIN_BAR = 4; // px, so a tiny value still shows a sliver
const RECENT = 4; // most-recent successful bars rendered in accent
const CAP = 40; // most recent N samples shown

// Bare duration label (seconds → с / мин / ч), e.g. "3 мин" — used for the window span.
function durationLabel(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} с`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} мин`;
  const hours = seconds / 3600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ч`;
}

// "Time ago" for the chart's left edge — the same duration, prefixed with a minus.
function agoLabel(seconds: number): string {
  return seconds <= 0 ? "сейчас" : `−${durationLabel(seconds)}`;
}

// A latency bar chart for the active node, fed by mihomo's recorded history.
// Successful round-trips scale by delay; timeouts show as full-height red spikes so
// node stability is legible at a glance.
export function LatencyChart({ history, checkInterval }: LatencyChartProps) {
  const bars = history.slice(-CAP);
  const positives = bars.filter((v) => v > 0);
  const peak = positives.length > 0 ? Math.max(...positives) : 0;
  const max = peak > 0 ? peak : 1;
  const firstAccent = Math.max(0, bars.length - RECENT);
  // The chart is a fixed time window: all CAP slots × the check interval, back from now.
  // The labels reflect the whole frame, NOT how many bars are filled yet (e.g. 40 slots ×
  // 300 s ≈ 3.3 ч; halve the check interval → halve the window).
  const windowSeconds = CAP * checkInterval;
  const spanLabel = agoLabel(windowSeconds);

  return (
    <div className="flex w-full flex-col gap-2.5 lg:w-[400px] lg:shrink-0">
      <div className="flex items-center justify-between">
        <span className="text-meta text-text-secondary">
          Задержка · {durationLabel(windowSeconds)}
        </span>
        <span className="font-mono text-[11px] text-text-tertiary">
          {peak > 0 ? `пик ${peak} ms` : "нет данных"}
        </span>
      </div>

      {bars.length === 0 ? (
        <div
          role="img"
          aria-label="Нет данных о задержке"
          className="w-full rounded-sm bg-chart-track"
          style={{ height: TRACK_HEIGHT }}
        />
      ) : (
        // Always CAP fixed-width columns: data is right-anchored (newest at the
        // right) and fills leftward as history grows — bar width never changes.
        <div className="flex items-stretch gap-[3px]" style={{ height: TRACK_HEIGHT }}>
          {Array.from({ length: CAP }, (_, slot) => {
            const idx = slot - (CAP - bars.length);
            const v = idx >= 0 ? bars[idx] : undefined;
            // Empty (not-yet-filled) slot — a faint baseline tick so all CAP slots
            // are visible and the chart reads as "filling up" right-to-left.
            if (v === undefined) {
              return (
                <div key={slot} className="flex flex-1 items-end">
                  <div className="w-full rounded-sm bg-border-subtle" style={{ height: 3 }} />
                </div>
              );
            }
            const timeout = v <= 0;
            const height = timeout ? TRACK_HEIGHT : Math.max(MIN_BAR, (v / max) * TRACK_HEIGHT);
            const color = timeout
              ? "bg-timeout"
              : idx >= firstAccent
                ? "bg-accent"
                : "bg-chart-track";
            return (
              <div key={slot} className="group relative flex flex-1 items-end">
                <div className={`w-full rounded-sm ${color}`} style={{ height }} />
                <span className="pointer-events-none absolute -top-5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-primary opacity-0 shadow transition-opacity group-hover:opacity-100">
                  {timeout ? "таймаут" : `${v} ms`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="font-mono text-micro text-text-tertiary">{spanLabel}</span>
        <span className="font-mono text-micro text-text-tertiary">сейчас</span>
      </div>
    </div>
  );
}
