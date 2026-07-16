import type { NodeItem } from "@submerge/shared";
import { ChevronDown, KeyRound, Layers } from "lucide-react";
import { useState } from "react";
import { pluralRu } from "@/lib/plural";
import { cn } from "@/lib/utils";
import { NodeRow } from "./NodeRow";
import { formatBytes, type NodeGroup as NodeGroupModel } from "./nodeView";

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
  const usage = group.source?.meta;
  const used = usage?.used;
  const total = usage?.total;
  const usagePercent =
    used != null && total ? Math.min(100, Math.round((used / total) * 100)) : null;

  return (
    <div className="node-group rounded-lg border border-border-subtle bg-surface">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={cn(
          "node-group-desktop-header hidden w-full items-center gap-3 border-b border-border-subtle bg-elevated px-4 py-2.5 text-left transition-colors hover:bg-hover",
          collapsed && "border-b-0",
        )}
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
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={cn(
          "node-group-mobile-header flex w-full flex-col gap-2.5 px-3.5 py-3.5 text-left transition-colors hover:bg-hover",
          !collapsed && "border-b border-border-subtle",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {group.hwid ? (
            <KeyRound className="h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" />
          ) : (
            <Layers className="h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate text-section text-text-primary">
            {group.label}
          </span>
          <span className="shrink-0 rounded-full bg-hover px-2.5 py-1 text-sub text-text-tertiary">
            {group.nodes.length} {pluralRu(group.nodes.length, ["узел", "узла", "узлов"])}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-text-tertiary transition-transform",
              collapsed && "-rotate-90",
            )}
            aria-hidden="true"
          />
        </span>
        {(used != null || total != null) && (
          <span className="flex min-w-0 items-center gap-3 pl-[30px]">
            {total != null && (
              <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-hover">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${usagePercent ?? 0}%` }}
                />
              </span>
            )}
            <span className="truncate font-mono text-sub text-text-secondary">
              {used != null ? formatBytes(used) : "—"}
              {total != null ? ` / ${formatBytes(total)}` : ""}
            </span>
          </span>
        )}
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
    </div>
  );
}
