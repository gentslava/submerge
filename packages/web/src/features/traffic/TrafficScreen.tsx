import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, ArrowDown, ArrowUp, Cable, Database, ServerOff, WifiOff } from "lucide-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { useLiveState } from "@/features/live/LiveProvider";
import { formatBytes, formatRate, realNodes } from "@/features/nodes/nodeView";
import { pluralRu } from "@/lib/plural";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { connectionCountForMetric, type TrafficViewState, trafficViewState } from "./state";

export interface TrafficDashboardViewProps {
  state: TrafficViewState;
  downloadRate: number | null;
  uploadRate: number | null;
  connectionCount: number | null;
  sessionBytes: number | null;
  connectionsUnavailable: boolean;
  activeNode: string | null;
}

function useFreshnessClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function TrafficScreen() {
  const trpc = useTRPC();
  const { traffic, mihomo } = useLiveState();
  const snapshot = useSyncExternalStore(traffic.subscribe, traffic.getSnapshot);
  const nodesQuery = useQuery(trpc.nodes.list.queryOptions());
  // The next slice uses policy cadence in the latency chart. Mount it with the
  // route now so query ownership stays local to the screen from the start.
  useQuery(trpc.channels.get.queryOptions());
  const connectionsQuery = useQuery(
    trpc.connections.list.queryOptions(undefined, { refetchInterval: 1_500 }),
  );
  const now = useFreshnessClock();

  const latest = snapshot.samples.at(-1) ?? null;
  const view = nodesQuery.data;
  const activeNode = view ? (view.now === "AUTO" ? view.autoNow : view.now) : snapshot.latency.node;
  const connectionsUnavailable = connectionsQuery.isError;
  const connectionCount = connectionCountForMetric(
    connectionsQuery.data?.connections.length,
    connectionsUnavailable,
  );
  const state = trafficViewState({
    nodesResolved: nodesQuery.data !== undefined || nodesQuery.isError,
    realNodeCount: realNodes(view?.all ?? []).length,
    connectionCount,
    sample: latest,
    lastSampleAt: snapshot.lastSampleAt,
    mihomo,
    now,
  });

  return (
    <TrafficDashboardView
      state={state}
      downloadRate={latest?.down ?? null}
      uploadRate={latest?.up ?? null}
      connectionCount={connectionCount}
      sessionBytes={snapshot.sessionBytes}
      connectionsUnavailable={connectionsUnavailable}
      activeNode={activeNode}
    />
  );
}

export function TrafficDashboardView(props: TrafficDashboardViewProps) {
  return (
    <div className="responsive-page responsive-page--traffic page-content flex min-w-0 flex-col gap-[22px] px-4 pt-5 pb-8">
      <header className="traffic-header flex min-w-0 items-center justify-between gap-4">
        <div className="min-w-0 flex flex-col gap-[5px]">
          <h1 className="text-2xl font-semibold text-text-primary">Трафик</h1>
          <p className="text-sub text-text-secondary">Суммарный трафик всех каналов · mihomo</p>
        </div>
      </header>

      {props.state === "no-nodes" ? (
        <NoNodesState />
      ) : (
        <>
          <StateNotice state={props.state} />
          <section
            aria-label="Live-метрики трафика"
            aria-busy={props.state === "loading"}
            className={cn(
              "traffic-metrics grid min-w-0 grid-cols-2 gap-2",
              props.state === "reconnecting" && "opacity-60",
            )}
          >
            <MetricCard
              icon={<ArrowDown size={18} />}
              label="СКОРОСТЬ ↓"
              value={props.downloadRate === null ? "—" : formatRate(props.downloadRate)}
              accent
            />
            <MetricCard
              icon={<ArrowUp size={18} />}
              label="СКОРОСТЬ ↑"
              value={props.uploadRate === null ? "—" : formatRate(props.uploadRate)}
            />
            <Link
              to="/connections"
              aria-label={
                props.connectionCount === null
                  ? "Соединения недоступны — открыть экран Соединения"
                  : `${props.connectionCount} ${pluralRu(props.connectionCount, [
                      "соединение",
                      "соединения",
                      "соединений",
                    ])} — открыть экран Соединения`
              }
              className="min-w-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
            >
              <MetricCard
                icon={<Cable size={18} />}
                label="СОЕДИНЕНИЯ"
                value={props.connectionCount === null ? "—" : String(props.connectionCount)}
                {...(props.connectionsUnavailable ? { detail: "Соединения недоступны" } : {})}
                interactive
              />
            </Link>
            <MetricCard
              icon={<Database size={18} />}
              label="ЗА СЕССИЮ"
              value={props.sessionBytes === null ? "—" : formatBytes(props.sessionBytes)}
            />
          </section>
          <ChartPlaceholder state={props.state} activeNode={props.activeNode} />
        </>
      )}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  accent = false,
  interactive = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  accent?: boolean;
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        "traffic-metric flex h-full min-w-0 items-center gap-3.5 rounded-[10px] border border-border-subtle bg-surface p-3",
        interactive && "transition-colors hover:border-border-default hover:bg-hover",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "traffic-metric-icon hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-elevated text-text-secondary",
          accent && "bg-accent-bg text-accent-text",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold tracking-[0.035em] text-text-tertiary">
          {label}
        </span>
        <span className="truncate font-mono text-lg font-semibold text-text-primary">{value}</span>
        {detail ? <span className="text-fine text-timeout">{detail}</span> : null}
      </span>
    </div>
  );
}

