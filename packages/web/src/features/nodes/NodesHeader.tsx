import { RefreshCw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pluralRu } from "@/lib/plural";

interface NodesHeaderProps {
  nodeCount: number;
  pollInterval: number;
  refreshing: boolean;
  pinging: boolean;
  onRefresh(): void;
  onPingAll(): void;
}

export function NodesHeader({
  nodeCount,
  pollInterval,
  refreshing,
  pinging,
  onRefresh,
  onPingAll,
}: NodesHeaderProps) {
  return (
    <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="flex flex-col gap-[5px]">
        <h1 className="text-h1 text-text-primary">Узлы</h1>
        <p className="text-sub text-text-secondary">
          Группа PROXY · {nodeCount} {pluralRu(nodeCount, ["узел", "узла", "узлов"])} · опрос каждые{" "}
          {pollInterval} с
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <Button
          variant="secondary"
          className="flex-1 md:flex-none"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Обновить
        </Button>
        <Button
          variant="primary"
          className="flex-1 md:flex-none"
          onClick={onPingAll}
          disabled={pinging}
        >
          <Zap className="h-4 w-4" aria-hidden="true" />
          Пинг всех
        </Button>
      </div>
    </header>
  );
}
