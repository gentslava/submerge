import { Ellipsis, RefreshCw, Zap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useDismissiblePopup } from "@/hooks/use-dismissible-popup";
import { formatInterval } from "@/lib/duration";
import { pluralRu } from "@/lib/plural";
import { cn } from "@/lib/utils";

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
  const menu = useDismissiblePopup({ preferredPlacement: "below" });
  const summary = `Группа PROXY · ${nodeCount} ${pluralRu(nodeCount, ["узел", "узла", "узлов"])}`;

  return (
    <>
      <PageHeader
        className="nodes-header-compact"
        title="Узлы"
        subtitle={summary}
        actionsClassName="relative gap-2"
        actions={
          <>
            <Button
              variant="secondary"
              size="headerIcon"
              className="border-border-subtle"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Обновить"
            >
              <RefreshCw className="h-[18px] w-[18px]" aria-hidden="true" />
            </Button>
            <Button
              ref={menu.triggerRef}
              variant="secondary"
              size="headerIcon"
              className="border-border-subtle"
              onClick={menu.toggle}
              aria-label="Дополнительные действия"
              aria-expanded={menu.open}
            >
              <Ellipsis className="h-[18px] w-[18px]" aria-hidden="true" />
            </Button>
            {menu.open && (
              <div
                ref={menu.popupRef}
                className={cn(
                  "absolute right-0 z-20 w-44 rounded-md border border-border-default bg-elevated p-1.5",
                  menu.placement === "above"
                    ? "bottom-[calc(100%+0.5rem)]"
                    : "top-[calc(100%+0.5rem)]",
                )}
              >
                <button
                  type="button"
                  disabled={pinging}
                  onClick={() => {
                    menu.closeAndRestoreFocus();
                    onPingAll();
                  }}
                  className="flex h-10 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sub font-medium text-text-primary transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50"
                >
                  <Zap className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                  Пинг всех
                </button>
              </div>
            )}
          </>
        }
      />

      <header className="nodes-header-inline hidden flex-row items-center justify-between gap-3">
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
            className="flex-none"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Обновить
          </Button>
          <Button variant="primary" className="flex-none" onClick={onPingAll} disabled={pinging}>
            <Zap className="h-4 w-4" aria-hidden="true" />
            Пинг всех
          </Button>
        </div>
      </header>
    </>
  );
}
