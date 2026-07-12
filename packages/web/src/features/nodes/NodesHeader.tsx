import { Ellipsis, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatInterval } from "@/lib/duration";
import { pluralRu } from "@/lib/plural";

interface NodesHeaderProps {
  nodeCount: number;
  checkIntervalSec: number | null;
  refreshing: boolean;
  pinging: boolean;
  onRefresh(): void;
  onPingAll(): void;
}

export function NodesHeader({
  nodeCount,
  checkIntervalSec,
  refreshing,
  pinging,
  onRefresh,
  onPingAll,
}: NodesHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const summary = `Группа PROXY · ${nodeCount} ${pluralRu(nodeCount, ["узел", "узла", "узлов"])}`;

  return (
    <>
      <header className="flex items-center justify-between gap-4 md:hidden">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-[22px] font-semibold text-text-primary">Узлы</h1>
          <p className="truncate text-meta text-text-tertiary">{summary}</p>
        </div>
        <div className="relative flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="icon"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Обновить"
          >
            <RefreshCw className="h-[18px] w-[18px]" aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Дополнительные действия"
            aria-expanded={menuOpen}
          >
            <Ellipsis className="h-[18px] w-[18px]" aria-hidden="true" />
          </Button>
          {menuOpen && (
            <div className="absolute right-0 top-11 z-20 w-44 rounded-md border border-border-default bg-elevated p-1.5">
              <button
                type="button"
                disabled={pinging}
                onClick={() => {
                  setMenuOpen(false);
                  onPingAll();
                }}
                className="flex h-10 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sub font-medium text-text-primary transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50"
              >
                <Zap className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                Пинг всех
              </button>
            </div>
          )}
        </div>
      </header>

      <header className="hidden flex-col gap-3 md:flex md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-[5px]">
          <h1 className="text-h1 text-text-primary">Узлы</h1>
          <p className="text-sub text-text-secondary">
            {summary}
            {checkIntervalSec != null && <> · проверка каждые {formatInterval(checkIntervalSec)}</>}
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
    </>
  );
}