function StateNotice({ state }: { state: TrafficViewState }) {
  if (state === "loading") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-elevated px-3 py-2.5 text-sub text-text-secondary">
        <Activity aria-hidden="true" size={16} className="shrink-0" />
        <span>Подключаем live-метрики</span>
      </div>
    );
  }
  if (state === "reconnecting") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-slow bg-slow-bg px-3 py-2.5 text-sub text-slow">
        <WifiOff aria-hidden="true" size={16} className="shrink-0" />
        <span>
          <strong className="font-medium">Переподключаемся к mihomo</strong>
          <span> · показываем последние данные</span>
        </span>
      </div>
    );
  }
  if (state === "idle") {
    return <p className="text-sub text-text-secondary">Прокси подключён, трафика нет</p>;
  }
  return null;
}

function ChartPlaceholder({
  state,
  activeNode,
}: {
  state: TrafficViewState;
  activeNode: string | null;
}) {
  return (
    <section className="overflow-hidden rounded-[10px] border border-border-subtle bg-surface">
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3.5">
        <span className="min-w-0 truncate text-caption font-semibold tracking-[0.04em] text-text-secondary">
          ЗАДЕРЖКА · ОСНОВНОЙ КАНАЛ
        </span>
        <span
          title={activeNode ?? undefined}
          className="min-w-0 max-w-[50%] truncate font-mono text-meta text-text-tertiary"
        >
          {activeNode ?? "—"}
        </span>
      </header>
      <div className="flex min-h-28 items-center justify-center px-4 py-6 text-center text-sub text-text-tertiary">
        {state === "loading"
          ? "Ожидаем первый snapshot"
          : state === "idle"
            ? "Трафик появится после первого запроса"
            : "История задержки загружена"}
      </div>
    </section>
  );
}

function NoNodesState() {
  return (
    <section className="flex min-h-[280px] flex-col items-center justify-center gap-2.5 rounded-[10px] border border-border-subtle bg-surface p-7 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-bg text-accent-text">
        <ServerOff aria-hidden="true" size={21} />
      </span>
      <h2 className="text-base font-semibold text-text-primary">Добавьте первый источник</h2>
      <p className="max-w-[340px] text-sub text-text-secondary">
        После загрузки узлов здесь появятся живые скорости, соединения и история задержки.
      </p>
      <Link
        to="/sources"
        className="mt-1 inline-flex h-9 items-center justify-center rounded-lg bg-accent px-[13px] text-sub font-semibold text-accent-fg transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border"
      >
        Перейти к источникам
      </Link>
    </section>
  );
}
