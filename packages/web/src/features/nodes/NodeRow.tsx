import type { NodeItem } from "@submerge/shared";
import { Check, ChevronDown, Loader2, Zap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  dotColors,
  latencyClass,
  latencyLabel,
  latencyTextColors,
  serverCountLabel,
  typeBadges,
} from "./nodeView";

interface NodeRowProps {
  item: NodeItem;
  isActive: boolean;
  pinging?: boolean;
  onSelect(): void;
  onPing(): void;
}

export function NodeRow({ item, isActive, pinging = false, onSelect, onPing }: NodeRowProps) {
  const lClass = latencyClass(item.delay);
  const members = item.members ?? [];
  const isGroup = members.length > 0;
  const [expanded, setExpanded] = useState(false);
  // Sub-line: a collapsed group shows its server count ("5 серверов"); a plain
  // node shows its protocol badges (VLESS · Reality / · WS / · TCP).
  const sub = isGroup ? serverCountLabel(members.length) : typeBadges(item).join(" · ");

  // Dot + name (+ trailing chevron for groups) + sub. The dot stays the first
  // element in both the group and singleton layouts so status dots line up.
  const nodeCell = (
    <>
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])} />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-text-primary">{item.name}</span>
          {isGroup && (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform",
                !expanded && "-rotate-90",
              )}
            />
          )}
        </span>
        {sub !== "" && <span className="truncate text-xs text-text-tertiary">{sub}</span>}
      </div>
    </>
  );

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-2 border-b border-border-subtle px-4 py-[13px] last:border-b-0 md:gap-4",
          isActive && "bg-accent-bg",
        )}
      >
        {/* Node cell (fills). For a group the whole cell is a toggle button so
            clicking the name/row area expands its members; ⚡ and Выбрать stay
            separate controls. Singletons render the same cell as a plain div. */}
        {isGroup ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-label={`Показать серверы ${item.name}`}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            {nodeCell}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{nodeCell}</div>
        )}

        {/* Ping value — a spinner stands in while this node is being pinged */}
        <div className="flex w-16 shrink-0 items-center justify-end md:w-24">
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
        <div className="flex w-auto shrink-0 justify-end md:w-[120px]">
          {isActive ? (
            // Solid accent (not opacity-dimmed) — the active node reads as "on", not disabled.
            <Button
              variant="primary"
              size="sm"
              disabled
              className="w-[92px] disabled:opacity-100 md:w-[112px]"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Активен
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="w-[92px] md:w-[112px]"
              onClick={onSelect}
            >
              Выбрать
            </Button>
          )}
        </div>
      </div>

      {expanded &&
        members.map((m) => (
          <div
            key={m.name}
            className="flex items-center gap-2 border-b border-border-subtle bg-elevated px-4 py-2.5 pl-11 last:border-b-0 md:gap-4"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[latencyClass(m.delay)])}
              />
              <span className="truncate text-sm text-text-secondary">
                {m.active ? `${m.name} · активен` : m.name}
              </span>
            </div>
            <div className="flex w-16 shrink-0 items-center justify-end md:w-24">
              <span className={cn("font-mono text-sm", latencyTextColors[latencyClass(m.delay)])}>
                {latencyLabel(m.delay)}
              </span>
            </div>
            <span aria-hidden="true" className="w-12 shrink-0" />
            {/* Match the parent row's action column so member delay values line up:
                ~92px (the mobile button width) then the desktop w-[120px]. */}
            <span aria-hidden="true" className="w-[92px] shrink-0 md:w-[120px]" />
          </div>
        ))}
    </>
  );
}
