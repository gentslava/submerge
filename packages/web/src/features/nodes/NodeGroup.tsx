import type { NodeItem } from "@submerge/shared";
import { ChevronDown, KeyRound, Layers } from "lucide-react";
import { NodeRow } from "./NodeRow";
import type { NodeGroup as NodeGroupModel } from "./nodeView";

interface NodeGroupProps {
  group: NodeGroupModel;
  now: string | null;
  pingingName: string | null;
  onSelect(name: string): void;
  onPing(name: string): void;
}

export function NodeGroup({ group, now, pingingName, onSelect, onPing }: NodeGroupProps) {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-border-subtle bg-elevated px-4 py-2.5">
        <ChevronDown className="h-[15px] w-[15px] shrink-0 text-text-tertiary" aria-hidden="true" />
        {group.hwid ? (
          <KeyRound className="h-[15px] w-[15px] shrink-0 text-text-secondary" aria-hidden="true" />
        ) : (
          <Layers className="h-[15px] w-[15px] shrink-0 text-text-secondary" aria-hidden="true" />
        )}
        <span className="truncate text-[13px] font-semibold text-text-primary">{group.label}</span>
        <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-text-tertiary">
          {group.nodes.length}
        </span>
      </div>
      {group.nodes.map((n: NodeItem) => (
        <NodeRow
          key={n.name}
          item={n}
          isActive={now === n.name}
          sublabel={n.type}
          pinging={pingingName === n.name}
          onSelect={() => onSelect(n.name)}
          onPing={() => onPing(n.name)}
        />
      ))}
    </>
  );
}
