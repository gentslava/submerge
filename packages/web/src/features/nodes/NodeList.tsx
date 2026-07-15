import type { NodeItem, Source } from "@submerge/shared";
import { Link } from "@tanstack/react-router";
import { NodeGroup } from "./NodeGroup";
import { groupNodes, realNodes } from "./nodeView";

interface NodeListProps {
  now: string | null;
  all: NodeItem[];
  sources: Source[];
  pingingNames: Set<string>;
  onSelect(name: string): void;
  onPing(name: string): void;
  onToggleExcluded(name: string, excluded: boolean): void;
}

export function NodeList({
  now,
  all,
  sources,
  pingingNames,
  onSelect,
  onPing,
  onToggleExcluded,
}: NodeListProps) {
  // Pseudo modes (AUTO/DIRECT/…) are not list rows — strategy lives in the control
  // above; the list shows only real subscription nodes, grouped by source.
  const nodes = realNodes(all);
  const groups = groupNodes(nodes, sources);

  return (
    <div className="node-list-region">
      <div className="node-list-container flex flex-col gap-3">
        {/* Columns header */}
        <div className="node-list-header hidden items-center gap-4 border-b border-border-subtle bg-elevated px-4 py-[11px]">
          <span className="flex-1 text-caption text-text-tertiary">УЗЕЛ</span>
          <span className="w-24 text-right text-caption text-text-tertiary">ПИНГ</span>
          <span aria-hidden="true" className="w-12" />
          <span aria-hidden="true" className="w-12" />
          <span aria-hidden="true" className="w-10" />
          <span aria-hidden="true" className="w-[120px]" />
        </div>

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
              pingingNames={pingingNames}
              onSelect={onSelect}
              onPing={onPing}
              onToggleExcluded={onToggleExcluded}
            />
          ))
        )}
      </div>
    </div>
  );
}
