import type { NodeItem, Source } from "@submerge/shared";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { NodeGroup } from "./NodeGroup";
import { NodeRow } from "./NodeRow";
import { groupNodes, splitNodes } from "./nodeView";

interface NodeListProps {
  now: string | null;
  all: NodeItem[];
  sources: Source[];
  pingingName: string | null;
  onSelect(name: string): void;
  onPing(name: string): void;
}

export function NodeList({ now, all, sources, pingingName, onSelect, onPing }: NodeListProps) {
  const { modes, nodes } = splitNodes(all);
  const groups = groupNodes(nodes, sources);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface">
      {/* Columns header */}
      <div className="flex items-center gap-4 border-b border-border-subtle bg-elevated px-4 py-[11px]">
        <span className="flex-1 text-caption text-text-tertiary">УЗЕЛ</span>
        <span className="w-24 text-right text-caption text-text-tertiary">ПИНГ</span>
        <span aria-hidden="true" className="w-12" />
        <span aria-hidden="true" className="w-[120px]" />
      </div>

      {/* Pseudo modes (AUTO / DIRECT / …) — selectable */}
      {modes.length > 0 && (
        <>
          <div className="flex items-center gap-3 border-b border-border-subtle bg-elevated px-4 py-2.5">
            <SlidersHorizontal
              className="h-[15px] w-[15px] shrink-0 text-text-secondary"
              aria-hidden="true"
            />
            <span className="text-sub font-semibold text-text-primary">Режимы</span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-text-tertiary">
              {modes.length}
            </span>
          </div>
          {modes.map((m) => (
            <NodeRow
              key={m.name}
              item={m}
              isActive={now === m.name}
              sublabel={m.type}
              pinging={pingingName === m.name}
              onSelect={() => onSelect(m.name)}
              onPing={() => onPing(m.name)}
            />
          ))}
        </>
      )}

      {/* Real nodes grouped by subscription */}
      {nodes.length === 0 ? (
        <div className="p-8 text-center text-sm text-text-secondary">
          Нет узлов —{" "}
          <Link to="/sources" className="text-accent-text">
            добавьте источник
          </Link>
          .
        </div>
      ) : (
        groups.map((g) => (
          <NodeGroup
            key={g.key}
            group={g}
            now={now}
            pingingName={pingingName}
            onSelect={onSelect}
            onPing={onPing}
          />
        ))
      )}
    </div>
  );
}
