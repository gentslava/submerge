import type { NodeItem, Source } from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveState } from "@/features/live/LiveProvider";
import { useTRPC } from "@/lib/trpc";
import { ActiveNodeCard } from "./ActiveNodeCard";
import { AutoStrategyCard } from "./AutoStrategyCard";
import { NodeList } from "./NodeList";
import { NodesHeader } from "./NodesHeader";
import { isPseudo } from "./nodeView";

const HISTORY_CAP = 40;
const POLL_INTERVAL = 300; // url-test group interval (s), see server nodes/config.ts

export function NodesScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { traffic } = useLiveState();

  const nodesQuery = useQuery(trpc.nodes.list.queryOptions());
  const sourcesQuery = useQuery(trpc.sources.list.queryOptions());

  const [pingingName, setPingingName] = useState<string | null>(null);

  const select = useMutation(
    trpc.nodes.select.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.nodes.list.queryKey() });
        toast.success("Узел выбран");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const delay = useMutation(trpc.nodes.delay.mutationOptions());

  const pingOne = async (name: string) => {
    setPingingName(name);
    try {
      await delay.mutateAsync({ name });
      void qc.invalidateQueries({ queryKey: trpc.nodes.list.queryKey() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось пропинговать узел");
    } finally {
      setPingingName(null);
    }
  };

  const pingAll = async () => {
    const all = nodesQuery.data?.all ?? [];
    const real = all.filter((n) => !isPseudo(n.name));
    if (real.length === 0) return;
    try {
      await Promise.allSettled(real.map((n) => delay.mutateAsync({ name: n.name })));
      void qc.invalidateQueries({ queryKey: trpc.nodes.list.queryKey() });
      toast.success(`Пропинговано узлов: ${real.length}`);
    } catch {
      toast.error("Не удалось пропинговать узлы");
    }
  };

  const all = nodesQuery.data?.all ?? [];
  const now = nodesQuery.data?.now ?? null;
  const realCount = all.filter((n) => !isPseudo(n.name)).length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-[22px] px-8 pt-6 pb-8">
      <NodesHeader
        nodeCount={realCount}
        pollInterval={POLL_INTERVAL}
        refreshing={nodesQuery.isFetching}
        pinging={delay.isPending && pingingName === null}
        onRefresh={() => nodesQuery.refetch()}
        onPingAll={pingAll}
      />

      {nodesQuery.isLoading ? (
        <LoadingState />
      ) : nodesQuery.isError ? (
        <ErrorState onRetry={() => nodesQuery.refetch()} />
      ) : (
        <Body
          now={now}
          all={all}
          sources={sourcesQuery.data ?? []}
          traffic={traffic}
          pingingName={pingingName}
          onSelect={(name) => select.mutate({ group: "PROXY", name })}
          onPing={pingOne}
        />
      )}
    </div>
  );
}

function Body({
  now,
  all,
  sources,
  traffic,
  pingingName,
  onSelect,
  onPing,
}: {
  now: string | null;
  all: NodeItem[];
  sources: Source[];
  traffic: ReturnType<typeof useLiveState>["traffic"];
  pingingName: string | null;
  onSelect: (name: string) => void;
  onPing: (name: string) => void;
}) {
  // Accumulate the active node's latency history across SSE-patched updates.
  // Mutating the ref during render is safe here: it never triggers a re-render
  // (no setState), it only records the latest delay so the next render can read
  // an up-to-date series. The cache patch from the live stream drives re-renders.
  const histRef = useRef<Record<string, number[]>>({});
  if (now != null) {
    const active = all.find((n) => n.name === now);
    const d = active?.delay ?? null;
    if (d != null && d > 0) {
      const series = histRef.current[now] ?? [];
      histRef.current[now] = series;
      if (series[series.length - 1] !== d) {
        series.push(d);
        if (series.length > HISTORY_CAP) series.splice(0, series.length - HISTORY_CAP);
      }
    }
  }

  return (
    <>
      <AutoStrategyCard pollInterval={POLL_INTERVAL} />

      <ActiveNodeCard
        now={now}
        all={all}
        history={now != null ? (histRef.current[now] ?? []) : []}
        traffic={traffic}
      />

      <div className="flex items-center justify-between px-0.5 pt-1">
        <h2 className="text-[15px] font-semibold text-text-primary">Все узлы</h2>
        <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          сгруппировано по подпискам
        </span>
      </div>

      <NodeList
        now={now}
        all={all}
        sources={sources}
        pingingName={pingingName}
        onSelect={onSelect}
        onPing={onPing}
      />
    </>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-[22px]">
      <Skeleton className="h-[120px] w-full rounded-lg" />
      <Skeleton className="h-[180px] w-full rounded-xl" />
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border-subtle">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[58px] w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry(): void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface p-10 text-center text-text-secondary">
      <span>Не удалось получить узлы от mihomo.</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Повторить
      </Button>
    </div>
  );
}
