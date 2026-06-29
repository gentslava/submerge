import { cn } from "@/lib/utils";

interface LatencyBarsProps {
  values: number[];
  className?: string;
}

export function LatencyBars({ values, className }: LatencyBarsProps) {
  if (values.length === 0) {
    return <div className={cn("h-8 w-full rounded-sm bg-chart-track", className)} />;
  }

  const max = Math.max(...values);
  const safeMax = max > 0 ? max : 1; // all-zero / empty → flat bars, not NaN

  return (
    <div className={cn("flex h-8 items-end gap-0.5", className)}>
      {values.map((v, i) => (
        <div key={i} className="relative flex-1 rounded-sm bg-chart-track">
          <div
            className="absolute bottom-0 w-full rounded-sm bg-accent"
            style={{ height: `${Math.max(8, (v / safeMax) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
