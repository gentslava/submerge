import type { NodeItem } from "@submerge/shared";
import { LatencyBars } from "@/components/LatencyBars";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LatencyClass } from "./nodeView";
import { latencyClass } from "./nodeView";

const latencyTextColors: Record<LatencyClass, string> = {
  online: "text-online",
  slow: "text-slow",
  timeout: "text-timeout",
  idle: "text-text-tertiary",
};

const STATIC_HISTORY = [40, 55, 38, 60, 45, 52];

interface ActiveNodeCardProps {
  now: string | null;
  all: NodeItem[];
}

export function ActiveNodeCard({ now, all }: ActiveNodeCardProps) {
  const active = now != null ? all.find((n) => n.name === now) : undefined;

  return (
    <Card className="p-5">
      <p className="mb-2 text-xs font-semibold tracking-wide text-accent-text">АКТИВНЫЙ УЗЕЛ</p>
      {active == null ? (
        <p className="text-text-tertiary">Нет активного узла</p>
      ) : (
        <>
          <p className="mb-3 font-mono text-xl text-text-primary">{active.name}</p>
          <div className="flex items-end gap-4">
            <div className="flex items-baseline gap-1">
              <span
                className={cn(
                  "font-mono text-3xl font-semibold",
                  latencyTextColors[latencyClass(active.delay)],
                )}
              >
                {active.delay != null && active.delay > 0 ? active.delay : "—"}
              </span>
              <span className="text-sm text-text-tertiary">ms</span>
            </div>
            <LatencyBars values={STATIC_HISTORY} className="flex-1" />
          </div>
        </>
      )}
    </Card>
  );
}
