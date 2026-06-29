import type { NodeItem } from "@submerge/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LatencyClass } from "./nodeView";
import { latencyClass, latencyLabel } from "./nodeView";

const dotColors: Record<LatencyClass, string> = {
  online: "bg-online",
  slow: "bg-slow",
  timeout: "bg-timeout",
  idle: "bg-idle",
};

const badgeVariants: Record<LatencyClass, "online" | "slow" | "timeout" | "neutral"> = {
  online: "online",
  slow: "slow",
  timeout: "timeout",
  idle: "neutral",
};

interface NodeRowProps {
  item: NodeItem;
  isActive: boolean;
  onSelect(): void;
  onPing(): void;
}

export function NodeRow({ item, isActive, onSelect, onPing: _onPing }: NodeRowProps) {
  const lClass = latencyClass(item.delay);

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-0",
        isActive && "bg-accent-bg",
      )}
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])} />
      <span className="flex-1 truncate font-mono text-sm text-text-primary">{item.name}</span>
      <Badge variant={badgeVariants[lClass]}>{latencyLabel(item.delay)}</Badge>
      {isActive ? (
        <Badge variant="accent">Активен</Badge>
      ) : (
        <Button variant="ghost" size="sm" onClick={onSelect}>
          Выбрать
        </Button>
      )}
    </div>
  );
}
