import type { ConnectionItem } from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Cable, Search, Unplug, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import {
  dotColors,
  formatRate,
  isPseudo,
  type LatencyClass,
  latencyClass,
} from "@/features/nodes/nodeView";
import { formatElapsed } from "@/lib/duration";
import { pluralRu } from "@/lib/plural";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { deriveSpeeds, type Rate, toMbps } from "./speed";

type Filter = "all" | "tcp" | "udp";
// Resolve a connection's outbound node (chains[0]) to how the Узлы screen shows it:
// the collapsed display name + live status. Falls back to the raw name with a neutral
// dot when the node isn't in the current view (unknown → honest, not green).
interface NodeInfo {
  display: string;
  lc: LatencyClass;
}
type NodeIndex = Map<string, { display: string; delay: number | null }>;
function resolveNode(index: NodeIndex, name: string): NodeInfo {
  if (!name) return { display: "—", lc: "idle" };
  const hit = index.get(name);
  return hit
    ? { display: hit.display, lc: latencyClass(hit.delay) }
    : { display: name, lc: "idle" };
}
const EMPTY: ConnectionItem[] = [];
const ZERO: Rate = { up: 0, down: 0 };

export function ConnectionsScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const { data, isPending, isError } = useQuery(
    trpc.connections.list.queryOptions(undefined, { refetchInterval: 1500 }),
  );
  const connections = data?.connections ?? EMPTY;
  // Only a first-load failure (no data yet) is a hard error — a transient poll
  // error after data keeps the last-known list on screen until the next tick.
  const showError = isError && data === undefined;

  // Node view (shared cache with the Узлы screen) → resolve each connection's node
  // to its display name + status. Members map to their collapsed group's name so a
  // deduped chain name ("nl-ams-01-2") shows as the clean node it belongs to.
  const nodesQuery = useQuery(trpc.nodes.list.queryOptions());
  const nodeIndex = useMemo<NodeIndex>(() => {
    const map: NodeIndex = new Map();
    for (const n of nodesQuery.data?.all ?? []) {
      if (isPseudo(n.name)) continue;
      map.set(n.name, { display: n.name, delay: n.delay });
      for (const m of n.members ?? []) map.set(m.name, { display: n.name, delay: m.delay });
    }
    return map;
  }, [nodesQuery.data]);

  // Per-connection speed: diff cumulative bytes against the previous poll (see speed.ts).
  const [rates, setRates] = useState<Map<string, Rate>>(() => new Map());
  const prevRef = useRef<{ bytes: Map<string, { up: number; down: number }>; t: number } | null>(
    null,
  );
  useEffect(() => {
    const now = Date.now();
    if (prevRef.current) {
      setRates(deriveSpeeds(prevRef.current.bytes, connections, now - prevRef.current.t));
    }
    prevRef.current = {
      bytes: new Map(connections.map((c) => [c.id, { up: c.up, down: c.down }])),
      t: now,
    };
  }, [connections]);

  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.connections.list.queryKey() });
  const closeMut = useMutation(
    trpc.connections.close.mutationOptions({
      onSuccess: () => void invalidate(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const closeAllMut = useMutation(
    trpc.connections.closeAll.mutationOptions({
      onSuccess: () => {
        void invalidate();
        toast.success("Все соединения разорваны");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const q = search.trim().toLowerCase();
  const filtered = connections.filter((c) => {
    if (filter !== "all" && c.network !== filter) return false;
    if (q && !`${c.source} ${c.host} ${c.destIp}`.toLowerCase().includes(q)) return false;
    return true;
  });

  // Summary reflects the whole active set (not the search/filter narrowing).
  const count = connections.length;
  let totalUp = 0;
  let totalDown = 0;
  for (const r of rates.values()) {
    totalUp += r.up;
    totalDown += r.down;
  }

  return (
    <div className="flex flex-col gap-5 px-4 pt-5 pb-8 md:px-8 md:pt-[26px]">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-[5px]">
          <h1 className="text-2xl font-semibold text-text-primary">Соединения</h1>
          <p className="text-sm text-text-secondary">
            {showError
              ? "Движок недоступен"
              : count > 0
                ? `${count} ${pluralRu(count, ["активное", "активных", "активных"])}`
                : "Нет активных соединений"}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-full items-center gap-2 rounded-lg border border-border-default bg-input px-3 md:w-60">
            <Search size={15} className="shrink-0 text-text-tertiary" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по домену"
              aria-label="Поиск по домену"
              className="min-w-0 flex-1 bg-transparent text-sub text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={count === 0 || closeAllMut.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            <Unplug size={15} />
            Разорвать все
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-[18px]">
          <SummaryChip
            icon={<ArrowDown size={15} className="text-online" />}
            text={formatRate(totalDown)}
          />
          <SummaryChip
            icon={<ArrowUp size={15} className="text-accent" />}
            text={formatRate(totalUp)}
          />
          <SummaryChip
            icon={<Cable size={15} className="text-text-tertiary" />}
            text={`${count} ${pluralRu(count, ["соединение", "соединения", "соединений"])}`}
          />
        </div>
        <Segmented
          options={[
            { value: "all", label: "Все" },
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
          ]}
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          aria-label="Фильтр по типу"
        />
      </div>

      <div className="overflow-x-auto rounded-[10px] border border-border-subtle bg-surface">
        <div className="min-w-[760px]">
          <ColumnsHeader />
          {isPending ? (
            <LoadingRows />
          ) : showError ? (
            <ErrorState />
          ) : filtered.length === 0 ? (
            <EmptyState hasAny={count > 0} />
          ) : (
            filtered.map((c) => (
              <ConnectionRow
                key={c.id}
                c={c}
                rate={rates.get(c.id) ?? ZERO}
                node={resolveNode(nodeIndex, c.node)}
                onClose={() => closeMut.mutate({ id: c.id })}
              />
            ))
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Разорвать все соединения?"
        description="Активные соединения будут закрыты. Клиенты переустановят их автоматически."
        confirmLabel="Разорвать все"
        onConfirm={() => {
          setConfirmOpen(false);
          closeAllMut.mutate();
        }}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function SummaryChip({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <span className="flex items-center gap-[7px] font-mono text-sub font-medium text-text-primary">
      {icon}
      {text}
    </span>
  );
}

const HEAD =
  "flex items-center gap-4 px-4 text-fine font-semibold uppercase tracking-[0.5px] text-text-tertiary";

function ColumnsHeader() {
  return (
    <div className={`${HEAD} border-b border-border-subtle bg-elevated py-[11px]`}>
      <span className="min-w-0 flex-1">Источник</span>
      <span className="min-w-0 flex-1">Назначение</span>
      <span className="w-[70px] shrink-0">Тип</span>
      <span className="w-[150px] shrink-0">Узел</span>
      <span className="w-[140px] shrink-0 text-right">Скорость, МБ/с</span>
      <span className="w-16 shrink-0 text-right">Время</span>
      <span className="w-11 shrink-0" />
    </div>
  );
}

function ConnectionRow({
  c,
  rate,
  node,
  onClose,
}: {
  c: ConnectionItem;
  rate: Rate;
  node: NodeInfo;
  onClose: () => void;
}) {
  const dest = c.port ? `${c.host}:${c.port}` : c.host;
  const showIp = c.destIp && c.destIp !== c.host;
  return (
    <div className="flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0">
      <div className="flex min-w-0 flex-1 items-center gap-[11px]">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-elevated font-mono text-sub font-semibold text-text-secondary">
          {initial(c.source)}
        </span>
        <span className="truncate text-sm font-medium text-text-primary">{c.source}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-sub font-medium text-text-primary">{dest}</span>
        {showIp && (
          <span className="truncate font-mono text-fine text-text-tertiary">{c.destIp}</span>
        )}
      </div>
      <span className="w-[70px] shrink-0 font-mono text-meta uppercase text-text-secondary">
        {c.network}
      </span>
      <div className="flex w-[150px] shrink-0 items-center gap-[7px]">
        <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", dotColors[node.lc])} />
        <span className="truncate font-mono text-sub text-text-primary">{node.display}</span>
      </div>
      <span className="w-[140px] shrink-0 text-right font-mono text-sub font-medium text-text-primary">
        ↓ {toMbps(rate.down)} ↑ {toMbps(rate.up)}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-sub text-text-tertiary">
        {formatElapsed(c.start)}
      </span>
      <div className="flex w-11 shrink-0 justify-center">
        <button
          type="button"
          onClick={onClose}
          aria-label="Разорвать соединение"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-hover hover:text-timeout"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0"
        >
          <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-lg" />
          <Skeleton className="h-4 min-w-0 flex-1" />
          <Skeleton className="h-4 min-w-0 flex-1" />
          <Skeleton className="h-4 w-[70px] shrink-0" />
          <Skeleton className="h-4 w-[150px] shrink-0" />
          <Skeleton className="h-4 w-[140px] shrink-0" />
          <Skeleton className="h-4 w-16 shrink-0" />
          <span className="w-11 shrink-0" />
        </div>
      ))}
    </>
  );
}

function EmptyState({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="px-4 py-12 text-center text-sm text-text-tertiary">
      {hasAny ? "Ничего не найдено" : "Нет активных соединений"}
    </div>
  );
}

function ErrorState() {
  return (
    <div className="px-4 py-12 text-center text-sm text-text-tertiary">
      Движок недоступен — не удалось получить соединения
    </div>
  );
}

function initial(source: string): string {
  const ch = source.trim().match(/[\p{L}\p{N}]/u);
  return ch ? ch[0].toUpperCase() : "?";
}
