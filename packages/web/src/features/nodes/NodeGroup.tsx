import type { NodeItem } from "@submerge/shared";
import { ChevronDown, KeyRound, Layers } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { NodeRow } from "./NodeRow";
import type { NodeGroup as NodeGroupModel } from "./nodeView";

interface NodeGroupProps {
  group: NodeGroupModel;
  now: string | null;
  pingingNames: Set<string>;
  onSelect(name: string): void;
  onPing(name: string): void;
  onToggleExcluded(name: string, excluded: boolean): void;
}

export function NodeGroup({
  group,
  now,
  pingingNames,
  onSelect,
  onPing,
  onToggleExcluded,
}: NodeGroupProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-3 border-b border-border-subtle bg-elevated px-4 py-2.5 text-left transition-colors hover:bg-hover"
      >
        <ChevronDown
          className={cn(
            "h-[15px] w-[15px] shrink-0 text-text-tertiary transition-transform",
            collapsed && "-rotate-90",
          )}
          aria-hidden="true"
        />
        {group.hwid ? (
          <KeyRound className="h-[15px] w-[15px] shrink-0 text-text-secondary" aria-hidden="true" />
        ) : (
          <Layers className="h-[15px] w-[15px] shrink-0 text-text-secondary" aria-hidden="true" />
        )}
        <span className="truncate text-sub font-semibold text-text-primary">{group.label}</span>
        <span className="rounded-full bg-hover px-2 py-0.5 text-fine text-text-tertiary">
          {group.nodes.length}
        </span>
      </button>
      {!collapsed &&
        group.nodes.map((n: NodeItem) => (
          <NodeRow
            key={n.name}
            item={n}
            isActive={now === n.name}
            pinging={pingingNames.has(n.name)}
            onSelect={() => onSelect(n.name)}
            onPing={() => onPing(n.name)}
            onToggleExcluded={(excluded) => onToggleExcluded(n.name, excluded)}
          />
        ))}
    </>
  );
}
