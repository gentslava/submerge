import {
  type ChannelPolicy,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_SPEED_POLICY,
  type NodeItem,
  type Source,
} from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { useState } from "react";
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

export function NodesScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { latency, totals } = useLiveState();

  const nodesQuery = useQuery(trpc.nodes.list.queryOptions());
  const sourcesQuery = useQuery(trpc.sources.list.queryOptions());
  const channelQuery = useQuery(trpc.channels.get.queryOptions());

  // The Default channel's policy (Settings → Авто-выбор узла) — drives the strategy
  // card's params and the active-node chart's check cadence. `manual` has no probe
  // interval of its own, so the chart uses the engine default for its check cadence.
  const policy: ChannelPolicy = channelQuery.data?.policy ?? DEFAULT_SPEED_POLICY;
  const chartCheckIntervalSec =
    policy.kind === "manual" ? DEFAULT_AUTO_TEST_INTERVAL : Math.max(1, policy.intervalSec);
  // Honest header copy: unlike the chart cadence above, the header must not imply a
  // periodic check exists when the policy is `manual` (or the channel hasn't loaded
  // yet) — omit the interval entirely instead of showing a substitute value.
  const rawPolicy = channelQuery.data?.policy;
  const headerCheckIntervalSec =
    rawPolicy && "intervalSec" in rawPolicy ? rawPolicy.intervalSec : null;

  // Per-node "being pinged" set — drives the progressive loaders in each row.
  const [pingingNames, setPingingNames] = useState<Set<string>>(() => new Set());

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

  // Optimistically write a node's measured delay into the cached view so the value
  // appears the instant its ping returns (the SSE poll later reconciles).
  const patchDelay = (name: string, value: number | null) => {
    qc.setQueryData(trpc.nodes.list.queryKey(), (old) =>
      old
        ? { ...old, all: old.all.map((n) => (n.name === name ? { ...n, delay: value } : n)) }
        : old,
    );
  };

  const markPinging = (name: string, on: boolean) =>
    setPingingNames((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const pingOne = async (name: string) => {
    markPinging(name, true);
    try {
      patchDelay(name, await delay.mutateAsync({ name }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось пропинговать узел");
    } finally {
      markPinging(name, false);
    }
  };

  const pingAll = async () => {
    const real = (nodesQuery.data?.all ?? []).filter((n) => !isPseudo(n.name));
    if (real.length === 0) return;
    // Show a loader on every node up front, then fill each value as its ping returns
    // — so a large fleet visibly progresses instead of freezing then updating at once.
    setPingingNames(new Set(real.map((n) => n.name)));
    await Promise.allSettled(
      real.map(async (n) => {
        try {
          patchDelay(n.name, await delay.mutateAsync({ name: n.name }));
        } finally {
          markPinging(n.name, false);
        }
      }),
    );
    toast.success(`Пропинговано узлов: ${real.length}`);
  };

  const data = nodesQuery.data;
  const all = data?.all ?? [];
  const now = data?.now ?? null;
  const autoNow = data?.autoNow ?? null;
  const isAuto = now === "AUTO";
  const realCount = all.filter((n) => !isPseudo(n.name)).length;

  const onAuto = () => select.mutate({ group: "PROXY", name: "AUTO" });
  // Switching Авто → Ручной pins the node AUTO currently routes through.
  const onManual = () => {
    if (autoNow) select.mutate({ group: "PROXY", name: autoNow });
  };

  return (
    <div className="flex flex-col gap-[22px] px-4 pt-5 pb-8 md:px-8 md:pt-[26px]">
      <NodesHeader
        nodeCount={realCount}
        checkIntervalSec={headerCheckIntervalSec}
        refreshing={nodesQuery.isFetching}
        pinging={pingingNames.size > 0}
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
          autoNow={autoNow}
          isAuto={isAuto}
          policy={policy}
          checkIntervalSec={chartCheckIntervalSec}
          all={all}
          sources={sourcesQuery.data ?? []}
          totals={totals}
          latency={latency}
          pingingNames={pingingNames}
          selectPending={select.isPending}
          onSelect={(name) => select.mutate({ group: "PROXY", name })}
          onPing={pingOne}
          onAuto={onAuto}
          onManual={onManual}
          lastDecision={{
            reason: channelQuery.data?.lastReason ?? "",
            at: channelQuery.data?.lastReasonAt ?? null,
          }}
        />
      )}
    </div>
  );
}

function Body({
  now,
  autoNow,
  isAuto,
  policy,
  checkIntervalSec,
  all,
  sources,
  totals,
  latency,
  pingingNames,
  selectPending,
  onSelect,
  onPing,
  onAuto,
  onManual,
  lastDecision,
}: {
  now: string | null;
  autoNow: string | null;
  isAuto: boolean;
  policy: ChannelPolicy;
  checkIntervalSec: number;
  all: NodeItem[];
  sources: Source[];
  totals: ReturnType<typeof useLiveState>["totals"];
  latency: ReturnType<typeof useLiveState>["latency"];
  pingingNames: Set<string>;
  selectPending: boolean;
  onSelect: (name: string) => void;
  onPing: (name: string) => void;
  onAuto: () => void;
  onManual: () => void;
  lastDecision: { reason: string; at: number | null };
}) {
  return (
    <>
      <AutoStrategyCard
        policy={policy}
        isAuto={isAuto}
        autoNow={autoNow}
        now={now}
        onAuto={onAuto}
        onManual={onManual}
        pending={selectPending}
        lastDecision={lastDecision}
      />

      <ActiveNodeCard
        now={now}
        autoNow={autoNow}
        all={all}
        totals={totals}
        latency={latency}
        checkInterval={checkIntervalSec}
      />

      <div className="flex items-center justify-between px-0.5 pt-1">
        <h2 className="text-cardtitle text-text-primary">Все узлы</h2>
        <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          сгруппировано по подпискам
        </span>
      </div>

      <NodeList
        now={now}
        all={all}
        sources={sources}
        pingingNames={pingingNames}
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
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Повторить
      </Button>
    </div>
  );
}
