import { useQuery } from "@tanstack/react-query";
import { Copy, RotateCw } from "lucide-react";
import { useLiveState } from "@/features/live/LiveProvider";
import { liveIndicator } from "@/features/live/status";
import { useActiveNode } from "@/features/nodes/useActiveNode";
import { useReloadCore } from "@/features/settings/useReloadCore";
import { copyToClipboard } from "@/lib/clipboard";
import { PROXY_ENDPOINT } from "@/lib/constants";
import { useTRPC } from "@/lib/trpc";

export function ProxyStatusCard({ showReload = true }: { showReload?: boolean }) {
  const { mihomo } = useLiveState();
  const activeNode = useActiveNode();
  const trpc = useTRPC();
  const { data } = useQuery(trpc.settings.get.queryOptions());
  const reload = useReloadCore();
  const proxy = data?.proxyEndpoint ?? PROXY_ENDPOINT;
  const status = liveIndicator(mihomo, { idle: "Проверка", ok: "Подключено", down: "Отключено" });

  return (
    <div className="flex flex-col gap-[9px] rounded-lg border border-border-subtle bg-elevated p-[13px]">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`} />
        <span className="text-meta text-text-secondary">{status.label}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-sub font-medium text-text-primary">
          {proxy}
        </span>
        <button
          type="button"
          onClick={() => void copyToClipboard(proxy)}
          aria-label="Скопировать адрес"
          className="shrink-0 text-text-tertiary transition-colors hover:text-text-secondary"
        >
          <Copy size={13} aria-hidden="true" />
        </button>
      </div>
      <span className="truncate font-mono text-fine text-text-tertiary">
        Активный узел · {activeNode ?? "—"}
      </span>
      {showReload && (
        <button
          type="button"
          onClick={() => reload.mutate()}
          disabled={reload.isPending}
          className="mt-0.5 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border-default bg-hover text-meta text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RotateCw size={14} className={reload.isPending ? "animate-spin" : undefined} />
          Перезагрузить конфиг
        </button>
      )}
    </div>
  );
}
