import type { NodeItem } from "@submerge/shared";
import { Check, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dotColors, latencyClass, latencyLabel, latencyTextColors, typeBadges } from "./nodeView";

interface NodeRowProps {
  item: NodeItem;
  isActive: boolean;
  pinging?: boolean;
  onSelect(): void;
  onPing(): void;
}

export function NodeRow({ item, isActive, pinging = false, onSelect, onPing }: NodeRowProps) {
  const lClass = latencyClass(item.delay);
  // Protocol metadata is all we have (no geo) — show it honestly as the sub-line.
  const sub = typeBadges(item).join(" · ");

  return (
    <div
      className={cn(
        "flex items-center gap-4 border-b border-border-subtle px-4 py-[13px] last:border-b-0",
        isActive && "bg-accent-bg",
      )}
    >
      {/* Node cell (fills): status dot + name/sub */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])}
        />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="truncate text-sm font-semibold text-text-primary">{item.name}</span>
          {sub !== "" && <span className="truncate text-xs text-text-tertiary">{sub}</span>}
        </div>
      </div>

      {/* Ping value — a spinner stands in while this node is being pinged */}
      <div className="flex w-24 shrink-0 items-center justify-end">
        {pinging ? (
          <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" aria-label="Опрос…" />
        ) : (
          <span className={cn("font-mono text-sm font-medium", latencyTextColors[lClass])}>
            {latencyLabel(item.delay)}
          </span>
        )}
      </div>

      {/* Inline ping button — transparent icon button (no border/fill), zap 18 */}
      <div className="flex w-12 shrink-0 justify-center">
        <button
          type="button"
          onClick={onPing}
          disabled={pinging}
          aria-label={`Пинговать ${item.name}`}
          className="flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
        >
          <Zap className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>

      {/* Action cell */}
      <div className="flex w-[120px] shrink-0 justify-end">
        {isActive ? (
          // Solid accent (not opacity-dimmed) — the active node reads as "on", not disabled.
          <Button variant="primary" size="sm" disabled className="w-[112px] disabled:opacity-100">
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
