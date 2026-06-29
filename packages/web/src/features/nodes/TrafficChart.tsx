import uPlot from "uplot";
import { Chart } from "@/components/Chart";
import { useLiveState } from "@/features/live/LiveProvider";

// uPlot renders to <canvas>, so Tailwind tokens can't apply — use the Indigo
// Console palette directly (accent #6366F1 for down, secondary #9BA1AD for up).
export function TrafficChart() {
  const { traffic } = useLiveState();
  const xs = traffic.map((_, i) => i);
  const down = traffic.map((s) => s.down);
  const up = traffic.map((s) => s.up);
  const data: uPlot.AlignedData = [xs, down, up];

  // `uPlot.paths.bars` is typed optional; under exactOptionalPropertyTypes we
  // must omit `paths` entirely (not assign `undefined`) when it is absent.
  const barPaths = uPlot.paths.bars?.({ size: [0.6] });
  const bars = barPaths ? { paths: barPaths } : {};

  return (
    <Chart
      data={data}
      makeOpts={(width) => ({
        width,
        height: 96,
        cursor: { show: false },
        legend: { show: false },
        scales: { x: { time: false } },
        axes: [{ show: false }, { show: false }],
        series: [
          {},
          { label: "down", stroke: "transparent", fill: "#6366F1", ...bars },
          { label: "up", stroke: "transparent", fill: "#9BA1AD", ...bars },
        ],
      })}
    />
  );
}
