interface LatencyChartProps {
  // Live latency history (ms) for the active node, oldest → newest.
  history: number[];
}

const TRACK_HEIGHT = 92;
const MIN_BAR = 4; // px, so a tiny value still shows a sliver
const RECENT = 4; // most-recent bars rendered in accent

// A live latency bar chart for the active node. Fed by the ref-based history that
// NodesScreen accumulates from SSE node updates — this is real-time, not a mock.
export function LatencyChart({ history }: LatencyChartProps) {
  const peak = history.length > 0 ? Math.max(...history) : 0;
  const max = peak > 0 ? peak : 1;
  const firstAccent = Math.max(0, history.length - RECENT);

  return (
    <div className="flex w-full flex-col gap-2.5 lg:w-[400px] lg:shrink-0">
      <div className="flex items-center justify-between">
        <span className="text-meta text-text-secondary">Задержка · live</span>
        <span className="font-mono text-[11px] text-text-tertiary">
          {peak > 0 ? `пик ${peak} ms` : "нет данных"}
        </span>
      </div>

      {history.length === 0 ? (
        <div
          role="img"
          aria-label="Нет данных о задержке"
          className="w-full rounded-sm bg-chart-track"
          style={{ height: TRACK_HEIGHT }}
        />
      ) : (
        <div className="flex items-end gap-[3px]" style={{ height: TRACK_HEIGHT }}>
          {history.map((v, i) => (
            <div
              key={i}
              className={`flex-1 rounded-sm ${i >= firstAccent ? "bg-accent" : "bg-chart-track"}`}
              style={{ height: Math.max(MIN_BAR, (v / max) * TRACK_HEIGHT) }}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="font-mono text-micro text-text-tertiary">начало</span>
        <span className="font-mono text-micro text-text-tertiary">сейчас</span>
      </div>
    </div>
  );
}
