import type { NodeItem } from "@submerge/shared";
import { Activity, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dotColors, latencyClass, latencyLabel, latencyTextColors } from "./nodeView";

interface NodeRowProps {
  item: NodeItem;
  isActive: boolean;
  sublabel?: string;
  pinging?: boolean;
  onSelect(): void;
  onPing(): void;
}

export function NodeRow({
  item,
  isActive,
  sublabel,
  pinging = false,
  onSelect,
  onPing,
}: NodeRowProps) {
  const lClass = latencyClass(item.delay);

  return (
    <div
      className={cn(
        "flex items-center gap-4 border-b border-border-subtle px-4 py-[13px] last:border-b-0",
        isActive && "bg-accent-bg",
      )}
    >
      {/* Node cell (fills) */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])}
        />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="truncate font-mono text-sub font-medium text-text-primary">
            {item.name}
          </span>
          {sublabel != null && sublabel !== "" && (
            <span className="truncate text-[11px] text-text-tertiary">{sublabel}</span>
          )}
        </div>
      </div>

      {/* Ping cell */}
      <div className="flex w-24 shrink-0 justify-end">
        <span className={cn("font-mono text-sm font-medium", latencyTextColors[lClass])}>
          {latencyLabel(item.delay)}
        </span>
      </div>

      {/* Per-row ping button */}
      <div className="flex w-12 shrink-0 justify-center">
        <button
          type="button"
          onClick={onPing}
          disabled={pinging}
          aria-label={`Пинговать ${item.name}`}
          className="flex h-10 w-10 items-center justify-center rounded-md border border-border-default bg-elevated text-text-secondary transition-colors hover:bg-hover disabled:opacity-50 disabled:pointer-events-none"
        >
          <Activity className={cn("h-4 w-4", pinging && "animate-pulse")} aria-hidden="true" />
        </button>
      </div>

      {/* Action cell */}
      <div className="flex w-[120px] shrink-0 justify-end">
        {isActive ? (
          <Button variant="primary" size="sm" className="w-[112px]" disabled>
            <Check className="h-4 w-4" aria-hidden="true" />
            Активен
          </Button>
        ) : (
          <Button variant="secondary" size="sm" className="w-[112px]" onClick={onSelect}>
            Выбрать
          </Button>
        )}
      </div>
    </div>
  );
}
